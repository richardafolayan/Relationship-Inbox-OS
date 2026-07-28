"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, runAction, ApiRequestError } from "@/lib/api";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { nextFocusIndexAfterMarkHandled } from "@/lib/at-risk-focus";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/common/person-avatar";
import { PLATFORM_LABEL } from "@/lib/risk";
import { normalizePreview } from "@/lib/preview";
import { cn } from "@/lib/utils";

// At-risk - threads where the operator owes a reply, framed as relationship
// decay rather than ops triage. Stat trio (Critical / At risk / Watch)
// over a decay-meter list with a one-click "Warm up ↗" CTA. Batch actions
// and Reply Focus Mode stay accessible from the header.
//
// The runner returns thread-level wait times, not person-level dormancy.
// Buckets here therefore measure "hours since they last messaged you" -
// the closest signal we have to "relationship decay" without a separate
// last-contact-per-person query.

type TriageSort = "oldest" | "newest";

const SORT_OPTIONS: { key: TriageSort; label: string }[] = [
  { key: "oldest", label: "Oldest first (recommended)" },
  { key: "newest", label: "Newest first" }
];

type DecayTone = "critical" | "atrisk" | "watch";

interface Bucket {
  key: DecayTone;
  label: string;
  sub: string;
  minHours: number;
  maxHours: number | null;
}

const BUCKETS: Bucket[] = [
  {
    key: "critical",
    label: "Critical · 7d+",
    sub: "cold, considered lost without effort",
    minHours: 24 * 7,
    maxHours: null
  },
  {
    key: "atrisk",
    label: "At risk · 3-7d",
    sub: "drifting, easy to recover",
    minHours: 24 * 3,
    maxHours: 24 * 7
  },
  {
    key: "watch",
    label: "Watch · <3d",
    sub: "trending quiet, not urgent yet",
    minHours: 0,
    maxHours: 24 * 3
  }
];

function waitHoursFor(row: InboxRow): number | null {
  const ts = row.lastInboundAt ?? row.lastMessageAt;
  if (!ts) return null;
  const parsed = new Date(ts).getTime();
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, (Date.now() - parsed) / (60 * 60 * 1_000));
}

function bucketFor(hours: number): Bucket {
  for (const bucket of BUCKETS) {
    if (hours >= bucket.minHours && (bucket.maxHours === null || hours < bucket.maxHours)) {
      return bucket;
    }
  }
  return BUCKETS[BUCKETS.length - 1] as Bucket;
}

function decayDotClass(tone: DecayTone): string {
  switch (tone) {
    case "critical":
      return "bg-risk-overdue";
    case "atrisk":
      return "bg-risk-waiting";
    case "watch":
      return "bg-ink-4";
  }
}

function decayFillClass(tone: DecayTone): string {
  switch (tone) {
    case "critical":
      return "bg-risk-overdue";
    case "atrisk":
      return "bg-risk-waiting";
    case "watch":
      return "bg-ink-4";
  }
}

function decayNumClass(tone: DecayTone): string {
  switch (tone) {
    case "critical":
      return "text-risk-overdue";
    case "atrisk":
      return "text-risk-waiting";
    case "watch":
      return "text-ink";
  }
}

