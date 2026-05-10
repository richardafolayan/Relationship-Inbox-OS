"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, ApiRequestError } from "@/lib/api";
import { runActionWithFeedback } from "@/lib/feedback";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { Button } from "@/components/ui/button";
import { PLATFORM_LABEL } from "@/lib/risk";
import { normalizePreview } from "@/lib/preview";
import { cn } from "@/lib/utils";

// At-risk page: overdue + waiting threads with the operator owing a reply.
// v0.3.0 investments per Q3:
//   - Aggregate burn-down: groups visible threads into four wait-time
//     buckets and renders a stacked bar so the operator sees the shape
//     of the backlog at a glance ("most of the at-risk pile is in the
//     24-72h zone, push through that").
//   - Suggested triage order: sort dropdown with "Oldest first" as the
//     default. The intent is to clear the longest-waiting threads first
//     because every additional day of silence amplifies the perception
//     of being ghosted.
//   - Batch SLA actions: alongside Reply Focus Mode, expose
//     "Snooze visible 24h" and "Archive visible" buttons so the operator
//     can act on the whole at-risk set in one stroke when they decide a
//     batch is unrecoverable or worth deferring.
//   - Reply Focus Mode: kept intact - one-thread-at-a-time modal that
//     walks through every at-risk thread.

type TriageSort = "oldest" | "newest";

const SORT_OPTIONS: { key: TriageSort; label: string }[] = [
  { key: "oldest", label: "Oldest first (recommended)" },
  { key: "newest", label: "Newest first" }
];

interface Bucket {
  key: string;
  label: string;
  minHours: number;
  maxHours: number | null;
  tone: "amber" | "orange" | "red" | "deep";
}

const BUCKETS: Bucket[] = [
  { key: "<24h", label: "Last 24h", minHours: 0, maxHours: 24, tone: "amber" },
  { key: "24-72h", label: "24-72h", minHours: 24, maxHours: 72, tone: "orange" },
  { key: "72h-7d", label: "72h - 7d", minHours: 72, maxHours: 24 * 7, tone: "red" },
  { key: ">7d", label: "Over 7d", minHours: 24 * 7, maxHours: null, tone: "deep" }
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
    if (
      hours >= bucket.minHours &&
      (bucket.maxHours === null || hours < bucket.maxHours)
    ) {
      return bucket;
    }
  }
  // Fallback to last bucket - shouldn't happen because the last bucket
  // has maxHours = null.
  return BUCKETS[BUCKETS.length - 1] as Bucket;
}

