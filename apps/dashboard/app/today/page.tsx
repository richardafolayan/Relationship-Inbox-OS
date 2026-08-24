"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useFullDemo } from "@/components/full-demo/FullDemoProvider";
import { scopeRowsToSandbox } from "@/lib/demo-threads";
import Link from "next/link";
import { apiGet, apiPost, runAction } from "@/lib/api";
import { useCacheSeed } from "@/lib/use-cache-seed";
import { prefetchThreadDataNow } from "@/lib/thread-prefetch";
import type {
  HealthResponse,
  InboxResponse,
  InboxRow,
  OperatorProfile,
  PlatformCard,
  ThreadResponse
} from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { isDegradedAndInUse, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { cleanAskSummary, normalizePreview } from "@/lib/preview";
import { isInTodayQueue, sortTodayQueue } from "@/lib/today";
import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Canvas, CaughtUp } from "@/components/common/canvas";
import { FitText } from "@/components/common/fit-text";
import { ThreadRow } from "@/components/common/thread-row";
import { BrandLoader } from "@/components/common/brand-loader";
import { PersonAvatar } from "@/components/common/person-avatar";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { UpcomingBirthdays } from "@/components/common/upcoming-birthdays";
import { UserVoiceProfile } from "@/components/settings/UserVoiceProfile";
import { PilotWelcomeCard } from "@/components/common/pilot-welcome";
import { FocusRailCard } from "@/components/common/focus/focus-rail-card";
import { NotificationCta } from "@/components/common/notification-cta";
import { PilotTourInviteCard } from "@/components/common/PilotTourInviteCard";
import { PILOT_WELCOME_DISMISSED_KEY } from "@/lib/pilot";
import { isTourSeen, markTourSeen, startPilotTour } from "@/lib/pilot-tour";
import {
  GUIDED_TOUR_SURFACE_EVENT,
  isGuidedTourSurfaceActive,
  resolveFrozenListRows,
  type GuidedTourSurfaceDetail
} from "@/lib/guided-tour";

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

// Metadata on the Today surface is space-separated — no glyph between items
// (the redesign's saved default: not "·", not "|"). A double non-breaking
// space keeps a legible gap inside the single text nodes (hero eyebrow,
// hero meta, queue peek) where a flex gap isn't available; the list-row
// tags rely on their flex gap instead.
const META_SEP = "  ";

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

// Hydration-safe clock text (R-0106 / #824). The prod build statically
// prerenders this page, so computing the date line / greeting from
// `new Date()` during render bakes BUILD-time text into the HTML; at
// hydration the client clock disagrees and React throws minified #418
// ("server rendered text didn't match"). useSyncExternalStore renders the
// server snapshot (empty) during SSR + hydration by construction, then the
// post-hydration pass fills the live value; client-side navigations are not
// hydration, so they paint the clock on first render with no flash.
const subscribeClockNever = () => () => {};
function clockTextSnapshot(): string {
  const now = new Date();
  const dayLabel = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long"
  });
  const hour = now.getHours();
  const greeting =
    hour < 5 ? "Late evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  // Joined into one string because getSnapshot results are compared with
  // Object.is — a fresh object every call would loop. Stable within the hour.
  return `${dayLabel}|${greeting}`;
}

