"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type {
  HealthResponse,
  InboxResponse,
  InboxRow,
  OperatorProfile,
  PlatformCard,
  ThreadResponse
} from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { initials, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { normalizePreview } from "@/lib/preview";
import { isWithinHorizon } from "@/lib/horizon";
import { isLikelyClosed } from "@/lib/closed-conversation";
import { Button } from "@/components/ui/button";
import { Canvas, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { UpcomingBirthdays } from "@/components/common/upcoming-birthdays";
import { UserVoiceProfile } from "@/components/settings/UserVoiceProfile";
import { PilotWelcomeCard } from "@/components/common/pilot-welcome";
import { NotificationCta } from "@/components/common/notification-cta";
import { PilotTourInviteCard } from "@/components/common/PilotTourInviteCard";
import { PILOT_WELCOME_DISMISSED_KEY } from "@/lib/pilot";
import { isTourSeen, markTourSeen, startPilotTour } from "@/lib/pilot-tour";

// "Today" - the home. Hero card (most-overdue first) with keyboard hints
// on each action, a "queue peek" of the next few people below it, and a
// right-rail day outline tracking overdue → waiting → fresh → done.
// Greeting drops from 56px to ~32px so the screen leads with the hero,
// not the salutation. Section 05 of the redesign doc.

// Today is a focused triage queue, not the whole backlog. The "Then
// these, in order" stack renders at most this many rows; the rest stay a
// click away on /inbox (built for "every active thread"). Before the
// cap, the stack listed every reply-needed thread - dozens of rows that
// made Today feel like the entire inbox (issue #291).
const TODAY_STACK_LIMIT = 7;

interface RunnerEventDetail {
  type?: string;
  threadId?: string;
}

// Per-day "tonight's outline" progress, persisted to localStorage so the
// cleared-thread counts survive a reload instead of dropping back to zero.
// The date field still forces a fresh start at local midnight.
const TONIGHT_PROGRESS_KEY = "today_tonight_progress";

type TonightProgress = { date: string; RED: number; AMBER: number; GREEN: number };

function readTonightProgress(): TonightProgress | null {
  try {
    const raw = window.localStorage.getItem(TONIGHT_PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TonightProgress>;
    if (
      typeof parsed?.date === "string" &&
      typeof parsed.RED === "number" &&
      typeof parsed.AMBER === "number" &&
      typeof parsed.GREEN === "number"
    ) {
      return { date: parsed.date, RED: parsed.RED, AMBER: parsed.AMBER, GREEN: parsed.GREEN };
    }
  } catch {
    // Corrupt JSON or storage disabled: fall back to a fresh count.
  }
  return null;
}

function writeTonightProgress(value: TonightProgress): void {
  try {
    window.localStorage.setItem(TONIGHT_PROGRESS_KEY, JSON.stringify(value));
  } catch {
    // Storage disabled or over quota: progress just won't survive a reload.
  }
}

export default function TodayPage() {
  const router = useRouter();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [heroSummary, setHeroSummary] = useState<{ id: string; summary: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // True when the /data/inbox fetch failed outright (runner down /
  // unreachable). Without this the empty "You're caught up" state renders
  // for an unreachable runner — indistinguishable from a genuinely empty
  // inbox and quietly misleading.
  const [inboxUnavailable, setInboxUnavailable] = useState(false);
  // Operator voice profile — drives the greeting name, the first-run setup
  // card, and whether full AI drafts are predrafted. null until loaded.
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  // First-run pilot welcome card. `undefined` until localStorage is read,
  // so the card never flashes for testers who already dismissed it.
  const [welcomeDismissed, setWelcomeDismissed] = useState<boolean | undefined>(undefined);
  // First-run pilot tour invite. `undefined` until localStorage is read so
  // the card never flashes for testers who already saw or skipped it.
  const [tourSeen, setTourSeen] = useState<boolean | undefined>(undefined);
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [transitioning, setTransitioning] = useState<{ id: string; label: string } | null>(null);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-day "done" counter so the right-rail outline ticks up as the
  // operator clears overdue / waiting threads. Keyed by ISO date string
  // so it resets at local midnight.
  const [doneTodayByLevel, setDoneTodayByLevel] = useState<TonightProgress>(() => ({
    date: new Date().toDateString(),
    RED: 0,
    AMBER: 0,
    GREEN: 0
  }));

  const refresh = useCallback(async () => {
    const [inbox, platformRows, healthData] = await Promise.all([
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => [] as PlatformCard[]),
      apiGet<HealthResponse>("/runner/health").catch(() => null)
    ]);
    setInboxUnavailable(inbox === null);
    if (inbox) {
      setData(inbox);
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

  const loadProfile = useCallback(() => {
    void apiGet<OperatorProfile>("/runner/data/operator-profile")
      .then((data) => setProfile(data ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    setWelcomeDismissed(window.localStorage.getItem(PILOT_WELCOME_DISMISSED_KEY) === "1");
    setTourSeen(isTourSeen(window.localStorage));
  }, []);

  // Restore tonight's cleared-thread counts so the right-rail outline keeps
  // its progress across a reload. A stale (pre-midnight) entry is ignored.
  useEffect(() => {
    const stored = readTonightProgress();
    if (stored && stored.date === new Date().toDateString()) {
      setDoneTodayByLevel(stored);
    }
  }, []);

  // Persist whenever there's progress to save. Skipping the all-zero state
  // also stops the empty default from clobbering a restored value on mount.
  useEffect(() => {
    if (doneTodayByLevel.RED + doneTodayByLevel.AMBER + doneTodayByLevel.GREEN > 0) {
      writeTonightProgress(doneTodayByLevel);
    }
  }, [doneTodayByLevel]);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    const onRunnerEvent = (event: Event) => {
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

  const advanceHero = useCallback((id: string, label: string, level: "RED" | "AMBER" | "GREEN") => {
    setTransitioning({ id, label });
    setDoneTodayByLevel((prev) => {
      const todayKey = new Date().toDateString();
      const base = prev.date === todayKey ? prev : { date: todayKey, RED: 0, AMBER: 0, GREEN: 0 };
      return { ...base, [level]: base[level] + 1 };
    });
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
    transitionTimer.current = setTimeout(() => {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setTransitioning(null);
      void refresh();
    }, 700);
  }, [refresh]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<RunnerEventDetail>).detail;
      if (!detail || !detail.threadId) return;
      if (detail.type === "MESSAGE_SENT") {
        const matching = data?.rows.find((row) => row.id === detail.threadId);
        advanceHero(detail.threadId, "Sent, next up", matching?.riskLevel ?? "GREEN");
      }
    };
    window.addEventListener("runner-event", handler);
    return () => window.removeEventListener("runner-event", handler);
  }, [advanceHero, data?.rows]);

  useEffect(() => () => {
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
  }, []);

  const allRows = data?.rows ?? [];
  // Today is the "tonight's work" view. Two filters narrow the runner's
  // raw needs-reply set into things that genuinely need the operator
  // tonight (issue #287):
  //   - Recency horizon (phase 1): dormant threads drop out so a year of
  //     history does not flood the hero queue.
  //   - Closed-conversation heuristic (phase 2): threads that already
  //     wrapped on a "thanks" / "talk soon" are set aside so the operator
  //     is not nudged to reply to closing messages.
  // Both filters are conservative: anything reachable from the Inbox
  // "show all" toggle still appears there, and a new inbound message
  // immediately pulls a thread back into Today.
  const rows = useMemo(
    () =>
      allRows.filter(
        (row) =>
          row.needsReply !== false &&
          !row.scheduledSendAt &&
          !removedIds.has(row.id) &&
          isWithinHorizon(row.lastMessageAt) &&
          !isLikelyClosed(row)
      ),
    [allRows, removedIds]
  );
  const overdueCount = rows.filter((row) => row.riskLevel === "RED").length;
  const waitingCount = rows.filter((row) => row.riskLevel === "AMBER").length;
  const freshCount = rows.filter((row) => row.riskLevel === "GREEN").length;

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
  // Cap the "Then these, in order" stack; the long tail routes to Inbox.
  // overflowCount drives the "see all" link's label. (issue #291)
  const visibleRemaining = useMemo(
    () => remaining.slice(0, TODAY_STACK_LIMIT),
    [remaining]
  );
  const overflowCount = remaining.length - visibleRemaining.length;
  const queuePeek = useMemo(() => remaining.slice(0, 3), [remaining]);
  const queueRemaining = Math.max(0, remaining.length - queuePeek.length);
  const queueEtaMinutes = remaining.length > 0 ? Math.max(1, remaining.length * 2) : 0;
  const degraded = platforms.find((p) => p.status === "DEGRADED");

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

  // Background-predraft the top 3 threads — but only when the user has
  // opted into full AI drafts. At lower help levels the dashboard never
  // surfaces a complete draft, so generating one would be wasted work.
  const top3Ids = useMemo(() => rows.slice(0, 3).map((row) => row.id).join("|"), [rows]);
  const fullDrafts = profile?.aiHelpLevel === "full_drafts";
  useEffect(() => {
    if (!top3Ids || !fullDrafts) return;
    const ids = top3Ids.split("|").filter(Boolean);
    for (const id of ids) {
      void apiPost<{ status: string }>(`/runner/control/thread/${id}/predraft`, {}).catch(() => undefined);
    }
  }, [top3Ids, fullDrafts]);

  // R / S / E keyboard hints on the hero. Active when the hero is
  // visible and no input is focused. Esc behaviour stays owned by
  // app-shell (close palette / leave thread).
  const heroRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hero) return;
    const isTextTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return target.isContentEditable;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "r" || key === "enter") {
        event.preventDefault();
        router.push(`/thread/${hero.id}`);
      } else if (key === "s") {
        event.preventDefault();
        const id = hero.id;
        const level = hero.riskLevel;
        runAction(apiPost(`/runner/control/thread/${id}/snooze`, { hours: 16 }), setError, refresh);
        advanceHero(id, "Snoozed, next up", level);
      } else if (key === "e") {
        event.preventDefault();
        const id = hero.id;
        const level = hero.riskLevel;
        runAction(apiPost(`/runner/control/thread/${id}/mark-done`, {}), setError, refresh);
        advanceHero(id, "Handled, next up", level);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hero, router, advanceHero, refresh]);

  // Right-rail outline rows jump to the first live thread of their risk
  // level: the hero when it matches, otherwise its row in the queue below.
  const jumpToLevel = useCallback(
    (level: "RED" | "AMBER" | "GREEN") => {
      if (hero?.riskLevel === level) {
        // The page scrolls inside app-shell's <main>, not the window, so
        // jump to the hero by returning that container to the top.
        heroRef.current?.closest("main")?.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const target = visibleRemaining.find((row) => row.riskLevel === level);
      if (target) {
        document
          .getElementById(`today-row-${target.id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      // All live threads of this level are beyond the visible cap, so
      // send the operator to the "see all" link to find them in Inbox.
      document
        .querySelector('[data-testid="today-overflow-link"]')
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [hero, visibleRemaining]
  );

  const today = new Date();
  const dayLabel = today.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
  const hour = today.getHours();
  const greeting =
    hour < 5 ? "Late evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  // Greet by the configured name when set; a bare greeting otherwise — the
  // app no longer assumes who the user is.
  const operatorName = profile?.displayName?.trim() ?? "";
  const greetingLine = operatorName ? `${greeting}, ${operatorName}.` : `${greeting}.`;
  const needsSetup = profile !== null && !profile.setupCompletedAt;

  const heroRisk = hero ? toDisplayRisk(hero.riskLevel) : null;
  const heroLabel = !hero
    ? ""
    : heroRisk === "overdue"
      ? `${PLATFORM_LABEL[hero.platform]} · waiting ${formatRelative(hero.lastInboundAt)}`
      : heroRisk === "waiting"
        ? `${PLATFORM_LABEL[hero.platform]} · waiting ${formatRelative(hero.lastInboundAt)}`
        : `${PLATFORM_LABEL[hero.platform]} · ${formatRelative(hero.lastInboundAt)}`;

  const heroHeadlineRaw =
    heroSummary && heroSummary.id === hero?.id && heroSummary.summary
      ? heroSummary.summary
      : normalizePreview(hero?.preview);
  const heroHeadline = (() => {
    if (!heroHeadlineRaw) return "";
    const trimmed = heroHeadlineRaw.trim();
    if (trimmed.length <= 120) return trimmed;
    const cut = trimmed.slice(0, 120);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim();
  })();
  const heroIsTransitioning = transitioning && hero && transitioning.id === hero.id;

  // Right-rail day outline: progress against today's three live buckets
  // plus a fourth Done/sleep step that lights once everything is handled.
  const todayKey = new Date().toDateString();
  const cleared =
    doneTodayByLevel.date === todayKey
      ? doneTodayByLevel
      : { date: todayKey, RED: 0, AMBER: 0, GREEN: 0 };
  const totalRed = overdueCount + cleared.RED;
  const totalAmber = waitingCount + cleared.AMBER;
  const totalGreen = freshCount + cleared.GREEN;
  const overduePct = totalRed === 0 ? 0 : (cleared.RED / totalRed) * 100;
  const waitingPct = totalAmber === 0 ? 0 : (cleared.AMBER / totalAmber) * 100;
  const freshPct = totalGreen === 0 ? 0 : (cleared.GREEN / totalGreen) * 100;
  const allDone =
    rows.length === 0 && (cleared.RED + cleared.AMBER + cleared.GREEN) > 0;

  return (
    <Canvas className="max-w-[1240px] pb-10">
      <header className="sticky top-0 z-10 -mx-12 mb-6 flex items-baseline justify-between gap-6 bg-[color-mix(in_oklch,var(--paper)_95%,transparent)] px-12 pb-3 pt-6 backdrop-blur-md backdrop-saturate-150">
        <div className="min-w-0">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            {dayLabel}
          </p>
          <h1 className="m-0 font-display text-[32px] font-semibold leading-[1.1] tracking-[-0.025em]">
            {greetingLine}
          </h1>
        </div>
        <div className="shrink-0 text-right font-mono text-[12px] text-ink-3">
          <span>
            <strong className="font-medium text-ink">{rows.length}</strong> need you tonight
          </span>
          <br />
          last scan {health ? formatRelative(health.lastScanAt) : "never"}
        </div>
      </header>

      <NotificationCta />

      {welcomeDismissed === false ? (
        <PilotWelcomeCard
          onDismiss={() => {
            window.localStorage.setItem(PILOT_WELCOME_DISMISSED_KEY, "1");
            setWelcomeDismissed(true);
          }}
        />
      ) : null}

      {welcomeDismissed === true && tourSeen === false ? (
        <PilotTourInviteCard
          onStart={() => {
            // The PilotTour component (mounted in AppShell) listens for
            // this event and drives the sandbox + walkthrough.
            startPilotTour();
          }}
          onSkip={() => {
            markTourSeen(window.localStorage);
            setTourSeen(true);
          }}
        />
      ) : null}

      {needsSetup ? (
        <div data-testid="voice-setup-card" className="mb-8">
          <UserVoiceProfile variant="onboarding" onCompleted={loadProfile} />
        </div>
      ) : null}

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

      <div className="grid min-h-[calc(100vh-140px)] grid-cols-1 gap-8 lg:grid-cols-[1fr_260px]">
        {/* Hero column */}
        <div className="flex flex-col">
          {hero ? (
            <article
              ref={heroRef}
              data-testid="today-hero"
              data-demo-target="today-hero"
              className={`relative mb-4 flex min-h-[300px] cursor-pointer flex-col overflow-hidden rounded-card border border-hairline bg-paper px-10 pb-9 pt-10 shadow-card transition-opacity duration-500 ${heroIsTransitioning ? "opacity-50" : "opacity-100"}`}
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
              <div className="relative flex flex-col">
                <p className="mb-[20px] flex items-center gap-[10px] font-mono text-[11px] uppercase tracking-[0.08em] text-accent-ink">
                  <span className="inline-block h-[6px] w-[6px] rounded-full bg-accent" />
                  {heroIsTransitioning ? transitioning?.label ?? "First up" : `First up · 1 of ${rows.length}`}
                </p>
                {/* #348: line-clamp-3 caps the hero at 3 lines. The
                    36px display type inside a 22ch container can grow
                    to 5+ tall lines when the bound source (whatTheyWant
                    / preview) runs long, which dominates the card and
                    pushes the message preview, action row and queue
                    counter below the fold. The prompt cap (runner side)
                    is the primary fix; this is the visual safety net so
                    legacy long content stays readable. */}
                <h2 className="m-0 mb-[14px] line-clamp-3 max-w-[22ch] text-balance font-display text-[36px] font-semibold leading-[1.15] tracking-[-0.025em]">
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
                  <span className="font-mono text-[12px] text-ink-3">{heroLabel}</span>
                </div>
                <p className="m-0 mb-7 max-w-[68ch] text-balance border-l-2 border-hairline-strong pl-5 text-[17px] leading-[1.55] text-ink-2">
                  {normalizePreview(hero.preview)}
                </p>
                <div
                  className="relative flex flex-wrap items-center gap-[10px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Button
                    variant="primary"
                    onClick={() => router.push(`/thread/${hero.id}`)}
                    className="gap-3"
                  >
                    Open &amp; reply
                    <KbHint label="↵" tone="primary" />
                  </Button>
                  <Button
                    variant="ghost"
                    className="gap-3"
                    onClick={() => {
                      const id = hero.id;
                      const level = hero.riskLevel;
                      runAction(
                        apiPost(`/runner/control/thread/${id}/snooze`, { hours: 16 }),
                        setError,
                        refresh
                      );
                      advanceHero(id, "Snoozed, next up", level);
                    }}
                  >
                    Snooze ’til tomorrow
                    <KbHint label="S" />
                  </Button>
                  <Button
                    variant="ghost"
                    className="gap-3"
                    onClick={() => {
                      const id = hero.id;
                      const level = hero.riskLevel;
                      runAction(
                        apiPost(`/runner/control/thread/${id}/mark-done`, {}),
                        setError,
                        refresh
                      );
                      advanceHero(id, "Handled, next up", level);
                    }}
                  >
                    Mark handled
                    <KbHint label="E" />
                  </Button>
                </div>

                {queuePeek.length > 0 ? (
                  <div className="mt-[22px] flex items-center gap-[14px] border-t border-hairline pt-[18px] font-mono text-[11px] text-ink-3">
                    <span>after this</span>
                    <span className="flex">
                      {queuePeek.map((row, i) => (
                        <PeekAvatar
                          key={row.id}
                          name={row.personName}
                          avatarUrl={row.personAvatarUrl}
                          offset={i}
                        />
                      ))}
                    </span>
                    <span className="truncate">
                      {queuePeek.map((row) => row.personName.split(" ")[0]).join(" · ")}
                    </span>
                    {queueRemaining > 0 ? (
                      <span className="ml-auto">
                        {queueRemaining} more · ~{queueEtaMinutes} min
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </article>
          ) : loaded && inboxUnavailable && !data ? (
            <CaughtUp
              title="Can’t reach the runner."
              body="The runner isn’t responding. Once it’s back, this page fills in on the next scan."
            />
          ) : loaded ? (
            <CaughtUp title="You’re caught up." body="Nothing else needs you tonight." />
          ) : (
            <p className="font-mono text-[12px] text-ink-3">Loading…</p>
          )}

          {remaining.length > 0 ? (
            <>
              <div className="mb-[14px] mt-10 flex items-baseline justify-between px-1">
                <h3 className="m-0 font-display text-[19px] font-semibold tracking-[-0.018em]">
                  Then these, in order
                </h3>
                <span className="font-mono text-[12px] text-ink-3">{remaining.length} waiting</span>
              </div>
              <div className="flex flex-col">
                {visibleRemaining.map((row) => (
                  <ThreadRow key={row.id} row={row} id={`today-row-${row.id}`} />
                ))}
                {overflowCount > 0 ? (
                  <Link
                    href="/inbox"
                    data-testid="today-overflow-link"
                    className="group flex items-center justify-between border-b border-t border-hairline px-1 py-[18px] transition-colors duration-calm hover:bg-paper-2"
                  >
                    <span className="text-[14px] text-ink-2 transition-colors duration-calm group-hover:text-ink">
                      + {overflowCount} more waiting
                    </span>
                    <span className="font-mono text-[12px] tracking-[-0.005em] text-ink-3 transition-colors duration-calm group-hover:text-ink">
                      See all in Inbox →
                    </span>
                  </Link>
                ) : null}
              </div>
            </>
          ) : hero && loaded ? (
            <CaughtUp title="That’s the only one." body="Reply to it and you’re done." />
          ) : null}
        </div>

        {/* Right rail: day outline */}
        <aside className="hidden lg:block">
          <div className="sticky top-[110px] rounded-[16px] border border-hairline bg-paper p-[18px]">
            <h5 className="m-0 mb-[14px] font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-ink-3">
              Tonight’s outline
            </h5>
            <ul className="m-0 flex list-none flex-col gap-[11px] p-0 text-[12.5px] text-ink-2">
              <OutlineRow
                label="Overdue"
                done={cleared.RED}
                total={totalRed}
                pct={overduePct}
                tone="overdue"
                liveCount={overdueCount}
                onJump={() => jumpToLevel("RED")}
              />
              <OutlineRow
                label="Waiting on you"
                done={cleared.AMBER}
                total={totalAmber}
                pct={waitingPct}
                tone="waiting"
                liveCount={waitingCount}
                onJump={() => jumpToLevel("AMBER")}
              />
              <OutlineRow
                label="Fresh, no rush"
                done={cleared.GREEN}
                total={totalGreen}
                pct={freshPct}
                tone="fresh"
                liveCount={freshCount}
                onJump={() => jumpToLevel("GREEN")}
              />
              <li className={`flex items-center gap-[10px] ${allDone ? "" : "opacity-50"}`}>
                <span
                  className={`inline-block h-[8px] w-[8px] rounded-full ${allDone ? "bg-risk-fresh" : "bg-hairline-strong"}`}
                />
                <span className="relative block h-[3px] w-[28px] overflow-hidden rounded-[2px] bg-hairline">
                  {allDone ? <span className="absolute inset-0 bg-risk-fresh" /> : null}
                </span>
                <span>Done · sleep</span>
                <span className="ml-auto font-mono text-[10px] text-ink-4">{allDone ? "✓" : "-"}</span>
              </li>
            </ul>
          </div>
          {/* Upcoming birthdays sits below the day outline so the right
              rail keeps its rhythm: today's work, then a soft reminder of
              who has a birthday coming up. The component renders nothing
              when the runner has no upcoming birthdays. */}
          <div className="mt-[14px]">
            <UpcomingBirthdays />
          </div>
        </aside>
      </div>
    </Canvas>
  );
}

function OutlineRow({
  label,
  done,
  total,
  pct,
  tone,
  liveCount,
  onJump
}: {
  label: string;
  done: number;
  total: number;
  pct: number;
  tone: "overdue" | "waiting" | "fresh";
  liveCount: number;
  onJump: () => void;
}) {
  const fillClass =
    tone === "overdue" ? "bg-risk-overdue" : tone === "waiting" ? "bg-risk-waiting" : "bg-risk-fresh";
  const inner = (
    <>
      <span className={`inline-block h-[8px] w-[8px] rounded-full ${fillClass}`} />
      <span className="relative block h-[3px] w-[28px] overflow-hidden rounded-[2px] bg-hairline">
        <span className={`absolute inset-y-0 left-0 ${fillClass}`} style={{ width: `${pct}%` }} />
      </span>
      <span>{label}</span>
      <span className="ml-auto font-mono text-[10px] text-ink-4">
        {done}/{total}
      </span>
    </>
  );
  // No live threads of this level: nothing to jump to, so render it inert.
  if (liveCount === 0) {
    return <li className="flex items-center gap-[10px]">{inner}</li>;
  }
  return (
    <li className="-mx-[8px]">
      <button
        type="button"
        onClick={onJump}
        title={`Jump to ${label.toLowerCase()}`}
        className="flex w-full items-center gap-[10px] rounded-[8px] px-[8px] py-[4px] text-left text-ink-2 transition-colors duration-calm hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {inner}
      </button>
    </li>
  );
}

function PeekAvatar({
  name,
  avatarUrl,
  offset
}: {
  name: string;
  avatarUrl?: string | null;
  offset: number;
}) {
  if (avatarUrl) {
    return (
      <span
        className="grid h-[22px] w-[22px] place-items-center overflow-hidden rounded-full border-2 border-paper bg-paper-2"
        style={{ marginLeft: offset === 0 ? 0 : -6 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl}
          alt=""
          width={22}
          height={22}
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  return (
    <span
      className="grid h-[22px] w-[22px] place-items-center rounded-full border-2 border-paper bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[9.5px] font-semibold text-white"
      style={{ marginLeft: offset === 0 ? 0 : -6 }}
    >
      {initials(name)}
    </span>
  );
}

function KbHint({ label, tone = "ghost" }: { label: string; tone?: "primary" | "ghost" }) {
  return (
    <span
      aria-hidden
      className={`inline-flex items-center font-mono text-[10px] ${
        tone === "primary" ? "text-paper/70" : "text-ink-3"
      }`}
    >
      <span
        className={`rounded-[4px] border px-[5px] py-[1px] ${
          tone === "primary" ? "border-paper/30 text-paper" : "border-hairline text-ink-3"
        }`}
      >
        {label}
      </span>
    </span>
  );
}
