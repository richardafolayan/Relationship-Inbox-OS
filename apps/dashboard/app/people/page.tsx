"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/api";
import type { PeopleRow, PersonDetailResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { PLATFORM_LABEL, toDisplayRisk, type DisplayRisk } from "@/lib/risk";
import { cleanContactSummary } from "@/lib/preview";
import { personHeadlineLine } from "@/lib/people-headline";
import { shouldAdoptIncomingNotes } from "@/lib/notes-sync";
import { createLatestRequestGate } from "@/lib/latest-request";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/common/person-avatar";

// People - list of relationship rows. Clicking a row expands an inline
// two-column profile beneath it: a sticky `id-card` (avatar + name + role
// + last contact + facts + primary actions) on the left, and a `ctx`
// column on the right that carries about / mutual chips / opener grid /
// notes. Mirrors section 01 of the redesign doc.
export default function PeoplePage() {
  const router = useRouter();
  const [people, setPeople] = useState<PeopleRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonDetailResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [enrichStatus, setEnrichStatus] = useState<string | null>(null);
  const enrichStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scanningAll, setScanningAll] = useState<"all" | "new" | null>(null);
  const [scanAllStatus, setScanAllStatus] = useState<string | null>(null);
  const [startersLoading, setStartersLoading] = useState(false);
  const [profileUrlInput, setProfileUrlInput] = useState("");
  const [savingProfileUrl, setSavingProfileUrl] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<string>("");
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const notesSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedNotesAtRef = useRef<number>(0);
  // Which person the current notes draft belongs to, and the server value it
  // was last synced from. Used to decide whether a background refresh may
  // overwrite the textarea (only when the user isn't mid-edit).
  const notesPersonRef = useRef<string | null>(null);
  const syncedNotesRef = useRef<string>("");
  // Latest-wins gate: only the most recent detail fetch may write to state,
  // so fast person switching can't show an older response over a newer one.
  const detailReqGate = useRef(createLatestRequestGate());

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
      const token = detailReqGate.current.next();
      const data = await apiGet<PersonDetailResponse>(
        `/runner/data/person/${personId}${includeStarters ? "?includeStarters=1" : ""}`
      ).catch(() => null);
      // A newer request started while this one was in flight - drop the stale
      // response so it can't overwrite the current selection's detail.
      if (!detailReqGate.current.isLatest(token)) return;
      setDetail(data);
    },
    []
  );

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
    // Clear immediately on every selection change (not just deselection) so a
    // stale prior detail can't show during the new fetch's in-flight window.
    setDetail(null);
    if (!selectedId) return;
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    setProfileUrlInput("");
    setError(null);
  }, [selectedId]);

  const selected = useMemo(
    () => people.find((person) => person.id === selectedId) ?? null,
    [people, selectedId]
  );

  useEffect(() => {
    const incoming = selected?.notes ?? "";
    const personChanged = notesPersonRef.current !== selectedId;
    // The draft is dirty (has unsaved keystrokes) when it no longer matches the
    // server value we last synced into it. Reading notesDraft via the previous
    // render's value is fine here because we only ever overwrite on adopt.
    const draftIsDirty = notesDraft !== syncedNotesRef.current;
    if (!shouldAdoptIncomingNotes({ personChanged, draftIsDirty })) {
      // Same person, mid-edit: keep the user's keystrokes; just remember the
      // latest server value so a later clean state can re-sync to it.
      syncedNotesRef.current = incoming;
      return;
    }
    if (notesSaveTimer.current) {
      clearTimeout(notesSaveTimer.current);
      notesSaveTimer.current = null;
    }
    notesPersonRef.current = selectedId;
    syncedNotesRef.current = incoming;
    setNotesDraft(incoming);
    setNotesStatus("idle");
  }, [selectedId, selected?.notes, notesDraft]);

  useEffect(() => () => {
    if (notesSaveTimer.current) clearTimeout(notesSaveTimer.current);
    if (enrichStatusTimer.current) clearTimeout(enrichStatusTimer.current);
  }, []);

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
            ? "Runner is busy - queued for next slot."
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
  }, [selectedId, loadList, loadDetail, detail?.person.platform]);

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

  const profileUrlMissing = !!detail && !detail.person.profileUrl;

  return (
    <Canvas>
      <PageHead
        eyebrow="Relationships · People"
        title="People"
        meta={people.length > 0 ? <span>{people.length} relationships</span> : null}
      />

      {people.length > 0 ? (
        <div className="mb-3 flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mb-4 sm:flex-wrap sm:gap-3">
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
        <p className="mb-6 rounded-row border border-hairline bg-paper-2 px-4 py-3 text-[12px] leading-[1.5] text-ink-2">{error}</p>
      ) : null}

      {people.length === 0 ? (
        <CaughtUp title="No relationships yet." body="Connect a platform to start mapping people." />
      ) : (
        <div className="flex flex-col">
          {people.map((person) => {
            const risk = toDisplayRisk(person.risk);
            const active = person.id === selectedId;
            const headlineLine = personHeadlineLine(person);
            const detailId = `person-detail-${person.id}`;
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
                  className={`relative grid min-h-[76px] w-full grid-cols-[32px_minmax(0,1fr)] items-center gap-3 px-1 py-4 text-left transition-colors duration-calm hover:bg-paper-2 sm:grid-cols-[32px_1fr_auto] sm:gap-4 sm:py-[18px] ${
                    active ? "bg-paper-2" : ""
                  }`}
                >
                  <PersonAvatar
                    name={person.name}
                    avatarUrl={person.avatarUrl}
                    size={32}
                    className="text-[12px]"
                  />
                  <span className="min-w-0 pr-[76px] sm:pr-0">
                    <span className="mb-1 flex min-w-0 items-center gap-[8px]">
                      <span className="min-w-0 truncate text-[15px] font-medium tracking-[-0.01em] text-ink">
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
                    className={`absolute right-1 top-[18px] text-[11px] sm:static sm:text-[12px] ${
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

                {active && selected ? (
                  <ProfilePanel
                    detailId={detailId}
                    person={selected}
                    risk={risk}
                    detail={detail}
                    refreshing={refreshing}
                    enrichStatus={enrichStatus}
                    profileUrlMissing={profileUrlMissing}
                    profileUrlInput={profileUrlInput}
                    onProfileUrlInputChange={setProfileUrlInput}
                    onSaveProfileUrl={() => void saveProfileUrlAndEnrich()}
                    savingProfileUrl={savingProfileUrl}
                    onRefreshEnrichment={refreshEnrichment}
                    onStartConversation={fetchStarters}
                    startersLoading={startersLoading}
                    onOpenInInbox={() => router.push(`/inbox?person=${person.id}`)}
                    notesDraft={notesDraft}
                    onNotesChange={onNotesChange}
                    notesStatus={notesStatus}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Canvas>
  );
}

interface ProfilePanelProps {
  detailId: string;
  person: PeopleRow;
  risk: DisplayRisk;
  detail: PersonDetailResponse | null;
  refreshing: boolean;
  enrichStatus: string | null;
  profileUrlMissing: boolean;
  profileUrlInput: string;
  onProfileUrlInputChange: (value: string) => void;
  onSaveProfileUrl: () => void;
  savingProfileUrl: boolean;
  onRefreshEnrichment: () => void;
  onStartConversation: () => void;
  startersLoading: boolean;
  onOpenInInbox: () => void;
  notesDraft: string;
  onNotesChange: (value: string) => void;
  notesStatus: "idle" | "saving" | "saved" | "error";
}

// Two-column profile: left is sticky id-card, right is context blocks.
// Mirrors section 01 of the redesign doc - "left = who, right = context".
function ProfilePanel({
  detailId,
  person,
  risk,
  detail,
  refreshing,
  enrichStatus,
  profileUrlMissing,
  profileUrlInput,
  onProfileUrlInputChange,
  onSaveProfileUrl,
  savingProfileUrl,
  onRefreshEnrichment,
  onStartConversation,
  startersLoading,
  onOpenInInbox,
  notesDraft,
  onNotesChange,
  notesStatus
}: ProfilePanelProps) {
  const headline = detail?.enrichment?.headline ?? person.headline ?? null;
  const subtitleLine =
    [detail?.enrichment?.currentRole ?? person.currentRole, detail?.enrichment?.currentCompany ?? person.currentCompany]
      .filter(Boolean)
      .join(" at ") || null;
  const location = detail?.enrichment?.location ?? person.location ?? null;
  const mutualCount = detail?.enrichment?.mutualCount ?? null;
  const mutualNames = detail?.enrichment?.mutualNames ?? [];
  const enrichedRelative = detail?.person.enrichedAt
    ? formatRelative(detail.person.enrichedAt)
    : null;
  const lastTouchLabel = person.lastInteractionAt
    ? `${formatRelative(person.lastInteractionAt)}`
    : "no contact yet";
  const aboutText = cleanContactSummary(detail?.summary) ?? detail?.enrichment?.about ?? null;
  const starters = detail?.starters?.starters ?? [];
  const riskDotClass =
    risk === "overdue"
      ? "bg-risk-overdue"
      : risk === "waiting"
        ? "bg-risk-waiting"
        : "bg-risk-fresh";

  return (
    <section
      id={detailId}
      data-testid="person-detail-panel"
      className="animate-accordion-down border-t border-hairline bg-paper-2/40 px-0 py-4 sm:px-6 sm:py-8"
    >
      <div className="grid grid-cols-1 gap-6 sm:gap-10 md:grid-cols-[280px_1fr]">
        {/* LEFT: id-card */}
        <aside className="rounded-card border border-hairline bg-paper p-4 shadow-card sm:p-[22px] md:sticky md:top-[60px] md:self-start">
          <PersonAvatar
            name={person.name}
            avatarUrl={person.avatarUrl}
            size={56}
            className="mb-[14px] text-[20px]"
          />
          <h2 className="m-0 mb-[4px] text-balance font-display text-[20px] font-semibold leading-[1.2] tracking-[-0.018em] text-ink">
            {person.name}
          </h2>
          {(headline || subtitleLine) ? (
            <p className="m-0 mb-[18px] text-[13px] text-ink-3" style={{ textWrap: "pretty" }}>
              {headline ?? subtitleLine}
            </p>
          ) : null}

          <div className="mb-[18px] flex items-center gap-2 rounded-[10px] bg-paper-2 px-3 py-[9px] font-mono text-[11px] text-ink-2">
            <span className={`h-[6px] w-[6px] rounded-full ${riskDotClass}`} aria-hidden />
            Last contact
            <span className="ml-auto text-ink-3">{lastTouchLabel}</span>
          </div>

          <dl className="mb-[20px] grid grid-cols-[max-content_1fr] gap-x-[14px] gap-y-[9px] text-[13px]">
            <dt className="m-0 self-center font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">Channel</dt>
            <dd className="m-0 leading-[1.4] text-ink-2">
              {PLATFORM_LABEL[person.platform]}
              {detail?.person.profileUrl ? (
                <>
                  {" · "}
                  <a
                    href={detail.person.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent-ink underline decoration-[color-mix(in_oklch,var(--accent)_30%,transparent)] decoration-1 underline-offset-[3px]"
                  >
                    open profile ↗
                  </a>
                </>
              ) : null}
            </dd>
            {location ? (
              <>
                <dt className="m-0 self-center font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">Location</dt>
                <dd className="m-0 leading-[1.4] text-ink-2">{location}</dd>
              </>
            ) : null}
            {detail?.enrichment && detail.enrichment.education.length > 0 ? (
              <>
                <dt className="m-0 self-center font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">School</dt>
                <dd className="m-0 leading-[1.4] text-ink-2">
                  {detail.enrichment.education[0]?.institution ?? "-"}
                </dd>
              </>
            ) : null}
            {typeof mutualCount === "number" ? (
              <>
                <dt className="m-0 self-center font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">Mutuals</dt>
                <dd className="m-0 leading-[1.4] text-ink-2">{mutualCount} shared</dd>
              </>
            ) : null}
            {enrichedRelative ? (
              <>
                <dt className="m-0 self-center font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">Enriched</dt>
                <dd className="m-0 leading-[1.4] text-ink-2">{enrichedRelative} · {detail?.person.profileUrlSource ?? "auto"}</dd>
              </>
            ) : null}
          </dl>

          <div className="flex flex-col gap-2">
            <Button
              variant="primary"
              className="justify-center px-[14px] py-[10px]"
              disabled={!detail?.enrichment || startersLoading}
              onClick={onStartConversation}
            >
              {startersLoading ? "Drafting…" : "Start a conversation"}
            </Button>
            <Button variant="quiet" className="justify-center px-[14px] py-[10px]" onClick={onOpenInInbox}>
              Open in inbox
            </Button>
          </div>
        </aside>

        {/* RIGHT: context */}
        <div className="flex min-w-0 flex-col gap-7">
          {profileUrlMissing ? (
            <CtxBlock label="Profile URL · missing">
              <p className="m-0 text-[14.5px] leading-[1.55] text-ink-2">
                We don&rsquo;t have a {PLATFORM_LABEL[person.platform]} profile URL for this person yet. Paste it below to enrich.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <input
                  type="url"
                  value={profileUrlInput}
                  onChange={(event) => onProfileUrlInputChange(event.target.value)}
                  placeholder="https://www.linkedin.com/in/…"
                  className="w-[360px] max-w-full rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
                />
                <Button
                  variant="quiet"
                  disabled={!profileUrlInput.trim() || savingProfileUrl || refreshing}
                  onClick={onSaveProfileUrl}
                >
                  {savingProfileUrl || refreshing ? "Saving…" : "Save & enrich"}
                </Button>
              </div>
            </CtxBlock>
          ) : null}

          <CtxBlock
            label={aboutText ? "About · cited from headline" : "About"}
            right={
              aboutText && enrichStatus ? (
                <span className="font-mono text-[10.5px] text-ink-3">{enrichStatus}</span>
              ) : null
            }
          >
            {aboutText ? (
              <p
                className="m-0 text-[14.5px] leading-[1.55] text-ink-2"
                style={{ textWrap: "pretty" }}
              >
                {aboutText}
              </p>
            ) : (
              <p className="m-0 text-[14.5px] leading-[1.55] text-ink-3">
                {detail?.enrichment
                  ? "No summary yet. Refresh to generate one."
                  : "Not enriched yet. Refresh to fetch the profile."}
              </p>
            )}
          </CtxBlock>

          {mutualNames.length > 0 ? (
            <CtxBlock label={`Mutual connections · ${mutualCount ?? mutualNames.length}`}>
              <div className="flex flex-wrap items-center gap-[6px]">
                {mutualNames.slice(0, 5).map((name) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-[7px] rounded-pill border border-hairline py-[4px] pl-[4px] pr-[10px] text-[12.5px] text-ink-2"
                  >
                    <span
                      className="grid h-[20px] w-[20px] place-items-center rounded-full font-display text-[9.5px] font-semibold text-white"
                      style={{
                        background:
                          "linear-gradient(135deg, oklch(74% 0.07 220), oklch(58% 0.09 240))"
                      }}
                    >
                      {name.charAt(0).toUpperCase()}
                    </span>
                    {name}
                  </span>
                ))}
                {mutualNames.length > 5 ? (
                  <span className="inline-flex items-center rounded-pill px-3 py-[4px] font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    +{mutualNames.length - 5} more
                  </span>
                ) : null}
              </div>
            </CtxBlock>
          ) : null}

          {starters.length > 0 ? (
            <CtxBlock label="Suggested openers">
              <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2">
                {starters.slice(0, 4).map((starter, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="group flex w-full flex-col gap-2 rounded-[14px] border border-hairline bg-paper p-[14px_16px] text-left transition-[border-color,background-color] duration-calm hover:border-hairline-strong hover:bg-paper-2"
                  >
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink">
                      {starter.angle} · cited {starter.citedField}
                    </span>
                    <span
                      className="text-[13.5px] leading-[1.5] text-ink-2"
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 3,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                        textWrap: "pretty"
                      }}
                    >
                      {starter.text}
                    </span>
                    <span className="mt-auto flex items-center justify-between pt-1 font-mono text-[10.5px] text-ink-3">
                      <span>{starter.angle}</span>
                      <span className="text-accent-ink opacity-0 transition-opacity duration-calm group-hover:opacity-100">
                        use ↵
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </CtxBlock>
          ) : null}

          <CtxBlock
            label="Internal notes"
            right={
              <span className="font-mono text-[10.5px] text-ink-3" aria-live="polite">
                {notesStatus === "saving"
                  ? "saving…"
                  : notesStatus === "saved"
                    ? "saved"
                    : notesStatus === "error"
                      ? <span className="text-risk-overdue">failed to save</span>
                      : ""}
              </span>
            }
          >
            <textarea
              rows={notesDraft ? 5 : 2}
              value={notesDraft}
              onChange={(event) => onNotesChange(event.target.value)}
              placeholder={`Click to add a note about ${person.name.split(" ")[0] ?? person.name}…`}
              className="w-full resize-none rounded-[12px] border border-dashed border-hairline-strong bg-transparent px-[14px] py-[12px] text-[13px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-3 hover:border-ink-4 focus:border-ink-4"
            />
          </CtxBlock>

          <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-5">
            <Button variant="quiet" disabled={refreshing} onClick={onRefreshEnrichment}>
              {refreshing ? "Refreshing…" : "Refresh enrichment"}
            </Button>
            {enrichStatus && !aboutText ? (
              <span
                className="font-mono text-[11px] text-ink-3"
                aria-live="polite"
              >
                {enrichStatus}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function CtxBlock({
  label,
  right,
  children
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-[10px] flex items-center gap-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-3">
          {label}
        </span>
        {right ? <span className="ml-auto">{right}</span> : null}
      </div>
      {children}
    </section>
  );
}