function bucketTone(tone: Bucket["tone"]): string {
  switch (tone) {
    case "amber":
      return "bg-risk-waiting";
    case "orange":
      return "bg-[oklch(72%_0.16_60)]";
    case "red":
      return "bg-risk-overdue";
    case "deep":
      return "bg-[oklch(45%_0.18_28)]";
  }
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
  // Optimistic-removal: rows we just acted on disappear instantly. The
  // next /data/inbox refresh reconciles - if the server didn't catch
  // up, the row stays gone until poll.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const inbox = await apiGet<InboxResponse>("/runner/data/inbox");
      setData(inbox);
      setError(null);
      // Drop optimistically-removed ids the server has caught up on.
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

  const overdue = useMemo(
    () => sortedAtRisk.filter((row) => row.riskLevel === "RED"),
    [sortedAtRisk]
  );
  const waiting = useMemo(
    () => sortedAtRisk.filter((row) => row.riskLevel === "AMBER"),
    [sortedAtRisk]
  );
  const total = sortedAtRisk.length;

  // Burn-down: count per time bucket. Used both for the small stacked
  // bar at the top of the sidebar and for the per-bucket count rows
  // underneath. Buckets are static so empty buckets render with 0 -
  // preserves the shape "<24h | 24-72h | 72h-7d | >7d" the operator
  // can scan against over time.
  const bucketCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const bucket of BUCKETS) counts.set(bucket.key, 0);
    for (const row of sortedAtRisk) {
      const hours = waitHoursFor(row);
      if (hours === null) continue;
      const bucket = bucketFor(hours);
      counts.set(bucket.key, (counts.get(bucket.key) ?? 0) + 1);
    }
    return BUCKETS.map((bucket) => ({
      ...bucket,
      count: counts.get(bucket.key) ?? 0
    }));
  }, [sortedAtRisk]);

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
  const [handlingFocus, setHandlingFocus] = useState(false);
  const handleMarkHandled = async () => {
    if (!focusThread || handlingFocus) return;
    const name = focusThread.personName;
    setHandlingFocus(true);
    runActionWithFeedback(
      apiPost(`/runner/control/thread/${focusThread.id}/archive`, {}),
      {
        pending: `Marking ${name} as handled…`,
        success: `Marked ${name} as handled`,
        failure: "Couldn't mark as handled",
        setError: setFocusError,
        onDone: async () => {
          await refresh();
          setHandlingFocus(false);
        }
      }
    );
    // Advance optimistically so the operator can keep moving — the toast
    // and refresh will roll back if the server rejects.
    advance();
  };

  // Batch SLA actions. Operate on the currently-visible at-risk set
  // (post-sort, post-removed). All actions are confirm-gated because
  // they touch every visible row at once.
  const runBatch = async (
    label: "snooze" | "archive",
    buildPath: (id: string) => string,
    body: Record<string, unknown> = {}
  ) => {
    if (sortedAtRisk.length === 0) return;
    const verb = label === "snooze" ? `Snooze ${sortedAtRisk.length} visible threads for 24h?` : `Archive ${sortedAtRisk.length} visible threads?`;
    const ok = window.confirm(`${verb} You can unarchive any of them from the Archived view.`);
    if (!ok) return;
    setBatchPending(label);
    setBatchResult(null);
    const ids = sortedAtRisk.map((row) => row.id);
    // Optimistic removal so the list clears instantly. Failed ids
    // restore below if the server complains.
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
        <PageHead
          eyebrow="Needs you"
          title="At risk"
          subtitle="Threads breaching your reply SLA. Clear these first to stop relationships going cold."
        />
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.06em] text-risk-overdue">
          Could not load at-risk threads
        </p>
        <p className="font-mono text-[12px] text-ink-3">{error}</p>
      </Canvas>
    );
  }

  return (
    <Canvas>
      <PageHead
        eyebrow="Needs you"
        title="At risk"
        subtitle="Threads breaching your reply SLA. Clear these first to stop relationships going cold."
        meta={
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span>
              <span className="text-ink">{overdue.length}</span> overdue ·{" "}
              <span className="text-ink">{waiting.length}</span> waiting
            </span>
            {total > 0 ? (
              <>
                <select
                  value={triageSort}
                  onChange={(event) => setTriageSort(event.target.value as TriageSort)}
                  className="shrink-0 rounded-[10px] border border-hairline bg-paper px-2 py-[6px] text-[12px] text-ink-2 focus:border-ink-3 focus:outline-none"
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
                  className="px-[14px] py-[7px] text-[12px]"
                >
                  {batchPending === "snooze" ? "Snoozing…" : "Snooze visible 24h"}
                </Button>
                <Button
                  variant="quiet"
                  disabled={!!batchPending}
                  onClick={() =>
                    void runBatch("archive", (id) => `/runner/control/thread/${id}/archive`)
                  }
                  className="px-[14px] py-[7px] text-[12px]"
                >
                  {batchPending === "archive" ? "Archiving…" : "Archive visible"}
                </Button>
                <Button variant="quiet" onClick={openFocus} className="px-[14px] py-[7px] text-[12px]">
                  Reply focus mode
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {batchResult ? (
        <p className="mb-3 font-mono text-[11px] text-ink-3">{batchResult}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : total === 0 ? (
        <CaughtUp title="You're caught up." body="Nothing is at risk right now." />
      ) : (
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_280px]">
          <div>
            {overdue.length ? (
              <section>
                <SectionDivider label="Overdue - they've waited longest" />
                <div className="flex flex-col">
                  {overdue.map((row) => (
                    <ThreadRow key={row.id} row={row} />
                  ))}
                </div>
              </section>
            ) : null}
            {waiting.length ? (
              <section>
                <SectionDivider label="Waiting on you" />
                <div className="flex flex-col">
                  {waiting.map((row) => (
                    <ThreadRow key={row.id} row={row} />
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="lg:pt-[18px]">
            <SectionDivider label="Burn-down" />
            <BurnDownBar buckets={bucketCounts} total={total} />
            <div className="mt-4 flex flex-col">
              {bucketCounts.map((bucket) => (
                <div
                  key={bucket.key}
                  className="flex items-center justify-between border-t border-hairline px-1 py-[12px] last:border-b last:border-hairline"
                >
                  <span className="flex items-center gap-2 text-[13px] text-ink-2">
                    <span
                      className={cn(
                        "inline-block h-[8px] w-[8px] rounded-full",
                        bucketTone(bucket.tone)
                      )}
                    />
                    {bucket.label}
                  </span>
                  <span className="font-mono text-[12px] text-ink-3">{bucket.count}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 m-0 text-[12px] leading-[1.55] text-ink-3">
              Recommended order: clear the right-most (oldest) buckets first. Every additional day of silence amplifies the perception of being ghosted.
            </p>
          </aside>
        </div>
      )}

      {focusOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_oklch,var(--ink)_28%,transparent)] p-6"
          role="dialog"
          aria-modal="true"
          onClick={closeFocus}
        >
          <div
            className="w-full max-w-[520px] rounded-card border border-hairline-strong bg-paper p-8 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                {focusDone
                  ? "Reply focus mode"
                  : `Thread ${focusIndex + 1} of ${total}`}
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
                  You've worked through every at-risk thread.
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
                  <p className="mb-3 font-mono text-[11px] text-risk-overdue">{focusError}</p>
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

function BurnDownBar({
  buckets,
  total
}: {
  buckets: Array<Bucket & { count: number }>;
  total: number;
}) {
  if (total === 0) return null;
  return (
    <div className="mt-3 flex h-[6px] w-full overflow-hidden rounded-full bg-paper-2">
      {buckets.map((bucket) => {
        const pct = bucket.count === 0 ? 0 : (bucket.count / total) * 100;
        if (pct === 0) return null;
        return (
          <div
            key={bucket.key}
            className={cn("h-full", bucketTone(bucket.tone))}
            style={{ width: `${pct}%` }}
            title={`${bucket.label}: ${bucket.count}`}
          />
        );
      })}
    </div>
  );
}