export default function TodayPage() {
  const router = useRouter();
  // Seed from the shared client cache so revisiting Today (e.g. back from a
  // thread) paints the last-known queue instantly instead of a blank skeleton,
  // then revalidates in the background. Read via useCacheSeed (NOT a useState
  // initializer): the app shell's effects can warm the cache from the
  // localStorage snapshot before this boundary hydrates, and a useState seed
  // would leak that into the hydration render and mismatch the server HTML.
  const inboxSeed = useCacheSeed<InboxResponse>("/runner/data/inbox");
  const platformsSeed = useCacheSeed<PlatformCard[]>("/runner/data/platforms");
  const [dataState, setData] = useState<InboxResponse | null>(null);
  const data = dataState ?? inboxSeed ?? null;
  const [platformsState, setPlatforms] = useState<PlatformCard[] | null>(null);
  const platforms = platformsState ?? platformsSeed ?? [];
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [heroSummary, setHeroSummary] = useState<{ id: string; summary: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedState, setLoaded] = useState(false);
  // A cached queue (even an empty one) counts as loaded - no skeleton on
  // top of data we are already painting.
  const loaded = loadedState || inboxSeed !== undefined;
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
  // Mirror of the filtered Today queue (`rows`, computed below) so the
  // MESSAGE_SENT handler credits a send as "done" only when the thread is
  // actually in tonight's queue, not just anywhere in the inbox.
  const todayRowsRef = useRef<InboxRow[]>([]);
  // Per-day "done" counter so the right-rail outline ticks up as the
  // operator clears overdue / waiting threads. Keyed by ISO date string
  // so it resets at local midnight.
  const [doneTodayByLevel, setDoneTodayByLevel] = useState<TonightProgress>(() => ({
    date: new Date().toDateString(),
    RED: 0,
    AMBER: 0,
    GREEN: 0
  }));

  const applyInbox = useCallback((inbox: InboxResponse) => {
    setInboxUnavailable(false);
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
  }, []);

  // `force` skips the freshness TTL (still SWR: stale paints immediately,
  // the network value lands via onFresh). Used by the SSE-driven path and
  // post-action refreshes - those fire BECAUSE the data changed, so serving
  // a <4s-old cache would delay the update until the next poll.
  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    const [inbox, platformRows, healthData] = await Promise.all([
      // SWR: paint the cached queue immediately, revalidate in the background.
      apiGet<InboxResponse>("/runner/data/inbox", {
        ttlMs: opts?.force ? 0 : 4000,
        swr: true,
        onFresh: (d) => applyInbox(d as InboxResponse)
      }).catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms", { ttlMs: 10000 }).catch(
        () => [] as PlatformCard[]
      ),
      apiGet<HealthResponse>("/runner/health", { ttlMs: 4000 }).catch(() => null)
    ]);
    setInboxUnavailable(inbox === null);
    if (inbox) applyInbox(inbox);
    setPlatforms(platformRows ?? []);
    if (healthData) setHealth(healthData);
    setLoaded(true);
  }, [applyInbox]);

  // Debounce SSE-driven refreshes so a multi-thread scan (one THREAD_UPDATED
  // per touched thread) collapses into a single inbox refetch instead of N.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh({ force: true });
    }, 450);
  }, [refresh]);
  useEffect(
    () => () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    },
    []
  );

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
    const onResync = () => scheduleRefresh();
    const onRunnerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string }>).detail;
      const type = detail?.type;
      // MESSAGE_SENT is handled by the advanceHero effect below (which also
      // refreshes), so it's intentionally not listed here — otherwise a
      // single send triggers two refreshes.
      if (
        type === "MESSAGE_SEND_FAILED" ||
        type === "THREAD_UPDATED" ||
        type === "SCAN_FINISHED"
      ) {
        scheduleRefresh();
      }
    };
    window.addEventListener("runner-resync", onResync);
    window.addEventListener("runner-event", onRunnerEvent as EventListener);
    return () => {
      window.removeEventListener("runner-resync", onResync);
      window.removeEventListener("runner-event", onRunnerEvent as EventListener);
    };
  }, [refresh, scheduleRefresh]);

  const advanceHero = useCallback((id: string, label: string, level: "RED" | "AMBER" | "GREEN") => {
    setTransitioning({ id, label });
    setDoneTodayByLevel((prev) => {
      const todayKey = new Date().toDateString();
      const base = prev.date === todayKey ? prev : { date: todayKey, RED: 0, AMBER: 0, GREEN: 0 };
      return { ...base, [level]: base[level] + 1 };
    });
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
    // Brief visual ack ("Handled, next up") before the queue advances. Kept
    // short: the operator is mid-flow and the next thread should be in front
    // of them as close to instantly as legibility allows.
    transitionTimer.current = setTimeout(() => {
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setTransitioning(null);
      void refresh({ force: true });
    }, 400);
  }, [refresh]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<RunnerEventDetail>).detail;
      if (!detail || !detail.threadId) return;
      if (detail.type === "MESSAGE_SENT") {
        // Only advance (and bump the "Tonight's outline" done counter) when
        // the sent thread is actually in Today's queue. Replying to an
        // off-queue thread (or a scheduled send firing) must not inflate
        // Today's counts. A non-Today send still refreshes via THREAD_UPDATED.
        const matching = todayRowsRef.current.find((row) => row.id === detail.threadId);
        if (matching) {
          advanceHero(detail.threadId, "Sent, next up", matching.riskLevel);
        }
      }
    };
    window.addEventListener("runner-event", handler);
    return () => window.removeEventListener("runner-event", handler);
  }, [advanceHero]);

  useEffect(() => () => {
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
  }, []);

  const { sandboxActive } = useFullDemo();
  // While a sandbox guided flow (pilot tour / presenter sandbox) is active,
  // Today shows only the demo-seeded threads so the walkthrough resolves its
  // targets instead of pointing at the operator's real hero. Outside a sandbox
  // flow this is a no-op and the real inbox shows as normal.
  const scopedRows = useMemo(
    () => scopeRowsToSandbox(data?.rows ?? [], sandboxActive),
    [data, sandboxActive]
  );
  // Freeze list order/identity for the active walkthrough step so live
  // refetches cannot move or replace the spotlighted target mid-step.
  const [tourSurfaceActive, setTourSurfaceActive] = useState(false);
  const [frozenRows, setFrozenRows] = useState<typeof scopedRows | null>(null);
  useEffect(() => {
    setTourSurfaceActive(isGuidedTourSurfaceActive());
    const onSurface = (event: Event) => {
      const detail = (event as CustomEvent<GuidedTourSurfaceDetail>).detail;
      setTourSurfaceActive(detail?.active ?? isGuidedTourSurfaceActive());
    };
    window.addEventListener(GUIDED_TOUR_SURFACE_EVENT, onSurface);
    return () => window.removeEventListener(GUIDED_TOUR_SURFACE_EVENT, onSurface);
  }, []);
  useEffect(() => {
    const resolved = resolveFrozenListRows({
      tourActive: tourSurfaceActive,
      nextRows: scopedRows,
      frozenRows
    });
    if (resolved.nextFrozen !== frozenRows) {
      setFrozenRows(resolved.nextFrozen);
    }
  }, [scopedRows, tourSurfaceActive, frozenRows]);
  const allRows = tourSurfaceActive && frozenRows && frozenRows.length > 0 ? frozenRows : scopedRows;
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
    () => allRows.filter((row) => isInTodayQueue(row, removedIds)),
    [allRows, removedIds]
  );
  const overdueCount = rows.filter((row) => row.riskLevel === "RED").length;
  const waitingCount = rows.filter((row) => row.riskLevel === "AMBER").length;
  const freshCount = rows.filter((row) => row.riskLevel === "GREEN").length;

  useEffect(() => {
    todayRowsRef.current = rows;
  }, [rows]);

  // Risk bucket first, then favourites lifted within their own bucket, then
  // oldest-waiting (R-0066 / #483). A favourite's overdue thread leads the
  // hero, but a non-favourite overdue still outranks a fresh favourite.
  const sortedRows = useMemo(() => sortTodayQueue(rows), [rows]);
  const hero = sortedRows[0];
  // The hero is the single most likely next open (Enter/R open it from the
  // keyboard, where hover-prefetch never fires). Warm its thread data the
  // moment it becomes the hero so opening it is instant.
  const heroId = hero?.id;
  useEffect(() => {
    if (heroId) prefetchThreadDataNow(heroId);
  }, [heroId]);
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
  // Only platforms the operator actually uses (connected at least once) raise
  // an error banner. A never-connected platform that failed a default scan is
  // "not set up", not "broken". (issue #708)
  const degraded = platforms.find(isDegradedAndInUse);

  useEffect(() => {
    if (!hero) {
      setHeroSummary(null);
      return;
    }
    if (heroSummary?.id === hero.id) return;
    void apiGet<ThreadResponse>(`/runner/data/thread/${hero.id}`)
      .then((t) => setHeroSummary({ id: hero.id, summary: cleanAskSummary(t.whatTheyWant) || t.summary?.trim() || null }))
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
        .querySelector(
          '[data-testid="today-overflow-link"], [data-testid="today-overflow-link-desktop"]'
        )
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [hero, visibleRemaining]
  );

  // Clock-derived text through the hydration-safe store — see
  // clockTextSnapshot above. Empty strings during SSR/hydration (matching
  // the statically prerendered HTML), live values right after.
  const clockText = useSyncExternalStore(subscribeClockNever, clockTextSnapshot, () => null);
  const [dayLabel, greeting] = clockText ? clockText.split("|") : ["", ""];
  // Greet by the configured name when set; a bare greeting otherwise — the
  // app no longer assumes who the user is.
  const operatorName = profile?.displayName?.trim() ?? "";
  const greetingLine = !greeting
    ? ""
    : operatorName
      ? `${greeting}, ${operatorName}.`
      : `${greeting}.`;
  const needsSetup = profile !== null && !profile.setupCompletedAt;

  const heroRisk = hero ? toDisplayRisk(hero.riskLevel) : null;
  const heroLabel = !hero
    ? ""
    : heroRisk === "overdue"
      ? `${PLATFORM_LABEL[hero.platform]}${META_SEP}waiting ${formatRelative(hero.lastInboundAt)}`
      : heroRisk === "waiting"
        ? `${PLATFORM_LABEL[hero.platform]}${META_SEP}waiting ${formatRelative(hero.lastInboundAt)}`
        : `${PLATFORM_LABEL[hero.platform]}${META_SEP}${formatRelative(hero.lastInboundAt)}`;

  const heroHeadlineRaw =
    heroSummary && heroSummary.id === hero?.id && heroSummary.summary
      ? heroSummary.summary
      : normalizePreview(hero?.preview);
  // The hero summary renders IN FULL via <FitText> (it shrinks the font to
  // fit, never truncates), so the only cap here is a generous safety net for a
  // pathological `summary` fallback. whatTheyWant is already ≤120 chars
  // server-side, so the normal ask is never touched; this just stops a runaway
  // multi-sentence fallback from forcing the font to the readability floor.
  const heroHeadline = (() => {
    if (!heroHeadlineRaw) return "";
    const trimmed = heroHeadlineRaw.trim();
    if (trimmed.length <= 200) return trimmed;
    const cut = trimmed.slice(0, 200);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 120 ? cut.slice(0, lastSpace) : cut).trim();
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
  // "Cleared X of N" overall progress for the right-rail panel: N is every
  // thread that needed the operator tonight (still-live + already-cleared),
  // X is how many have been handled.
  const clearedTotal = cleared.RED + cleared.AMBER + cleared.GREEN;
  const totalAll = rows.length + clearedTotal;
  const overallPct = totalAll === 0 ? 0 : (clearedTotal / totalAll) * 100;
  const allDone = rows.length === 0 && clearedTotal > 0;

  const showTourInvite = welcomeDismissed === true && tourSeen === false;
  const renderTourInvite = () =>
    showTourInvite ? (
      <PilotTourInviteCard
        onStart={() => {
          startPilotTour();
        }}
        onSkip={() => {
          markTourSeen(window.localStorage);
          setTourSeen(true);
        }}
      />
    ) : null;

  const renderVoiceSetup = () =>
    needsSetup ? (
      <div data-testid="voice-setup-card" className="mb-6 md:mb-8">
        <UserVoiceProfile variant="onboarding" onCompleted={loadProfile} />
      </div>
    ) : null;

  const renderTonightProgress = (variant: "compact" | "full") => (
    <>
      <div className={variant === "compact" ? "mb-3" : "mb-5"}>
        <div className="mb-[9px] flex items-baseline justify-between">
          <span className="text-[13.5px] font-semibold text-ink">Cleared</span>
          <span className="font-mono text-[12px] text-ink-2">
            <strong className="font-semibold text-ink">{clearedTotal}</strong> of {totalAll}
          </span>
        </div>
        <div className="h-[6px] overflow-hidden rounded-full bg-hairline">
          <span
            className="block h-full rounded-full bg-ink transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${overallPct}%` }}
          />
        </div>
      </div>
      {variant === "full" ? (
        <div className="flex flex-col gap-[15px]">
          <CategoryBar
            label="Overdue"
            tone="overdue"
            done={cleared.RED}
            total={totalRed}
            pct={overduePct}
            liveCount={overdueCount}
            onJump={() => jumpToLevel("RED")}
          />
          <CategoryBar
            label="Needs a reply"
            tone="waiting"
            done={cleared.AMBER}
            total={totalAmber}
            pct={waitingPct}
            liveCount={waitingCount}
            onJump={() => jumpToLevel("AMBER")}
          />
          <CategoryBar
            label="Fresh, no rush"
            tone="fresh"
            done={cleared.GREEN}
            total={totalGreen}
            pct={freshPct}
            liveCount={freshCount}
            onJump={() => jumpToLevel("GREEN")}
          />
        </div>
      ) : (
        <p className="m-0 font-mono text-[11px] leading-[1.45] text-ink-3">
          {overdueCount > 0 ? `${overdueCount} overdue` : null}
          {overdueCount > 0 && (waitingCount > 0 || freshCount > 0) ? " · " : null}
          {waitingCount > 0 ? `${waitingCount} waiting` : null}
          {waitingCount > 0 && freshCount > 0 ? " · " : null}
          {freshCount > 0 ? `${freshCount} fresh` : null}
          {overdueCount + waitingCount + freshCount === 0
            ? allDone
              ? "All clear for tonight"
              : "Nothing queued yet"
            : null}
        </p>
      )}
      {allDone ? (
        <p
          className={
            variant === "compact"
              ? "mt-3 text-[13.5px] leading-[1.5] text-ink-2"
              : "mt-[18px] text-[13.5px] leading-[1.5] text-ink-2"
          }
        >
          <strong className="font-semibold text-risk-fresh">That’s everyone.</strong> Nothing left
          tonight. Close the laptop and get some sleep.
        </p>
      ) : null}
    </>
  );

  return (
    <Canvas
      data-testid="today-page"
      className="max-w-[1240px] pb-8 md:pb-10 3xl:max-w-[1400px]"
    >
      <header className="sticky top-0 z-20 -mx-5 mb-3 flex items-start justify-between gap-3 border-b border-hairline/70 bg-[color-mix(in_oklch,var(--paper)_96%,transparent)] px-5 pb-2.5 pt-3 backdrop-blur-xl backdrop-saturate-150 sm:-mx-8 sm:mb-6 sm:items-baseline sm:gap-6 sm:border-b-0 sm:px-8 sm:pb-3 sm:pt-6 lg:-mx-12 lg:px-12">
        <div className="min-w-0">
          <p className="mb-0.5 hidden font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 sm:block">
            {dayLabel}
          </p>
          <h1 className="m-0 truncate font-display text-[23px] font-semibold leading-[1.1] tracking-[-0.025em] sm:text-[32px]">
            <span className="md:hidden">Today</span>
            <span className="hidden md:inline">{greetingLine}</span>
          </h1>
        </div>
        <div className="max-w-[48%] shrink-0 text-right font-mono text-[10.5px] leading-[1.35] text-ink-3 sm:max-w-none sm:text-[12px]">
          <span data-testid="today-queue-count">
            <strong className="font-medium text-ink">{rows.length}</strong> need you tonight
          </span>
          <span className="hidden sm:inline">
            <br />
            last scan {health ? formatRelative(health.lastScanAt) : "never"}
          </span>
        </div>
      </header>

      <NotificationCta />

      {degraded ? (
        <DegradedBanner
          platform={degraded.platform}
          stage={degraded.lastScanFailure?.stage}
          reason={degraded.lastScanFailure?.reason}
          requestId={degraded.lastScanFailure?.requestId}
          errorSummary={degraded.lastScanFailure?.errorSummary ?? degraded.lastError ?? undefined}
          screenshotFile={degraded.lastScanFailure?.screenshotFile}
          domDumpFile={degraded.lastScanFailure?.domDumpFile}
          onRunSelectorTests={
            degraded.platform === "INSTAGRAM"
              ? undefined
              : () =>
                  runAction(
                    apiPost("/runner/control/platform/test-selectors", { platform: degraded.platform }),
                    setError,
                    refresh
                  )
          }
        />
      ) : null}

      {error ? (
        <p className="mb-6 rounded-row border border-hairline bg-paper-2 px-4 py-3 text-[12px] leading-[1.5] text-ink-2">{error}</p>
      ) : null}

      {/* Mobile home is one vertical column (First up → Up next → Tonight →
          secondary). Desktop keeps the two-column dashboard. `contents` lets
          mobile children participate in the outer flex order without nesting
          an extra scroll container. */}
      <div
        data-testid="today-home-layout"
        className="flex flex-col gap-5 sm:gap-6 lg:grid lg:min-h-[calc(100vh-140px)] lg:grid-cols-[1fr_260px] lg:items-start lg:gap-8"
      >
        {/* One stable setup instance. Position only changes via CSS order so
            UserVoiceProfile draft survives rotation and the 768px breakpoint
            (no unmount/remount across media queries). Desktop: leads the
            page (order-first, full width). Mobile: after the reply workflow
            and before the secondary rail (order-10 vs aside order-20). */}
        <div
          data-testid="today-setup-slot"
          className="order-10 col-span-full md:order-first"
        >
          {renderTourInvite()}
          {renderVoiceSetup()}
        </div>

        <div className="contents lg:col-start-1 lg:row-start-1 lg:flex lg:flex-col">
          {hero ? (
            <article
              ref={heroRef}
              data-testid="today-hero"
              data-demo-target="today-hero"
              className={`relative mb-1 flex cursor-pointer flex-col overflow-hidden rounded-[16px] px-3 pb-4 pt-4 transition-opacity duration-300 sm:mb-2 sm:px-[30px] sm:pb-[22px] sm:pt-7 ${heroIsTransitioning ? "opacity-50" : "opacity-100"}`}
              onClick={() => router.push(`/thread/${hero.id}`)}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "radial-gradient(135% 130% at 100% 0%, color-mix(in srgb, var(--accent) 12%, transparent) 0%, color-mix(in srgb, var(--accent) 4%, transparent) 36%, transparent 64%)"
                }}
              />
              <div className="relative flex flex-col">
                <p className="mb-3 flex items-center gap-[10px] font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink sm:mb-[20px] sm:text-[11px]">
                  <span className="inline-block h-[6px] w-[6px] rounded-full bg-accent" />
                  {heroIsTransitioning
                    ? transitioning?.label ?? "First up"
                    : `First up${META_SEP}1 of ${rows.length}`}
                </p>
                {/* Summary always shows in full via FitText (no ellipsis). Height
                    budget stays capped so primary actions stay near the fold. */}
                <div className="mb-2.5 max-w-[600px] sm:mb-[14px]">
                  <FitText
                    as="h2"
                    maxPx={32}
                    minPx={18}
                    maxHeightPx={100}
                    data-testid="today-hero-summary"
                    className="m-0 text-balance font-display font-semibold leading-[1.15] tracking-[-0.025em]"
                  >
                    {heroHeadline || "Catching up with someone"}
                  </FitText>
                </div>
                <div className="mb-2.5 flex min-w-0 items-center gap-2.5 sm:mb-[18px] sm:gap-3">
                  <PersonAvatar name={hero.personName} avatarUrl={hero.personAvatarUrl} size={28} />
                  <span className="truncate font-medium text-ink">{hero.personName}</span>
                  {hero.personFavourite ? (
                    <Star
                      className="h-[14px] w-[14px] shrink-0 text-accent"
                      strokeWidth={1.6}
                      fill="currentColor"
                      aria-label="Favourite"
                    />
                  ) : null}
                  <span className="truncate font-mono text-[11px] text-ink-3 sm:text-[12px]">
                    {heroLabel}
                  </span>
                </div>
                <p className="m-0 mb-4 line-clamp-2 max-w-[68ch] border-l-2 border-hairline-strong pl-3 text-[14px] leading-[1.5] text-ink-2 sm:mb-7 sm:line-clamp-none sm:pl-5 sm:text-balance sm:text-[17px] sm:leading-[1.55]">
                  {normalizePreview(hero.preview)}
                </p>
                <div
                  data-testid="today-hero-actions"
                  className="relative grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap sm:gap-[10px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Button
                    variant="primary"
                    onClick={() => router.push(`/thread/${hero.id}`)}
                    className="col-span-2 min-h-[44px] w-full justify-center gap-3 sm:min-h-0 sm:w-auto"
                  >
                    Open &amp; reply
                    <span className="hidden sm:inline">
                      <KbHint label="↵" tone="primary" />
                    </span>
                  </Button>
                  <Button
                    variant="quiet"
                    className="min-h-[44px] w-full justify-center gap-3 hover:border-[color-mix(in_oklch,var(--accent)_45%,transparent)] hover:bg-accent-soft hover:text-accent-ink sm:min-h-0 sm:w-auto"
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
                    <span className="sm:hidden">Snooze</span>
                    <span className="hidden sm:inline">Snooze ’til tomorrow</span>
                    <span className="hidden sm:inline">
                      <KbHint label="S" />
                    </span>
                  </Button>
                  <Button
                    variant="quiet"
                    className="min-h-[44px] w-full justify-center gap-3 hover:border-[color-mix(in_oklch,var(--accent)_45%,transparent)] hover:bg-accent-soft hover:text-accent-ink sm:min-h-0 sm:w-auto"
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
                    <span className="hidden sm:inline">
                      <KbHint label="E" />
                    </span>
                  </Button>
                </div>

                {queuePeek.length > 0 ? (
                  <div className="mt-[22px] hidden items-center gap-[14px] border-t border-hairline pt-[18px] font-mono text-[11px] text-ink-3 sm:flex">
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
                      {queuePeek.map((row) => row.personName.split(" ")[0]).join(META_SEP)}
                    </span>
                    {queueRemaining > 0 ? (
                      <span className="ml-auto">
                        {queueRemaining} more{META_SEP}~{queueEtaMinutes} min
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </article>
          ) : loaded && inboxUnavailable && !data ? (
            <CaughtUp
              title="Your conversations are paused."
              body="The local helper is not responding. Choose Start runner above. This page will refill when it reconnects."
            />
          ) : loaded ? (
            <CaughtUp title="You’re caught up." body="Nothing else needs you tonight." />
          ) : (
            <BrandLoader className="py-1" />
          )}

          {remaining.length > 0 ? (
            <section data-testid="today-up-next" className="mt-3 md:hidden">
              <div className="mb-2 flex items-baseline justify-between px-0.5">
                <h3 className="m-0 font-display text-[17px] font-semibold tracking-[-0.018em]">
                  Up next
                </h3>
                <span className="font-mono text-[11px] text-ink-3">{remaining.length} waiting</span>
              </div>
              <div className="flex flex-col gap-2">
                {visibleRemaining.map((row) => (
                  <UpNextCard key={row.id} row={row} />
                ))}
                {overflowCount > 0 ? (
                  <Link
                    href="/inbox"
                    data-testid="today-overflow-link"
                    className="flex min-h-[44px] items-center justify-between rounded-[12px] border border-hairline px-3 py-2.5 text-[13px] text-ink-2 transition-colors duration-calm active:bg-paper-2"
                  >
                    <span>+ {overflowCount} more waiting</span>
                    <span className="font-mono text-[11px] text-ink-3">Inbox</span>
                  </Link>
                ) : null}
              </div>
            </section>
          ) : null}

          {remaining.length > 0 ? (
            <div className="mt-10 hidden md:block" data-testid="today-then-these">
              <div className="mb-[14px] flex items-baseline justify-between px-1">
                <h3 className="m-0 font-display text-[19px] font-semibold tracking-[-0.018em]">
                  Then these, in order
                </h3>
                <span className="font-mono text-[12px] text-ink-3">{remaining.length} waiting</span>
              </div>
              <div className="flex flex-col">
                {visibleRemaining.map((row) => (
                  <ThreadRow
                    key={row.id}
                    row={row}
                    id={`today-row-${row.id}`}
                    onPersonChanged={refresh}
                  />
                ))}
                {overflowCount > 0 ? (
                  <Link
                    href="/inbox"
                    data-testid="today-overflow-link-desktop"
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
            </div>
          ) : hero && loaded ? (
            <div className="hidden md:block">
              <CaughtUp title="That’s the only one." body="Reply to it and you’re done." />
            </div>
          ) : null}
        </div>

        {(totalAll > 0 || allDone) && (hero || clearedTotal > 0) ? (
          <section
            data-testid="today-tonight-compact"
            className="rounded-[14px] border border-hairline bg-paper px-3.5 py-3.5 md:hidden"
          >
            <h5 className="m-0 mb-3 font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">
              Tonight
            </h5>
            {renderTonightProgress("compact")}
          </section>
        ) : null}

        <aside
          className="order-20 lg:col-start-2 lg:row-start-1 md:order-none"
          data-testid="today-secondary-rail"
        >
          <div className="flex flex-col gap-8 lg:sticky lg:top-[110px] lg:gap-10">
            <FocusRailCard rows={rows} />

            {welcomeDismissed === false ? (
              <PilotWelcomeCard
                compact
                onDismiss={() => {
                  window.localStorage.setItem(PILOT_WELCOME_DISMISSED_KEY, "1");
                  setWelcomeDismissed(true);
                }}
              />
            ) : null}

            <section className="hidden md:block" data-testid="today-tonight-desktop">
              <h5 className="m-0 mb-[18px] font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
                Tonight’s progress
              </h5>
              {renderTonightProgress("full")}
            </section>

            <UpcomingBirthdays />
          </div>
        </aside>
      </div>
    </Canvas>
  );
}

// One risk category in the right-rail "Tonight's progress" panel: a label
// row (dot + name + done/total) stacked over a thin fill bar, coloured by
// risk tone via currentColor. While the level still has live threads the
// whole block is a button that scrolls to the first such thread; once the
// bucket is empty it renders inert.
function CategoryBar({
  label,
  tone,
  done,
  total,
  pct,
  liveCount,
  onJump
}: {
  label: string;
  tone: "overdue" | "waiting" | "fresh";
  done: number;
  total: number;
  pct: number;
  liveCount: number;
  onJump: () => void;
}) {
  const toneClass =
    tone === "overdue"
      ? "text-risk-overdue"
      : tone === "waiting"
        ? "text-risk-waiting"
        : "text-risk-fresh";
  const inner = (
    <>
      <div className="mb-[7px] flex items-center gap-[9px]">
        <span className="inline-block h-[7px] w-[7px] rounded-full bg-current" />
        <span className="flex-1 text-[13px] text-ink-2">{label}</span>
        <span className="font-mono text-[11.5px] text-ink-3">
          {done}/{total}
        </span>
      </div>
      <div className="h-[4px] overflow-hidden rounded-full bg-hairline">
        <span
          className="block h-full rounded-full bg-current transition-[width] duration-500 ease-out motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
    </>
  );
  // No live threads of this level: nothing to jump to, so render it inert.
  if (liveCount === 0) {
    return <div className={toneClass}>{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onJump}
      title={`Jump to ${label.toLowerCase()}`}
      className={`${toneClass} -mx-2 rounded-[8px] px-2 py-1 text-left transition-colors duration-calm hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      {inner}
    </button>
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
  // Reuse PersonAvatar so the peek tiles carry the same per-name hashed
  // tone as the list rows (matching the prototype's coloured avatars); the
  // wrapper just supplies the overlap offset + paper ring.
  return (
    <span className="inline-flex" style={{ marginLeft: offset === 0 ? 0 : -6 }}>
      <PersonAvatar name={name} avatarUrl={avatarUrl} size={22} className="border-2 border-paper" />
    </span>
  );
}

// Compact queue row for the mobile Today home. Full ThreadRow stays on
// desktop; phones get denser cards so "Up next" fits under First up.
function UpNextCard({ row }: { row: InboxRow }) {
  const risk = toDisplayRisk(row.riskLevel);
  const nudge = cleanAskSummary(row.whatTheyWant);
  const body = nudge || normalizePreview(row.preview);
  const rightLabel =
    risk === "overdue"
      ? "Overdue"
      : risk === "waiting"
        ? "Waiting"
        : formatRelative(row.lastInboundAt ?? row.lastMessageAt);
  const riskClass =
    risk === "overdue"
      ? "text-risk-overdue"
      : risk === "waiting"
        ? "text-risk-waiting"
        : "text-ink-3";
  const when =
    risk === "overdue" || risk === "waiting"
      ? `waiting ${formatRelative(row.lastInboundAt)}`
      : formatRelative(row.lastInboundAt ?? row.lastMessageAt);

  return (
    <Link
      id={`today-row-${row.id}`}
      href={`/thread/${row.id}`}
      onPointerDown={() => prefetchThreadDataNow(row.id)}
      data-demo-target={row.platformThreadId ? `thread-row-${row.platformThreadId}` : undefined}
      data-testid="today-up-next-card"
      className="flex min-h-[56px] items-center gap-3 rounded-[12px] border border-hairline bg-paper px-3 py-2.5 transition-colors duration-calm active:bg-paper-2"
    >
      <PersonAvatar
        name={row.personName}
        avatarUrl={row.personAvatarUrl}
        size={36}
        className="shrink-0 text-[12px]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-ink">
            {row.personName}
          </span>
          <span className={`shrink-0 font-mono text-[11px] font-medium ${riskClass}`}>
            {rightLabel}
          </span>
        </span>
        {body ? (
          <span className="mt-0.5 line-clamp-1 text-[13px] leading-[1.35] text-ink-2">{body}</span>
        ) : null}
        <span className="mt-0.5 block font-mono text-[10.5px] text-ink-3">
          {PLATFORM_LABEL[row.platform]}
          {META_SEP}
          {when}
        </span>
      </span>
    </Link>
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
