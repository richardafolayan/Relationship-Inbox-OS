"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { HealthResponse, InboxResponse, PlatformCard, ThreadResponse } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { initials, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { normalizePreview } from "@/lib/preview";
import { Button } from "@/components/ui/button";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";

// "Today" — the new home. One hero card naming the most-overdue
// conversation in plain English, then a quiet ranked stack of the rest.
// No KPIs. No filter chips above the fold. The runner already sorts the
// inbox; we just take row[0] as "first up".
//
// The hero's headline prefers the AI summary of the top thread (fetched
// via /runner/data/thread/:id when the inbox row arrives). If that fails
// or hasn't loaded yet, we fall back to the actual preview text — never
// the technical riskReason ("Inbound waiting Xh"), which is operator-
// facing telemetry, not the human ask.

interface RunnerEventDetail {
  type?: string;
  threadId?: string;
}

export default function TodayPage() {
  const router = useRouter();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [heroSummary, setHeroSummary] = useState<{ id: string; summary: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // IDs we've optimistically removed from the local view because the
  // operator just acted on them (sent / handled / snoozed) — server
  // hasn't necessarily caught up yet. Cleared on every refetch.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  // Brief "Sent — next up" overlay for the outgoing hero.
  const [transitioning, setTransitioning] = useState<{ id: string; label: string } | null>(null);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const [inbox, platformRows, healthData] = await Promise.all([
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => [] as PlatformCard[]),
      apiGet<HealthResponse>("/runner/health").catch(() => null)
    ]);
    if (inbox) {
      setData(inbox);
      // Drop only the optimistic IDs the server has caught up on. A row
      // counts as "still pending" when it's both present AND still needs
      // a reply — so a mark-done / snooze that flips needsReply=false
      // counts as confirmed even though the row itself lingers in the
      // inbox view (the existing /data/inbox sort returns marked-done
      // rows for archive context).
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
    }
    setPlatforms(platformRows ?? []);
    if (healthData) setHealth(healthData);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    const onRunnerEvent = (event: Event) => {
      // Today's "first up" hero must drop a thread the moment the operator
      // replies to it. Without this, MESSAGE_SENT only updates the thread
      // page; Today keeps pinning the just-replied conversation at the top
      // until the next 8s status-bar tick coincidentally triggers a refresh
      // through some other path.
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      const type = detail?.type;
      if (
        type === "MESSAGE_SENT" ||
        type === "MESSAGE_SEND_FAILED" ||
        type === "THREAD_UPDATED" ||
        type === "SCAN_FINISHED"
      ) {
        void refresh();
      }
    };
    window.addEventListener("runner-resync", onResync);
    window.addEventListener("runner-event", onRunnerEvent as EventListener);
    return () => {
      window.removeEventListener("runner-resync", onResync);
      window.removeEventListener("runner-event", onRunnerEvent as EventListener);
    };
  }, [refresh]);

  const advanceHero = useCallback((id: string, label: string) => {
    setTransitioning({ id, label });
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
    transitionTimer.current = setTimeout(() => {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setTransitioning(null);
      // Refetch in the background so server truth catches up. If the
      // runner hasn't yet confirmed (e.g. mark-done in flight), the
      // refetch may briefly bring the row back — that's correct
      // behaviour and matches receipts-first design.
      void refresh();
    }, 700);
  }, [refresh]);

  // Listen for runner-side confirmations. MESSAGE_SENT means the platform
  // accepted the reply; that thread is no longer "first up". THREAD_UPDATED
  // covers snooze/mark-done that other clients trigger.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<RunnerEventDetail>).detail;
      if (!detail || !detail.threadId) return;
      if (detail.type === "MESSAGE_SENT") {
        advanceHero(detail.threadId, "Sent — next up");
      }
    };
    window.addEventListener("runner-event", handler);
    return () => window.removeEventListener("runner-event", handler);
  }, [advanceHero]);

  useEffect(() => () => {
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
  }, []);

  const allRows = data?.rows ?? [];
  // /today is the "first up" page; rows that no longer need a reply
  // (mark-done, send-confirmed, or runner-confirmed truthy=false) shouldn't
  // be the hero even if the runner keeps them in /data/inbox for archive
  // context. The strict `!== false` form includes legacy rows where the
  // field is undefined; the optimistic-removal Set covers in-flight actions.
  // scheduledSendAt presence means the operator already queued a reply —
  // suppress until the schedule fires (row vanishes naturally) or is
  // cancelled (scheduledSendAt clears, row returns).
  const rows = useMemo(
    () =>
      allRows.filter(
        (row) => row.needsReply !== false && !row.scheduledSendAt && !removedIds.has(row.id)
      ),
    [allRows, removedIds]
  );
  const overdueCount = rows.filter((row) => row.riskLevel === "RED").length;
  const waitingCount = rows.filter((row) => row.riskLevel === "AMBER").length;

  // Within the needs-reply set, surface the most-overdue conversation
  // first. The runner sorts the inbox by lastMessageAt-desc which would
  // otherwise put a reply that just came in (fresh, GREEN) ahead of a
  // months-old overdue thread.
  const sortedRows = useMemo(() => {
    const rank = (level: string) => (level === "RED" ? 0 : level === "AMBER" ? 1 : 2);
    return [...rows].sort((a, b) => {
      if (rank(a.riskLevel) !== rank(b.riskLevel)) {
        return rank(a.riskLevel) - rank(b.riskLevel);
      }
      const aIn = a.lastInboundAt ? Date.parse(a.lastInboundAt) : 0;
      const bIn = b.lastInboundAt ? Date.parse(b.lastInboundAt) : 0;
      return aIn - bIn;
    });
  }, [rows]);
  const hero = sortedRows[0];
  const remaining = useMemo(() => sortedRows.slice(1), [sortedRows]);
  const degraded = platforms.find((p) => p.status === "DEGRADED");

  // Prefetch the hero thread to grab its AI summary for the headline.
  // This is the one place the spec calls for "AI-summarized one-line
  // ask" rather than the raw preview.
  useEffect(() => {
    if (!hero) {
      setHeroSummary(null);
      return;
    }
    if (heroSummary?.id === hero.id) return;
    void apiGet<ThreadResponse>(`/runner/data/thread/${hero.id}`)
      .then((t) => setHeroSummary({ id: hero.id, summary: t.whatTheyWant?.trim() || t.summary?.trim() || null }))
      .catch(() => setHeroSummary({ id: hero.id, summary: null }));
  }, [hero, heroSummary?.id]);

  // Pre-warm AI suggested replies for the top 3 rows so opening any of
  // them shows AI suggestions instantly. The runner endpoint is
  // idempotent: re-fires for an unchanged thread are cheap (cache hit
  // returns immediately, no AI call). Bounded to 3 to keep token spend
  // proportional to what an operator can plausibly act on in one
  // session.
  const top3Ids = useMemo(() => rows.slice(0, 3).map((row) => row.id).join("|"), [rows]);
  useEffect(() => {
    if (!top3Ids) return;
    const ids = top3Ids.split("|").filter(Boolean);
    for (const id of ids) {
      void apiPost<{ status: string }>(`/runner/control/thread/${id}/predraft`, {}).catch(() => {
        // Best-effort warmup. A failure just means the operator pays
        // the AI latency on first open; the existing flow handles that.
      });
    }
  }, [top3Ids]);

  const today = new Date();
  const dayLabel = today.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
  const hour = today.getHours();
  const greeting =
    hour < 5 ? "Late evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  const heroRisk = hero ? toDisplayRisk(hero.riskLevel) : null;
  const heroLabel = !hero
    ? ""
    : heroRisk === "overdue"
      ? `overdue · ${formatRelative(hero.lastInboundAt)}`
      : heroRisk === "waiting"
        ? `waiting · ${formatRelative(hero.lastInboundAt)}`
        : `fresh · ${formatRelative(hero.lastInboundAt)}`;

  // Hero headline: AI summary if we got one, otherwise the latest
  // preview as a stand-in. Truncate to the first sentence and cap at
  // ~100 chars so the 36px display type doesn't waterfall down the
  // hero card. Strip a trailing period for cleaner type.
  const heroHeadlineRaw =
    heroSummary && heroSummary.id === hero?.id && heroSummary.summary
      ? heroSummary.summary
      : normalizePreview(hero?.preview);
  const heroHeadline = (() => {
    if (!heroHeadlineRaw) return "";
    const firstSentence = heroHeadlineRaw.split(/(?<=[.!?])\s+/)[0] ?? heroHeadlineRaw;
    const trimmed = firstSentence.replace(/[.!?]\s*$/, "").trim();
    if (trimmed.length <= 110) return trimmed;
    // Hard cap with an ellipsis so a single run-on sentence still fits.
    const cut = trimmed.slice(0, 107);
    const lastSpace = cut.lastIndexOf(" ");
    return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim()}…`;
  })();

  const heroIsTransitioning = transitioning && hero && transitioning.id === hero.id;

  return (
    <Canvas>
      <PageHead
        eyebrow={dayLabel}
        title={`${greeting}, Richard`}
        subtitle="One thing at a time. Reply, snooze, or handle — and Today moves on to the next."
        meta={
          <>
            <span className="text-ink">{overdueCount}</span> overdue ·{" "}
            <span className="text-ink">{waitingCount}</span> waiting
            <br />
            last scan {health ? formatRelative(health.lastScanAt) : "—"}
          </>
        }
      />

      {degraded ? (
        <DegradedBanner
          platform={degraded.platform}
          stage={degraded.lastScanFailure?.stage}
          reason={degraded.lastScanFailure?.reason}
          requestId={degraded.lastScanFailure?.requestId}
          errorSummary={degraded.lastScanFailure?.errorSummary ?? degraded.lastError ?? undefined}
          screenshotFile={degraded.lastScanFailure?.screenshotFile}
          domDumpFile={degraded.lastScanFailure?.domDumpFile}
          onRunSelectorTests={() =>
            runAction(
              apiPost("/runner/control/platform/test-selectors", { platform: degraded.platform }),
              setError,
              refresh
            )
          }
        />
      ) : null}

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {hero ? (
        <article
          data-testid="today-hero"
          className={`relative mb-12 cursor-pointer overflow-hidden rounded-card border border-hairline bg-paper px-9 pb-7 pt-9 shadow-card transition-opacity duration-500 ${heroIsTransitioning ? "opacity-50" : "opacity-100"}`}
          onClick={() => router.push(`/thread/${hero.id}`)}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(ellipse at 100% 0%, color-mix(in oklch, var(--accent) 12%, transparent), transparent 55%)"
            }}
          />
          <div className="relative">
            <p className="mb-[22px] flex items-center gap-[10px] font-mono text-[11px] uppercase tracking-[0.08em] text-accent-ink">
              <span className="inline-block h-[6px] w-[6px] rounded-full bg-accent" />
              {heroIsTransitioning ? transitioning?.label ?? "First up" : "First up"}
            </p>
            <h2 className="m-0 mb-[14px] max-w-[22ch] text-balance font-display text-[36px] font-semibold leading-[1.15] tracking-[-0.025em]">
              {heroHeadline || "Catching up with someone"}
            </h2>
            <div className="mb-[18px] flex items-center gap-3">
              {hero.personAvatarUrl ? (
                <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-full bg-paper-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={hero.personAvatarUrl}
                    alt=""
                    width={28}
                    height={28}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                </span>
              ) : (
                <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[11px] font-semibold text-white">
                  {initials(hero.personName)}
                </span>
              )}
              <span className="font-medium text-ink">{hero.personName}</span>
              <span className="font-mono text-[12px] text-ink-3">
                {PLATFORM_LABEL[hero.platform]} · {heroLabel}
              </span>
            </div>
            <p className="m-0 mb-7 max-w-[58ch] text-balance border-l-2 border-hairline-strong pl-4 text-[17px] leading-[1.55] text-ink-2">
              {normalizePreview(hero.preview)}
            </p>
            <div
              className="relative flex items-center gap-[10px]"
              onClick={(event) => event.stopPropagation()}
            >
              <Button variant="primary" onClick={() => router.push(`/thread/${hero.id}`)}>
                Open & reply
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  const id = hero.id;
                  runAction(
                    apiPost(`/runner/control/thread/${id}/snooze`, { hours: 16 }),
                    setError,
                    refresh
                  );
                  advanceHero(id, "Snoozed — next up");
                }}
              >
                Snooze ’til tomorrow
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  const id = hero.id;
                  runAction(
                    apiPost(`/runner/control/thread/${id}/mark-done`, {}),
                    setError,
                    refresh
                  );
                  advanceHero(id, "Handled — next up");
                }}
              >
                Mark as handled
              </Button>
            </div>
          </div>
        </article>
      ) : loaded ? (
        <CaughtUp title="You’re caught up." body="Nothing else needs you tonight." />
      ) : (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      )}

      {remaining.length > 0 ? (
        <>
          <div className="mb-[14px] mt-0 flex items-baseline justify-between px-1">
            <h3 className="m-0 font-display text-[19px] font-semibold tracking-[-0.018em]">
              Then these, in order
            </h3>
            <span className="font-mono text-[12px] text-ink-3">{remaining.length} left</span>
          </div>
          <div className="flex flex-col">
            {remaining.map((row) => (
              <ThreadRow key={row.id} row={row} />
            ))}
          </div>
        </>
      ) : hero && loaded ? (
        <CaughtUp title="That’s the only one." body="Reply to it and you’re done." />
      ) : null}
    </Canvas>
  );
}