function formatDecay(hours: number): string {
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

// Decay meter fill: scaled against a 14-day "definitely cold" baseline.
// 7d → 50%, 14d+ → 100%. Watch bucket fills below 50%.
function meterPct(hours: number): number {
  const pct = (hours / (24 * 14)) * 100;
  return Math.max(8, Math.min(100, pct));
}

export default function AtRiskPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusError, setFocusError] = useState<string | null>(null);
  const [triageSort, setTriageSort] = useState<TriageSort>("oldest");
  const [batchPending, setBatchPending] = useState<"snooze" | "archive" | null>(null);
  const [batchResult, setBatchResult] = useState<string | null>(null);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const inbox = await apiGet<InboxResponse>("/runner/data/inbox");
      setData(inbox);
      setError(null);
      const stillPending = new Set(
        inbox.rows.filter((row) => row.needsReply !== false).map((row) => row.id)
      );
      setRemovedIds((prev) => {
        const next = new Set<string>();
        prev.forEach((id) => {
          if (stillPending.has(id)) next.add(id);
        });
        return next;
      });
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : "Failed to load at-risk threads";
      setError(message);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  const rows = data?.rows ?? [];
  const atRisk = useMemo(
    () =>
      rows.filter(
        (row) =>
          !removedIds.has(row.id) && (row.riskLevel === "RED" || row.riskLevel === "AMBER")
      ),
    [rows, removedIds]
  );

  const sortedAtRisk = useMemo(() => {
    const copy = [...atRisk];
    copy.sort((a, b) => {
      const aHours = waitHoursFor(a) ?? 0;
      const bHours = waitHoursFor(b) ?? 0;
      return triageSort === "oldest" ? bHours - aHours : aHours - bHours;
    });
    return copy;
  }, [atRisk, triageSort]);

  const bucketCounts = useMemo(() => {
    const counts = new Map<DecayTone, number>();
    BUCKETS.forEach((b) => counts.set(b.key, 0));
    for (const row of sortedAtRisk) {
      const hours = waitHoursFor(row);
      if (hours === null) continue;
      const bucket = bucketFor(hours);
      counts.set(bucket.key, (counts.get(bucket.key) ?? 0) + 1);
    }
    return BUCKETS.map((bucket) => ({ ...bucket, count: counts.get(bucket.key) ?? 0 }));
  }, [sortedAtRisk]);

  const total = sortedAtRisk.length;
  const focusThread: InboxRow | undefined = sortedAtRisk[focusIndex];
  const focusDone = focusOpen && !focusThread;

  const openFocus = () => {
    setFocusIndex(0);
    setFocusError(null);
    setFocusOpen(true);
  };
  const closeFocus = () => {
    setFocusOpen(false);
    setFocusError(null);
  };
  const advance = () => {
    setFocusError(null);
    setFocusIndex((i) => i + 1);
  };
  const handleOpenThread = () => {
    if (!focusThread) return;
    router.push(`/thread/${focusThread.id}`);
    setFocusOpen(false);
  };
  const handleMarkHandled = async () => {
    if (!focusThread) return;
    await runAction(
      apiPost(`/runner/control/thread/${focusThread.id}/archive`, {}),
      setFocusError,
      refresh
    );
    // Do NOT advance(): archiving triggers refresh(), which drops the handled
    // thread from sortedAtRisk and slides the next thread into the current
    // focusIndex. Advancing as well would skip that next thread.
    setFocusError(null);
    setFocusIndex((i) => nextFocusIndexAfterMarkHandled(i));
  };

  const runBatch = async (
    label: "snooze" | "archive",
    buildPath: (id: string) => string,
    body: Record<string, unknown> = {}
  ) => {
    if (sortedAtRisk.length === 0) return;
    const verb =
      label === "snooze"
        ? `Snooze ${sortedAtRisk.length} visible threads for 24h?`
        : `Archive ${sortedAtRisk.length} visible threads?`;
    const ok = window.confirm(`${verb} You can unarchive any of them from the Archived view.`);
    if (!ok) return;
    setBatchPending(label);
    setBatchResult(null);
    const ids = sortedAtRisk.map((row) => row.id);
    setRemovedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    const results = await Promise.allSettled(ids.map((id) => apiPost(buildPath(id), body)));
    const failed = results.filter((r) => r.status === "rejected");
    const succeeded = ids.length - failed.length;
    if (failed.length > 0) {
      const failedIds = new Set<string>(
        results.flatMap((r, idx) =>
          r.status === "rejected" && ids[idx] !== undefined ? [ids[idx] as string] : []
        )
      );
      setRemovedIds((prev) => {
        const next = new Set(prev);
        failedIds.forEach((id) => next.delete(id));
        return next;
      });
      const firstReason = failed
        .map((f) => (f.status === "rejected" ? (f.reason as Error | ApiRequestError) : null))
        .find(Boolean);
      const reasonMsg = firstReason instanceof Error ? firstReason.message : "Unknown";
      setBatchResult(`${label}: ${succeeded} ok, ${failed.length} failed (${reasonMsg})`);
    } else {
      setBatchResult(`${label}: ${succeeded} of ${ids.length}`);
    }
    setBatchPending(null);
    void refresh();
  };

  if (error && !data) {
    return (
      <Canvas>
        <PageHead eyebrow="Relationship health" title="At risk" />
        <div className="rounded-row border border-hairline bg-paper-2 px-4 py-3">
          <p className="m-0 text-[13px] font-medium text-ink">These conversations could not be opened.</p>
          <p className="m-0 mt-1 text-[12px] leading-[1.5] text-ink-3">{error}</p>
        </div>
      </Canvas>
    );
  }

  return (
    <Canvas>
      <PageHead
        eyebrow="Relationship health"
        title="At Risk"
        meta={
          <span>
            across <strong className="font-medium text-ink">{total}</strong> threads
          </span>
        }
      />

      {total > 0 ? (
        <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:mb-6 sm:flex sm:flex-wrap sm:gap-3">
          <select
            value={triageSort}
            onChange={(event) => setTriageSort(event.target.value as TriageSort)}
            className="min-w-0 rounded-[10px] border border-hairline bg-paper px-2 py-[8px] text-[12px] text-ink-2 focus:border-ink-3 focus:outline-none sm:shrink-0 sm:py-[6px]"
            aria-label="Triage order"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
          <Button
            variant="quiet"
            disabled={!!batchPending}
            onClick={() =>
              void runBatch("snooze", (id) => `/runner/control/thread/${id}/snooze`, { hours: 24 })
            }
            className="hidden px-[14px] py-[7px] text-[12px] sm:inline-flex"
          >
            {batchPending === "snooze" ? "Snoozing…" : "Snooze visible 24h"}
          </Button>
          <Button
            variant="quiet"
            disabled={!!batchPending}
            onClick={() =>
              void runBatch("archive", (id) => `/runner/control/thread/${id}/archive`)
            }
            className="hidden px-[14px] py-[7px] text-[12px] sm:inline-flex"
          >
            {batchPending === "archive" ? "Archiving…" : "Archive visible"}
          </Button>
          <Button variant="quiet" onClick={openFocus} className="px-3 py-[8px] text-[12px] sm:px-[14px] sm:py-[7px]">
            <span className="sm:hidden">Reply one by one</span>
            <span className="hidden sm:inline">Reply focus mode</span>
          </Button>
        </div>
      ) : null}

      {batchResult ? (
        <p className="mb-3 font-mono text-[11px] text-ink-3">{batchResult}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : total === 0 ? (
        <CaughtUp title="You're caught up." body="Nothing is at risk right now." />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-3 gap-2 sm:mb-[28px] sm:gap-[12px]">
            {bucketCounts.map((bucket) => (
              <div
                key={bucket.key}
                className="min-w-0 rounded-[14px] border border-hairline bg-paper px-2.5 py-3 sm:px-[20px] sm:py-[18px]"
              >
                <p className="mb-2 flex min-h-7 items-start gap-1.5 font-mono text-[9px] uppercase leading-[1.35] tracking-[0.05em] text-ink-3 sm:mb-[10px] sm:min-h-0 sm:items-center sm:gap-2 sm:text-[10px] sm:tracking-[0.08em]">
                  <span className={cn("inline-block h-[7px] w-[7px] rounded-full", decayDotClass(bucket.key))} />
                  {bucket.label}
                </p>
                <p
                  className={cn(
                    "m-0 mb-[6px] font-display text-[26px] font-semibold leading-[1] tracking-[-0.022em] sm:text-[32px]",
                    decayNumClass(bucket.key)
                  )}
                >
                  {bucket.count}
                </p>
                <p className="m-0 hidden font-mono text-[11px] text-ink-3 sm:block">{bucket.sub}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-col">
            {sortedAtRisk.map((row) => {
              const hours = waitHoursFor(row) ?? 0;
              const bucket = bucketFor(hours);
              return (
                <Link
                  key={row.id}
                  href={`/thread/${row.id}`}
                  className="group grid min-h-[82px] grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-b border-hairline px-1 py-3 transition-colors duration-calm hover:bg-paper-2 sm:grid-cols-[36px_1fr_minmax(140px,180px)_auto] sm:gap-[18px] sm:py-[14px]"
                >
                  <PersonAvatar
                    name={row.personName}
                    avatarUrl={row.personAvatarUrl}
                    size={36}
                    className="col-start-1 row-start-1 text-[13px] sm:col-start-auto sm:row-start-auto"
                  />
                  <div className="col-start-2 row-start-1 min-w-0 sm:col-start-auto sm:row-start-auto">
                    <p className="m-0 text-[14px] font-medium tracking-[-0.005em] text-ink">
                      {row.personName}
                    </p>
                    <p className="m-0 mt-[1px] truncate text-[12px] text-ink-3">
                      {PLATFORM_LABEL[row.platform]}
                      {row.preview ? ` · ${normalizePreview(row.preview)}` : ""}
                    </p>
                  </div>
                  <div className="col-start-2 col-end-4 row-start-2 flex items-center gap-[8px] font-mono text-[10.5px] text-ink-3 sm:col-auto sm:row-start-auto sm:gap-[10px] sm:text-[11px]">
                    <span className="hidden shrink-0 sm:inline">last touch</span>
                    <span className="relative h-[3px] flex-1 overflow-hidden rounded-pill bg-hairline">
                      <span
                        className={cn("absolute inset-y-0 left-0 rounded-pill", decayFillClass(bucket.key))}
                        style={{ width: `${meterPct(hours)}%` }}
                      />
                    </span>
                    <span className="shrink-0 tabular-nums text-ink-2">{formatDecay(hours)}</span>
                  </div>
                  <span className="col-start-3 row-start-1 inline-flex min-h-[36px] items-center justify-self-end gap-[6px] rounded-pill border border-hairline px-2.5 py-[7px] text-[0px] text-ink-2 transition-colors duration-calm group-hover:border-ink group-hover:text-ink sm:col-start-auto sm:row-auto sm:justify-self-auto sm:px-3 sm:text-[12px]">
                    <span className="text-[15px] sm:text-[12px]">↗</span><span className="hidden sm:inline">Warm up</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {focusOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-center bg-paper p-0 sm:items-center sm:bg-[color-mix(in_oklch,var(--ink)_28%,transparent)] sm:p-6"
          role="dialog"
          aria-modal="true"
          onClick={closeFocus}
        >
          <div
            className="h-full w-full max-w-[520px] overflow-y-auto bg-paper px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-[calc(16px+env(safe-area-inset-top))] sm:h-auto sm:max-h-[90vh] sm:rounded-card sm:border sm:border-hairline-strong sm:p-8 sm:shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                {focusDone ? "Reply focus mode" : `Thread ${focusIndex + 1} of ${total}`}
              </p>
              <button
                type="button"
                onClick={closeFocus}
                className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 transition-colors hover:text-ink"
              >
                close
              </button>
            </div>

            {focusDone ? (
              <div className="py-10 text-center">
                <h3 className="m-0 mb-2 font-display text-[28px] font-semibold tracking-[-0.022em] text-ink">
                  All done.
                </h3>
                <p className="m-0 text-[14px] text-ink-3">
                  You&rsquo;ve worked through every at-risk thread.
                </p>
                <div className="mt-6 flex justify-center">
                  <Button variant="quiet" onClick={closeFocus}>done</Button>
                </div>
              </div>
            ) : focusThread ? (
              <>
                <div className="mb-2 flex items-center gap-[10px]">
                  <span
                    className={`h-[6px] w-[6px] rounded-full ${
                      focusThread.riskLevel === "RED" ? "bg-risk-overdue" : "bg-risk-waiting"
                    }`}
                    aria-hidden
                  />
                  <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    {PLATFORM_LABEL[focusThread.platform]}
                  </span>
                </div>
                <h3 className="m-0 mb-3 font-display text-[24px] font-semibold tracking-[-0.018em] text-ink">
                  {focusThread.personName}
                </h3>
                <p className="m-0 mb-6 line-clamp-[6] text-[14px] leading-relaxed text-ink-2">
                  {focusThread.lastMessageDirection === "OUT"
                    ? `You: ${normalizePreview(focusThread.preview)}`
                    : normalizePreview(focusThread.preview)}
                </p>
                {focusError ? (
                  <p className="mb-3 rounded-row border border-hairline bg-paper-2 px-3 py-2 text-[12px] leading-[1.45] text-ink-2">{focusError}</p>
                ) : null}
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button variant="ghost" onClick={advance}>skip</Button>
                  <Button variant="quiet" onClick={handleMarkHandled}>mark handled</Button>
                  <Button variant="primary" onClick={handleOpenThread}>open thread →</Button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </Canvas>
  );
}
