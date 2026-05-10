"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import type { PeopleRow, PersonDetailResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { cleanContactSummary } from "@/lib/preview";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/common/person-avatar";
import { ProfileSections } from "@/components/common/profile-sections";

// People — relationship rows in the same calm pattern as ThreadRow. Click
// any row to open a slim detail panel below with summary + enrichment +
// starters. When the runner has no LinkedIn profile URL for the person
// yet (the scan only captures display name + thread URL), surface that
// explicitly with a paste-URL input instead of looping on a "Refresh
// enrichment" button that always 502s with `reason: "not_found"`.
export default function PeoplePage() {
  const router = useRouter();
  const [people, setPeople] = useState<PeopleRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonDetailResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Inline status next to the Refresh enrichment button — every action
  // surfaces what it's doing while it runs and briefly after, not just a
  // button-label flip. Auto-clears on success/deferred after ~4s; errors
  // still route through the page-level `error` banner.
  const [enrichStatus, setEnrichStatus] = useState<string | null>(null);
  const enrichStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scanningAll, setScanningAll] = useState<"all" | "new" | null>(null);
  const [scanAllStatus, setScanAllStatus] = useState<string | null>(null);
  const [startersLoading, setStartersLoading] = useState(false);
  const [profileUrlInput, setProfileUrlInput] = useState("");
  const [savingProfileUrl, setSavingProfileUrl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Local draft so the textarea is fully controlled. The Notes column on
  // people lives off the API, but keystrokes go to local state and we
  // debounce a PATCH-equivalent POST to /runner/control/person/:id/notes.
  const [notesDraft, setNotesDraft] = useState<string>("");
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const notesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedNotesAtRef = useRef<number>(0);

  // Load list with explicit error surfacing (#74 pattern). Stays a
  // useCallback so dependencies in effects below don't churn between renders.
  const loadList = useCallback(async (): Promise<PeopleRow[]> => {
    try {
      const data = await apiGet<PeopleRow[]>("/runner/data/people");
      setPeople(data);
      setError(null);
      return data;
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load people";
      setError(message);
      return [];
    }
  }, []);

  const loadDetail = useCallback(
    async (personId: string, includeStarters = false) => {
      const data = await apiGet<PersonDetailResponse>(
        `/runner/data/person/${personId}${includeStarters ? "?includeStarters=1" : ""}`
      ).catch(() => null);
      setDetail(data);
    },
    []
  );

  // No auto-select on load: the inline accordion makes the list itself
  // the entry point. Auto-expanding the first row used to be required
  // because the detail card lived at the bottom of the page; with rows
  // expanding inline a default-open also fights the toggle-collapse
  // (clicking the active row would collapse → effect re-fires → first
  // row re-selects).
  // Poll + resync subscription so new persons persisted by an in-flight
  // scan show up without a manual reload. Mirrors the pattern used on the
  // inbox / today pages — without it, /data/people only loaded once on
  // mount and operators saw a stale list while a scan was running.
  useEffect(() => {
    void loadList();
    const onResync = () => void loadList();
    window.addEventListener("runner-resync", onResync);
    const timer = setInterval(() => void loadList(), 10000);
    return () => {
      window.removeEventListener("runner-resync", onResync);
      clearInterval(timer);
    };
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // Reset the per-person input whenever the selection changes so a stale
  // profile URL from the previous person doesn't stick around.
  useEffect(() => {
    setProfileUrlInput("");
    setError(null);
  }, [selectedId]);

  const selected = useMemo(
    () => people.find((person) => person.id === selectedId) ?? null,
    [people, selectedId]
  );

  // Whenever the selected person changes, hydrate the notes draft from the
  // server-side value. Cancel any in-flight debounce so we don't write the
  // previous person's notes onto the new one.
  useEffect(() => {
    if (notesSaveTimer.current) {
      clearTimeout(notesSaveTimer.current);
      notesSaveTimer.current = null;
    }
    setNotesDraft(selected?.notes ?? "");
    setNotesStatus("idle");
  }, [selectedId, selected?.notes]);

  // Tear down the timer if the page unmounts mid-debounce.
  useEffect(() => () => {
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    if (enrichStatusTimer.current) clearTimeout(enrichStatusTimer.current);
  }, []);

  // Switching person mid-flight: drop the previous enrich status — it
  // described the previous selection and would mis-attribute "saved" to
  // a person who wasn't actually refreshed.
  useEffect(() => {
    if (enrichStatusTimer.current) {
      clearTimeout(enrichStatusTimer.current);
      enrichStatusTimer.current = null;
    }
    setEnrichStatus(null);
  }, [selectedId]);

  const onNotesChange = useCallback((value: string): void => {
    setNotesDraft(value);
    setNotesStatus("saving");
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    const personId = selectedId;
    if (!personId) return;
    notesSaveTimer.current = setTimeout(async () => {
      try {
        await apiPost(`/runner/control/person/${personId}/notes`, { notes: value });
        savedNotesAtRef.current = Date.now();
        setNotesStatus("saved");
        // Refresh the people list so the next selectedId switch sees the
        // updated notes value (selected.notes is sourced from people, not
        // detail).
        void loadList();
      } catch {
        setNotesStatus("error");
      }
    }, 600);
  }, [selectedId, loadList]);

  const refreshEnrichment = useCallback(() => {
    if (!selectedId) return;
    setRefreshing(true);
    setError(null);
    setEnrichStatus(detail?.person.platform === "LINKEDIN" ? "Fetching LinkedIn profile…" : "Fetching profile…");
    if (enrichStatusTimer.current) {
      clearTimeout(enrichStatusTimer.current);
      enrichStatusTimer.current = null;
    }
    apiPost<{ status: "ok" | "deferred" | "queued"; reason?: string }>(
      `/runner/control/person/${selectedId}/enrich?wait=1`,
      {}
    )
      .then(async (result) => {
        setEnrichStatus(
          result.status === "deferred"
            ? "Runner is busy — queued for next slot."
            : "Profile refreshed."
        );
        enrichStatusTimer.current = setTimeout(() => setEnrichStatus(null), 4000);
        await loadList();
        if (selectedId) await loadDetail(selectedId);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn("[action]", message);
        setError(message);
        setEnrichStatus(null);
      })
      .finally(() => setRefreshing(false));
  }, [selectedId, loadList, loadDetail]);

  const saveProfileUrlAndEnrich = async () => {
    if (!selectedId) return;
    const url = profileUrlInput.trim();
    if (!url) return;
    setSavingProfileUrl(true);
    setError(null);
    try {
      await apiPost(`/runner/control/person/${selectedId}/profile-url`, { profileUrl: url });
      setProfileUrlInput("");
      await loadDetail(selectedId);
      // Kick enrichment immediately so the operator sees results without
      // an extra click.
      refreshEnrichment();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile URL");
    } finally {
      setSavingProfileUrl(false);
    }
  };

  const scanAll = useCallback(async (scope: "all" | "new") => {
    setScanningAll(scope);
    setScanAllStatus(null);
    setError(null);
    try {
      const result = await apiPost<{ status: string; count: number }>(
        "/runner/control/people/scan-all",
        { scope }
      );
      const noun = scope === "new" ? "unenriched profile" : "profile";
      setScanAllStatus(
        `Queued ${result.count} ${noun}${result.count === 1 ? "" : "s"} for ${scope === "new" ? "scan" : "rescan"}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enqueue scan-all");
    } finally {
      setScanningAll(null);
    }
  }, []);

  const fetchStarters = () => {
    if (!selectedId) return;
    setStartersLoading(true);
    void loadDetail(selectedId, true).finally(() => setStartersLoading(false));
  };

  // Without a profileUrl on the Person row the runner's enrichment job
  // has nothing to visit, so "Refresh enrichment" silently fails every
  // time. Detect the missing-URL case directly and ask the operator to
  // paste one instead of showing "Not enriched yet" forever.
  const profileUrlMissing = !!detail && !detail.person.profileUrl;

  return (
    <Canvas>
      <PageHead
        eyebrow="Relationships"
        title="People"
        subtitle="Lightweight relationship context across every conversation — risk, last touch, notes."
        meta={people.length > 0 ? <span>{people.length} relationships</span> : null}
      />

      {people.length > 0 ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button
            variant="quiet"
            disabled={scanningAll !== null}
            onClick={() => void scanAll("new")}
          >
            {scanningAll === "new" ? "Queueing…" : "Scan new"}
          </Button>
          <Button
            variant="quiet"
            disabled={scanningAll !== null}
            onClick={() => void scanAll("all")}
          >
            {scanningAll === "all" ? "Queueing…" : "Rescan all"}
          </Button>
          {scanAllStatus ? (
            <span className="font-mono text-[11px] text-ink-3">{scanAllStatus}</span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {people.length === 0 ? (
        <CaughtUp title="No relationships yet." body="Connect a platform to start mapping people." />
      ) : (
        <div className="flex flex-col">
          {people.map((person) => {
            const risk = toDisplayRisk(person.risk);
            const dot =
              risk === "overdue"
                ? "bg-risk-overdue"
                : risk === "waiting"
                  ? "bg-risk-waiting"
                  : "bg-risk-fresh";
            const active = person.id === selectedId;
            const headlineLine =
              person.headline ??
              [person.currentRole, person.currentCompany].filter(Boolean).join(" at ") ??
              "no profile yet";
            const detailId = `person-detail-${person.id}`;
            // Inline accordion: clicking a row expands the detail panel
            // directly underneath it, FAQ-style. Clicking the active row
            // again collapses. Earlier shipping put a single detail card
            // at the bottom of the list which the operator had to scroll
            // to find — issue #100 called this out specifically.
            return (
              <div
                key={person.id}
                className="border-t border-hairline last:border-b last:border-hairline"
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(active ? null : person.id)}
                  aria-expanded={active}
                  aria-controls={detailId}
                  className={`grid w-full grid-cols-[32px_1fr_auto] items-center gap-4 px-1 py-[18px] text-left transition-colors duration-calm hover:bg-paper-2 ${
                    active ? "bg-paper-2" : ""
                  }`}
                >
                  <PersonAvatar
                    name={person.name}
                    avatarUrl={person.avatarUrl}
                    size={32}
                    className="text-[12px]"
                  />
                  <span className="min-w-0">
                    <span className="mb-1 flex items-baseline gap-[10px]">
                      <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">
                        {person.name}
                      </span>
                      <span className="rounded bg-paper-2 px-[6px] py-[1px] text-[10px] font-medium uppercase tracking-[0.04em] text-ink-2">
                        {PLATFORM_LABEL[person.platform]}
                      </span>
                    </span>
                    <span className="block max-w-[52ch] truncate text-[14px] text-ink-2">
                      {headlineLine}
                    </span>
                  </span>
                  <span
                    className={`text-[12px] ${
                      risk === "overdue"
                        ? "font-medium text-risk-overdue"
                        : risk === "waiting"
                          ? "font-medium text-risk-waiting"
                          : "text-ink-2"
                    }`}
                  >
                    {person.lastInteractionAt
                      ? formatRelative(person.lastInteractionAt)
                      : "no contact yet"}
                  </span>
                </button>

                {active ? (
                  <section
                    id={detailId}
                    data-testid="person-detail-panel"
                    className="animate-accordion-down border-t border-hairline bg-paper-2/40 px-1 pb-8 pt-6 sm:px-6"
                  >
                    <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                      {PLATFORM_LABEL[person.platform]} · last contact{" "}
                      {formatRelative(person.lastInteractionAt)}
                    </p>

                    <p className="max-w-[58ch] text-[15px] leading-[1.55] text-ink-2">
                      {cleanContactSummary(detail?.summary) ??
                        (detail?.enrichment
                          ? "No summary yet. Refresh to generate one."
                          : profileUrlMissing
                            ? "We don't have a LinkedIn profile URL for this person yet. Paste it below to enrich."
                            : "Not enriched yet. Refresh to fetch the LinkedIn profile.")}
                    </p>

                    {profileUrlMissing ? (
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <input
                          type="url"
                          value={profileUrlInput}
                          onChange={(event) => setProfileUrlInput(event.target.value)}
                          placeholder="https://www.linkedin.com/in/…"
                          className="w-[360px] max-w-full rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
                        />
                        <Button
                          variant="quiet"
                          disabled={!profileUrlInput.trim() || savingProfileUrl || refreshing}
                          onClick={() => void saveProfileUrlAndEnrich()}
                        >
                          {savingProfileUrl || refreshing ? "Saving…" : "Save & enrich"}
                        </Button>
                      </div>
                    ) : null}

                    {detail ? (
                      <div className="mt-6">
                        <ProfileSections detail={detail} hideName />
                      </div>
                    ) : null}

                    {detail?.starters && detail.starters.starters.length > 0 ? (
                      <div className="mt-6 border-t border-hairline pt-5">
                        <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                          Suggested openers
                        </p>
                        <div className="space-y-3">
                          {detail.starters.starters.map((starter, idx) => (
                            <div key={idx} className="rounded-row border border-hairline p-4 text-[14px]">
                              <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                                {starter.angle} · cited {starter.citedField}
                              </p>
                              <p className="text-ink">{starter.text}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    <div className="mt-6 rounded-card border border-hairline bg-paper px-4 py-3">
                      <div className="flex items-center justify-between">
                        <p className="m-0 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                          Notes
                        </p>
                        <span className="font-mono text-[11px] text-ink-3" aria-live="polite">
                          {notesStatus === "saving"
                            ? "saving…"
                            : notesStatus === "saved"
                              ? "saved"
                              : notesStatus === "error"
                                ? <span className="text-risk-overdue">failed to save</span>
                                : ""}
                        </span>
                      </div>
                      <textarea
                        rows={6}
                        value={notesDraft}
                        onChange={(event) => onNotesChange(event.target.value)}
                        placeholder="Internal relationship notes..."
                        className="mt-2 w-full resize-none border-0 bg-transparent text-[14px] leading-[1.5] text-ink outline-none placeholder:text-ink-4"
                      />
                    </div>

                    <div className="mt-6 flex flex-wrap items-center gap-3">
                      <Button variant="quiet" disabled={refreshing} onClick={refreshEnrichment}>
                        {refreshing ? "Refreshing…" : "Refresh enrichment"}
                      </Button>
                      {enrichStatus ? (
                        <span
                          className="font-mono text-[11px] text-ink-3"
                          aria-live="polite"
                        >
                          {enrichStatus}
                        </span>
                      ) : null}
                      <Button
                        variant="quiet"
                        disabled={!detail?.enrichment || startersLoading}
                        onClick={fetchStarters}
                      >
                        {startersLoading ? "Drafting…" : "Start a conversation"}
                      </Button>
                      <button
                        type="button"
                        onClick={() => router.push(`/inbox?person=${person.id}`)}
                        className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
                      >
                        open in inbox
                      </button>
                    </div>
                  </section>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Canvas>
  );
}
