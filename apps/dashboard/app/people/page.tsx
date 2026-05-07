"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import { formatRelative } from "@/lib/time";
import type { PeopleRow, PersonDetailResponse } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

function riskTone(level: string): "green" | "amber" | "red" {
  if (level === "RED") {
    return "red";
  }
  if (level === "AMBER") {
    return "amber";
  }
  return "green";
}

export default function PeoplePage() {
  const [people, setPeople] = useState<PeopleRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [startersLoading, setStartersLoading] = useState(false);
  const [showStarters, setShowStarters] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadList(): Promise<PeopleRow[]> {
    const data = await apiGet<PeopleRow[]>("/runner/data/people");
    setPeople(data);
    return data;
  }

  async function loadDetail(personId: string, includeStarters = false): Promise<void> {
    setDetailLoading(true);
    try {
      const data = await apiGet<PersonDetailResponse>(
        `/runner/data/person/${personId}${includeStarters ? "?includeStarters=1" : ""}`
      );
      setDetail(data);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadList().then((data) => {
      setSelectedId(data[0]?.id ?? null);
    });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setShowStarters(false);
    void loadDetail(selectedId);
  }, [selectedId]);

  const selected = useMemo(() => people.find((person) => person.id === selectedId) ?? null, [people, selectedId]);

  function refreshEnrichment(): void {
    if (!selectedId) return;
    setRefreshing(true);
    runAction(
      apiPost(`/runner/control/person/${selectedId}/enrich?wait=1`, {}).finally(() => {
        setRefreshing(false);
      }),
      setError,
      async () => {
        await loadList();
        if (selectedId) await loadDetail(selectedId);
      }
    );
  }

  function fetchStarters(): void {
    if (!selectedId) return;
    setStartersLoading(true);
    setShowStarters(true);
    void loadDetail(selectedId, true).finally(() => setStartersLoading(false));
  }

  function copyToClipboard(text: string): void {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">People</h2>
        <p className="text-sm text-slate-500">Lightweight relationship context across our conversations.</p>
      </div>

      {error ? (
        <Card className="border-red-200 bg-red-50">
          <p className="text-sm text-red-700">{error}</p>
        </Card>
      ) : null}

      <div className="grid grid-cols-12 gap-4">
        <Card className="col-span-12 lg:col-span-7">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] border-b border-slate-200 pb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
            <span>Name</span>
            <span>Platform</span>
            <span>Last interaction</span>
            <span>Risk</span>
          </div>

          <div className="mt-2 space-y-2">
            {people.map((person) => (
              <button
                key={person.id}
                className={`grid w-full grid-cols-[2fr_1fr_1fr_1fr] rounded-lg border px-3 py-2 text-left text-sm ${selectedId === person.id ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                onClick={() => setSelectedId(person.id)}
              >
                <span className="flex flex-col">
                  <span className="font-medium text-slate-900">{person.name}</span>
                  {person.headline ? (
                    <span className="truncate text-xs text-slate-500">{person.headline}</span>
                  ) : null}
                </span>
                <span>
                  <Badge tone="blue">{person.platform}</Badge>
                </span>
                <span className="text-slate-600">{formatRelative(person.lastInteractionAt)}</span>
                <div>
                  <div className="flex items-center gap-2">
                    <Badge tone={riskTone(person.risk)}>{person.risk}</Badge>
                    {person.hasUnresolvedIdentityWarning ? <Badge tone="amber">Unresolved ID</Badge> : null}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </Card>

        <Card className="col-span-12 space-y-3 lg:col-span-5">
          {selected ? (
            <>
              <h3 className="text-lg font-semibold">{selected.name}</h3>
              <div className="flex items-center gap-2">
                <Badge tone="blue">{selected.platform}</Badge>
                <Badge tone={riskTone(selected.risk)}>{selected.risk}</Badge>
                {selected.hasUnresolvedIdentityWarning ? (
                  <Badge tone="amber">
                    {selected.unresolvedThreadCount ? `${selected.unresolvedThreadCount} unresolved` : "Unresolved ID"}
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm text-slate-600">Last interaction {formatRelative(selected.lastInteractionAt)}</p>

              <Card className="bg-slate-50">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Summary</h4>
                  <button
                    className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                    disabled={refreshing}
                    onClick={refreshEnrichment}
                  >
                    {refreshing ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {detailLoading
                    ? "Loading..."
                    : detail?.summary
                    ? detail.summary
                    : detail?.enrichment
                    ? "No summary yet. Click Refresh to generate one."
                    : "Not enriched yet. Click Refresh to fetch the LinkedIn profile."}
                </p>
              </Card>

              {detail?.enrichment ? (
                <Card className="bg-slate-50">
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Profile</h4>
                  <ul className="mt-2 space-y-1 text-sm text-slate-700">
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
                </Card>
              ) : null}

              <button
                className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-800 hover:bg-blue-100 disabled:opacity-60"
                disabled={!detail?.enrichment || startersLoading}
                onClick={fetchStarters}
              >
                {startersLoading ? "Drafting..." : "Start a conversation"}
              </button>

              {showStarters && detail?.starters && detail.starters.starters.length > 0 ? (
                <Card className="bg-white">
                  <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Suggested openers</h4>
                  <p className="mt-1 text-xs text-slate-500">
                    Generated {formatRelative(detail.starters.generatedAt)} • {detail.starters.validatedCount} of {detail.starters.starters.length} cited a real field
                  </p>
                  <div className="mt-3 space-y-3">
                    {detail.starters.starters.map((starter, idx) => (
                      <div key={idx} className="rounded border border-slate-200 p-3 text-sm">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                            {starter.angle} • cited {starter.citedField}
                          </span>
                          <button
                            className="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-100"
                            onClick={() => copyToClipboard(starter.text)}
                          >
                            Copy
                          </button>
                        </div>
                        <p className="text-slate-800">{starter.text}</p>
                      </div>
                    ))}
                  </div>
                </Card>
              ) : showStarters && !startersLoading ? (
                <Card className="bg-slate-50">
                  <p className="text-sm text-slate-600">No starters available. Try refreshing the profile first.</p>
                </Card>
              ) : null}

              {detail?.enrichment?.recentPosts && detail.enrichment.recentPosts.length > 0 ? (
                <details className="rounded-lg border border-slate-200 bg-white p-3">
                  <summary className="cursor-pointer text-sm font-semibold text-slate-700">Recent posts</summary>
                  <ul className="mt-2 space-y-2 text-sm text-slate-700">
                    {detail.enrichment.recentPosts.map((post, idx) => (
                      <li key={idx} className="border-l-2 border-slate-200 pl-2">
                        <p className="text-xs text-slate-500">{post.postedAt ?? "—"}</p>
                        <p>{post.text}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <Card className="bg-slate-50">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Tags</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(selected.tags.length ? selected.tags : ["Warm lead"]).map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </div>
              </Card>

              <Card className="bg-slate-50">
                <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Notes</h4>
                <Textarea rows={6} defaultValue={selected.notes ?? ""} placeholder="Internal relationship notes..." />
              </Card>

              <p className="text-xs text-slate-500">
                {selected.enrichmentFailedReason ? (
                  <span className="text-amber-700">Last enrichment failed: {selected.enrichmentFailedReason}</span>
                ) : selected.enrichedAt ? (
                  <>Last enriched {formatRelative(selected.enrichedAt)}</>
                ) : (
                  <>Not enriched yet</>
                )}
              </p>

              <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
                Manual merge duplicates
              </button>
            </>
          ) : (
            <p className="text-sm text-slate-500">No people yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
