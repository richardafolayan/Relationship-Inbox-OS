"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { PeopleRow, PersonDetailResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { initials, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const NOTES_STORAGE_PREFIX = "inbox_person_notes_";

// People — list on the left, sticky detail panel on the right. Detail
// panel houses summary + tags + notes + start-a-conversation +
// manual-merge-duplicates so the per-person actions stop falling off the
// bottom of a 75-row list.
export default function PeoplePage() {
  const router = useRouter();
  const [people, setPeople] = useState<PeopleRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonDetailResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [startersLoading, setStartersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

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
      setNotes("");
      return;
    }
    void loadDetail(selectedId);
    const stored = window.localStorage.getItem(`${NOTES_STORAGE_PREFIX}${selectedId}`);
    setNotes(stored ?? "");
  }, [selectedId, loadDetail]);

  const selected = useMemo(
    () => people.find((person) => person.id === selectedId) ?? null,
    [people, selectedId]
  );

  // Persist notes to localStorage as the operator types — the runner
  // doesn't currently expose a notes endpoint, so this matches main's
  // behaviour (visible field, no backend) but adds reload-survival.
  const onNotesChange = (value: string) => {
    setNotes(value);
    if (selectedId) {
      window.localStorage.setItem(`${NOTES_STORAGE_PREFIX}${selectedId}`, value);
    }
  };

  const refreshEnrichment = () => {
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
  };

  const fetchStarters = () => {
    if (!selectedId) return;
    setStartersLoading(true);
    void loadDetail(selectedId, true).finally(() => setStartersLoading(false));
  };

  const manualMerge = () => {
    if (!selectedId || !selected) return;
    window.alert(
      `Manual merge for ${selected.name} is not yet wired up on the runner. Use the CLI's merge-people script for now.`
    );
  };

  const tags = selected?.tags.length ? selected.tags : ["Warm lead"];

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
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex max-h-[calc(100vh-260px)] flex-col overflow-y-auto">
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
            <aside className="lg:sticky lg:top-6 lg:self-start">
              <div className="rounded-card border border-hairline bg-paper p-6 shadow-card">
                <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                  {PLATFORM_LABEL[selected.platform]} · last contact{" "}
                  {formatRelative(selected.lastInteractionAt)}
                </p>
                <h3 className="m-0 font-display text-[22px] font-semibold tracking-[-0.02em]">
                  {selected.name}
                </h3>

                <p className="mt-4 text-[14px] leading-[1.55] text-ink-2">
                  {detail?.summary ??
                    (detail?.enrichment
                      ? "No summary yet. Refresh to generate one."
                      : "Not enriched yet. Refresh to fetch the LinkedIn profile.")}
                </p>

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
                  <div className="mt-5 border-t border-hairline pt-4">
                    <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                      Suggested openers
                    </p>
                    <div className="space-y-2">
                      {detail.starters.starters.map((starter, idx) => (
                        <div key={idx} className="rounded-row border border-hairline p-3 text-[13px]">
                          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                            {starter.angle} · cited {starter.citedField}
                          </p>
                          <p className="text-ink">{starter.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="mt-5 border-t border-hairline pt-4">
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    Tags
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-pill border border-hairline px-3 py-1 text-[12px] text-ink-2"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="mt-5 border-t border-hairline pt-4">
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    Notes
                  </p>
                  <Textarea
                    rows={5}
                    value={notes}
                    onChange={(event) => onNotesChange(event.target.value)}
                    placeholder="Internal relationship notes…"
                    className="text-[13px]"
                  />
                </div>

                <p className="mt-4 font-mono text-[11px] text-ink-3">
                  {selected.enrichmentFailedReason ? (
                    <span className="text-risk-overdue">
                      Last enrichment failed: {selected.enrichmentFailedReason}
                    </span>
                  ) : selected.enrichedAt ? (
                    <>Last enriched {formatRelative(selected.enrichedAt)}</>
                  ) : (
                    <>Not enriched yet</>
                  )}
                </p>

                <div className="mt-5 flex flex-wrap items-center gap-2">
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
                  <Button variant="quiet" onClick={manualMerge}>
                    Manual merge duplicates
                  </Button>
                  <button
                    type="button"
                    onClick={() => router.push(`/inbox?person=${selected.id}`)}
                    className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
                  >
                    open in inbox
                  </button>
                </div>
              </div>
            </aside>
          ) : null}
        </div>
      )}
    </Canvas>
  );
}
