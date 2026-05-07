"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { Button } from "@/components/ui/button";
import { PLATFORM_LABEL } from "@/lib/risk";

// At-risk = inbox filtered to overdue + waiting. Same shell as Inbox; we
// just drop the "fresh" bucket. Adds Reply Focus Mode (one-thread-at-a-time
// modal) and a "Why they're at risk" aggregation grouped by floor(waitHours).
export default function AtRiskPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusError, setFocusError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    const inbox = await apiGet<InboxResponse>("/runner/data/inbox").catch(() => null);
    if (inbox) setData(inbox);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  const rows = data?.rows ?? [];
  const overdue = useMemo(() => rows.filter((r) => r.riskLevel === "RED"), [rows]);
  const waiting = useMemo(() => rows.filter((r) => r.riskLevel === "AMBER"), [rows]);
  const atRisk = useMemo(() => [...overdue, ...waiting], [overdue, waiting]);
  const total = atRisk.length;

  // "Why they're at risk" — bucket by floor(waitHours). waitHours is derived
  // from lastInboundAt (we only count threads where the operator owes a reply,
  // so lastInboundAt is the right anchor). Fall back to lastMessageAt for
  // legacy rows that haven't been re-synced yet.
  const reasonBuckets = useMemo(() => {
    const map = new Map<number, number>();
    const now = Date.now();
    for (const row of atRisk) {
      const ts = row.lastInboundAt ?? row.lastMessageAt;
      if (!ts) continue;
      const parsed = new Date(ts).getTime();
      if (Number.isNaN(parsed)) continue;
      const hours = Math.max(0, Math.floor((now - parsed) / (60 * 60 * 1_000)));
      map.set(hours, (map.get(hours) ?? 0) + 1);
    }
    return Array.from(map.entries())
      .map(([hours, count]) => ({ hours, count }))
      .sort((a, b) => b.hours - a.hours);
  }, [atRisk]);

  const focusThread: InboxRow | undefined = atRisk[focusIndex];
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
    advance();
  };

  return (
    <Canvas>
      <PageHead
        eyebrow="Needs you"
        title="At risk."
        meta={
          <div className="flex items-center justify-end gap-4">
            <span>
              <span className="text-ink">{overdue.length}</span> overdue ·{" "}
              <span className="text-ink">{waiting.length}</span> waiting
            </span>
            {total > 0 ? (
              <Button variant="quiet" onClick={openFocus} className="px-[14px] py-[7px] text-[12px]">
                reply focus mode
              </Button>
            ) : null}
          </div>
        }
      />

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : total === 0 ? (
        <CaughtUp title="You’re caught up." body="Nothing is at risk right now." />
      ) : (
        <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_240px]">
          <div>
            {overdue.length ? (
              <section>
                <SectionDivider label="Overdue — they’ve waited longest" />
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

          {reasonBuckets.length ? (
            <aside className="lg:pt-[18px]">
              <SectionDivider label="Why they’re at risk" />
              <div className="flex flex-col">
                {reasonBuckets.map((bucket) => (
                  <div
                    key={bucket.hours}
                    className="flex items-center justify-between border-t border-hairline px-1 py-[14px] last:border-b last:border-hairline"
                  >
                    <span className="text-[13px] text-ink-2">
                      Inbound waiting {bucket.hours}h
                    </span>
                    <span className="font-mono text-[12px] text-ink-3">{bucket.count}</span>
                  </div>
                ))}
              </div>
            </aside>
          ) : null}
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
                  You’ve worked through every at-risk thread.
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
                    ? `You: ${focusThread.preview}`
                    : focusThread.preview}
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
