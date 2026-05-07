"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { PeopleRow, PersonDetailResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { initials, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { Button } from "@/components/ui/button";

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
  const [startersLoading, setStartersLoading] = useState(false);
  const [profileUrlInput, setProfileUrlInput] = useState("");
  const [savingProfileUrl, setSavingProfileUrl] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const data = await apiGet<PeopleRow[]>("/runner/data/people").catch(() => [] as PeopleRow[]);
    setPeople(data);
    return data;
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

  useEffect(() => {
    void loadList().then((data) => {
      if (!selectedId && data[0]) setSelectedId(data[0].id);
    });
  }, [loadList, selectedId]);

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

  const refreshEnrichment = useCallback(() => {
    if (!selectedId) return;
    setRefreshing(true);
    runAction(
      apiPost(`/runner/control/person/${selectedId}/enrich?wait=1`, {}).finally(() =>
        setRefreshing(false)
      ),
      setError,
      async () => {
        await loadList();
        if (selectedId) await loadDetail(selectedId);
      }
    );
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
        title="People."
        meta={people.length > 0 ? <span>{people.length} relationships</span> : null}
      />

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {people.length === 0 ? (
        <CaughtUp title="No relationships yet." body="Connect a platform to start mapping people." />
      ) : (
        <>
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
              return (
                <button
                  key={person.id}
                  type="button"
                  onClick={() => setSelectedId(person.id)}
                  className={`grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] text-left transition-colors duration-calm last:border-b last:border-hairline hover:bg-paper-2 ${
                    active ? "bg-paper-2" : ""
                  }`}
                >
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[12px] font-semibold text-white">
                    {initials(person.name)}
                  </span>
                  <span className="min-w-0">
                    <span className="mb-1 flex items-baseline gap-[10px]">
                      <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">
                        {person.name}
                      </span>
                      <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
                        {PLATFORM_LABEL[person.platform]}
                      </span>
                    </span>
                    <span className="block max-w-[52ch] truncate text-[14px] text-ink-3">
                      {person.headline ??
                        [person.currentRole, person.currentCompany].filter(Boolean).join(" at ") ??
                        "no profile yet"}
                    </span>
                  </span>
                  <span className="flex items-center gap-[10px] font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    <span className={`h-[6px] w-[6px] rounded-full ${dot}`} />
                    {person.lastInteractionAt
                      ? formatRelative(person.lastInteractionAt)
                      : "no contact yet"}
                  </span>
                </button>
              );
            })}
          </div>

          {selected ? (
            <section className="mt-12 rounded-card border border-hairline bg-paper p-9 shadow-card">
              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                {PLATFORM_LABEL[selected.platform]} · last contact{" "}
                {formatRelative(selected.lastInteractionAt)}
              </p>
              <h3 className="m-0 font-display text-[26px] font-semibold tracking-[-0.02em]">
                {selected.name}
              </h3>

              <p className="mt-4 max-w-[58ch] text-[15px] leading-[1.55] text-ink-2">
                {detail?.summary ??
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

              {detail?.enrichment ? (
                <ul className="mt-4 space-y-1 font-mono text-[12px] text-ink-3">
                  {detail.enrichment.headline ? <li>{detail.enrichment.headline}</li> : null}
                  {detail.enrichment.currentRole || detail.enrichment.currentCompany ? (
                    <li>
                      {[detail.enrichment.currentRole, detail.enrichment.currentCompany]
                        .filter(Boolean)
                        .join(" at ")}
                    </li>
                  ) : null}
                  {detail.enrichment.location ? <li>{detail.enrichment.location}</li> : null}
                </ul>
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

              <div className="mt-6 flex flex-wrap items-center gap-3">
                <Button variant="quiet" disabled={refreshing} onClick={refreshEnrichment}>
                  {refreshing ? "Refreshing…" : "Refresh enrichment"}
                </Button>
                <Button
                  variant="quiet"
                  disabled={!detail?.enrichment || startersLoading}
                  onClick={fetchStarters}
                >
                  {startersLoading ? "Drafting…" : "Start a conversation"}
                </Button>
                <button
                  type="button"
                  onClick={() => router.push(`/inbox?person=${selected.id}`)}
                  className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
                >
                  open in inbox
                </button>
              </div>
            </section>
          ) : null}
        </>
      )}
    </Canvas>
  );
}
