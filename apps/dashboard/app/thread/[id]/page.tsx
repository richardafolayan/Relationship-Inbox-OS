"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useParams, useRouter } from "next/navigation";
import { v4 as uuid } from "uuid";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  Clock,
  Loader2,
  Mic,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Save,
  Send,
  Sparkles,
  Star,
  Sun,
  Trash2,
  X
} from "lucide-react";
import { Menu } from "@/components/ui/menu";
import { apiGet, apiPost, peekCache, runAction } from "@/lib/api";
import { BrandLoader } from "@/components/common/brand-loader";
import { setFavourite } from "@/lib/favourites";
import { runActionWithFeedback, showToast } from "@/lib/feedback";
import { signalReassessStart } from "@/lib/reassess-status";
import { readThreadSource } from "@/lib/thread-source";
import { shouldApplyThreadScopedResult, shouldRefetchForThreadEvent } from "@/lib/thread-identity-guard";
import { computeRepliesGenerating } from "@/lib/suggestions-spinner";
import { composerSourceAfterClear } from "@/lib/composer-source";
import { ageOnNextBirthday, birthdayCountdownLabel, daysUntilBirthday } from "@inbox-os/core/birthday";
import { cn } from "@/lib/utils";
import type {
  AuditLogRow,
  InboxResponse,
  InboxRow,
  OperatorProfile,
  PlatformCard,
  ThreadMessage,
  ThreadResponse
} from "@/lib/types";
import { IMessageMedia, VoiceMessageTranscript } from "@/components/thread/imessage-media";
import { isNonContentIMessageSystemEvent } from "@/lib/imessage-system-events";
import { foldSynthesizedReactions } from "@/lib/synthesized-reactions";
import { formatClock, formatRelative } from "@/lib/time";
import { initials, isDegradedAndInUse, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { PersonAvatar } from "@/components/common/person-avatar";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/action-button";
// Drawers are lazy-loaded: they're heavy (ProfileDrawer ~390 LOC + its own
// data fetch) and only ever shown on demand, so they stay out of the most-
// opened page's initial JS chunk. An "opened-once" latch below keeps them
// mounted after first open, so their open/close behaviour is unchanged.
const ReceiptsDrawer = dynamic(
  () => import("@/components/common/receipts-drawer").then((m) => m.ReceiptsDrawer),
  { ssr: false }
);
const ProfileDrawer = dynamic(
  () => import("@/components/common/profile-drawer").then((m) => m.ProfileDrawer),
  { ssr: false }
);
import { DegradedBanner } from "@/components/common/degraded-banner";
import { FocusThreadStrip } from "@/components/common/focus/focus-thread-strip";
import { autocorrectAtCaret } from "@/lib/autocorrect";
import { blobToWhisperWav } from "@/lib/dictation-audio";
import {
  classifyDictationResponse,
  DICTATION_LOST_CONNECTION_MESSAGE,
  type DictationResponseBody
} from "@/lib/dictation-retry";
import { stopRecorderAndStream } from "@/lib/recorder-teardown";
import { ThingsToRemember } from "@/components/thread/ThingsToRemember";
import { ReplyBriefPanel } from "@/components/thread/ReplyBriefPanel";
import { ThreadBriefBand } from "@/components/thread/ThreadBriefBand";
import { chooseDisplayBrief } from "@/lib/reply-brief";
import { restoreFailedAttachments } from "@/lib/composer-attachments";
import { nextMorningSendSlot, shouldOfferLateNightSchedule } from "@/lib/late-night-send";

// Thread workspace - landscape layout.
//
//   ┌──────────── chat column (fills) ─────────┬── context rail (360) ──┐
//   │ back link + thread header                │  WHAT THEY WANT        │
//   │ ─── timeline (scrolls, lazy-loaded) ───  │  · summary             │
//   │ ─── composer (sticky bottom) ───         │  · the ask             │
//   │ meta row                                 │  OPEN LOOPS            │
//   │                                          │  WRITE IN MY VOICE     │
//   └──────────────────────────────────────────┴────────────────────────┘
//
// The chat column owns the conversation. The right rail keeps "what they
// want", open loops, and the AI compose helper visible without crowding
// the message stream - and scrolls independently when content overflows.
//
// Behaviour preserved across the rebuild:
//   • Auto-scroll to the most recent message on open / new send.
//   • Lazy-render the last 15 messages, expand on scroll-near-top with
//     scroll-position restoration so older history doesn't yank the view.
//   • SSE event reconciliation + send-queue polling fallback.
//   • Optimistic-UI bubbles with retry on failure.
//   • [system event] markers collapse into a centred mono caption.
//   • Compose-in-voice (intent → AI draft) lives in the right rail.
//   • Shorten / Make warmer transforms stay inside the composer toolbar
//     (they need direct access to the current draft).

const FALLBACK_SUGGESTIONS: Array<{ intent: string; glyph: string; build: (firstName: string) => string }> = [
  { intent: "Warm yes", glyph: "↵", build: (n) => `Hey ${n}, yes - let's do it.` },
  { intent: "Polite pass", glyph: "·", build: (n) => `Hi ${n}, appreciate it but I'll pass for now.` },
  { intent: "Ask for time", glyph: "⏱", build: (n) => `Hey ${n}, can I get back to you next week?` }
];

// The runner paginates messages server-side and exposes `messagePage`
// on every ThreadResponse. We only own the scroll-position thresholds:
// crossing the top threshold triggers `loadOlderMessages`, and staying
// near the bottom keeps the auto-scroll-on-new-message glue active.
const SCROLL_TOP_THRESHOLD = 120;
const SCROLL_BOTTOM_THRESHOLD = 200;
// #461 (pilot R-0060): once the operator has scrolled up this far from the
// newest message, surface a floating "jump to latest" button. Larger than
// SCROLL_BOTTOM_THRESHOLD so it appears only once you're genuinely reading
// history, not on a small nudge away from the bottom.
const JUMP_TO_LATEST_THRESHOLD = 600;

// Picks the topmost visible message bubble below the sticky header to
// anchor scroll preservation on. Selecting by data-message-id (set on
// every bubble in the JSX) avoids accidentally anchoring on a wrapper
// div whose position doesn't map cleanly to a message — the wrapper's
// rect can stay constant while the messages inside it shift, leaving
// scroll preservation off by tens of pixels. Each bubble is rendered
// with key={message.id}, so React preserves the DOM node across the
// re-render that prepends older messages.
function pickScrollAnchor(scroller: HTMLElement, scrollerTop: number): HTMLElement | null {
  const stickyBand = 80;
  const probeTop = scrollerTop + stickyBand;
  const probeBottom = scrollerTop + scroller.clientHeight;
  let best: { el: HTMLElement; top: number } | null = null;
  const candidates = scroller.querySelectorAll<HTMLElement>("[data-message-id]");
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= probeTop || rect.top >= probeBottom) continue;
    if (!best || rect.top < best.top) best = { el, top: rect.top };
  }
  return best?.el ?? null;
}

// Synchronously adjusts the scroller so the anchor element returns to
// its captured viewport offset. Returns true if a non-trivial
// adjustment was applied.
function repinAnchor(scroller: HTMLElement, anchorEl: HTMLElement, viewportOffset: number): boolean {
  if (!scroller.contains(anchorEl)) return false;
  const elTop = scroller.getBoundingClientRect().top;
  const newAnchorTop = anchorEl.getBoundingClientRect().top;
  const adjustment = (newAnchorTop - elTop) - viewportOffset;
  if (Math.abs(adjustment) < 0.5) return false;
  scroller.scrollTop += adjustment;
  return true;
}

// Re-pins the anchor for a short window after a load-older completes,
// so async content growth above the anchor (image/attachment loads,
// suggested-replies expanding, etc.) doesn't shift the operator's
// viewport. Stops as soon as the operator scrolls themselves or the
// window expires.
function startPostLoadAnchorGuard(
  scroller: HTMLElement,
  anchorEl: HTMLElement,
  viewportOffset: number
): () => void {
  return startScrollSettlingGuard(scroller, () => {
    repinAnchor(scroller, anchorEl, viewportOffset);
  });
}

// Pins the scroller to its bottom for a short window after a fresh
// thread landing, so async content (images, attachment thumbnails)
// loading in DOESN'T leave the operator above the most recent
// message. Same shape as the post-load anchor guard — just a
// different re-pin target.
function startInitialBottomGuard(scroller: HTMLElement): () => void {
  return startScrollSettlingGuard(scroller, () => {
    scroller.scrollTop = scroller.scrollHeight;
  });
}

function startScrollSettlingGuard(scroller: HTMLElement, repin: () => void): () => void {
  const GUARD_MS = 1500;
  let active = true;
  const stop = () => {
    if (!active) return;
    active = false;
    ro.disconnect();
    scroller.removeEventListener("wheel", stop);
    scroller.removeEventListener("touchstart", stop);
    document.removeEventListener("keydown", stop);
    clearTimeout(timer);
  };
  const ro = new ResizeObserver(() => {
    if (!active) return;
    repin();
  });
  // Observe each non-sticky child of the scroller — that's where the
  // message-list growth happens. (The sticky header doesn't count.)
  for (const child of Array.from(scroller.children) as HTMLElement[]) {
    if (getComputedStyle(child).position !== "sticky") ro.observe(child);
  }
  scroller.addEventListener("wheel", stop, { passive: true });
  scroller.addEventListener("touchstart", stop, { passive: true });
  document.addEventListener("keydown", stop);
  const timer = setTimeout(stop, GUARD_MS);
  return stop;
}

// Returns a friendly day label ("Today", "Yesterday", or "Tue 6 May") if
// the given message starts a new day relative to the previous, otherwise
// null. Used to inject day-dividers into the timeline.
function dayDividerLabel(prev: string | null | undefined, curr: string | null | undefined): string | null {
  if (!curr) return null;
  const currDate = new Date(curr);
  if (Number.isNaN(currDate.getTime())) return null;
  if (!prev) return formatDayLabel(currDate);
  const prevDate = new Date(prev);
  if (Number.isNaN(prevDate.getTime())) return formatDayLabel(currDate);
  const sameDay =
    prevDate.getFullYear() === currDate.getFullYear() &&
    prevDate.getMonth() === currDate.getMonth() &&
    prevDate.getDate() === currDate.getDate();
  return sameDay ? null : formatDayLabel(currDate);
}

function formatDayLabel(date: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  // Append the year only when the message isn't from the current year.
  // Keeps recent dividers clean ("Mon, May 12") while making it obvious
  // that an older thread reaches into a prior year ("Mon, May 12, 2025"),
  // so the operator never has to guess which May 12 they're looking at.
  const includeYear = date.getFullYear() !== today.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(includeYear ? { year: "numeric" } : {})
  });
}

// Build the standard list of schedule-send presets relative to `now`.
// Times round forward to whole hours / 9 am the next morning, matching the
// conventions Gmail and the Apple Mail "Send Later" picker use - operators
// don't expect "in 1 hour" to land at 4:23 pm.
function buildSchedulePresets(now: Date): Array<{ label: string; sub: string; at: Date }> {
  const inOneHour = new Date(now.getTime() + 60 * 60 * 1000);
  inOneHour.setMinutes(0, 0, 0);
  if (inOneHour.getTime() <= now.getTime()) inOneHour.setHours(inOneHour.getHours() + 1);

  const inThreeHours = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  inThreeHours.setMinutes(0, 0, 0);
  if (inThreeHours.getTime() <= now.getTime()) inThreeHours.setHours(inThreeHours.getHours() + 1);

  const tomorrowMorning = new Date(now);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(9, 0, 0, 0);

  const mondayMorning = new Date(now);
  // 1=Mon..6=Sat,0=Sun. Find the next Monday strictly in the future.
  const day = mondayMorning.getDay();
  const daysUntilMonday = ((1 - day + 7) % 7) || 7;
  mondayMorning.setDate(mondayMorning.getDate() + daysUntilMonday);
  mondayMorning.setHours(9, 0, 0, 0);

  const fmt = (d: Date) =>
    d.toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit"
    });

  return [
    { label: "In 1 hour", sub: fmt(inOneHour), at: inOneHour },
    { label: "In 3 hours", sub: fmt(inThreeHours), at: inThreeHours },
    { label: "Tomorrow 9 am", sub: fmt(tomorrowMorning), at: tomorrowMorning },
    { label: "Monday 9 am", sub: fmt(mondayMorning), at: mondayMorning }
  ];
}

// Convert an ISO timestamp to the "YYYY-MM-DDTHH:mm" format that
// <input type="datetime-local"> expects. Local timezone - the input is
// user-facing, so we want the wall-clock time the operator sees in
// the existing pill, not UTC.
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Format an absolute timestamp for the "scheduled for X" pill - show the
// weekday/time if it's in the next 7 days, otherwise the full date.
function formatScheduledFor(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const within7Days = d.getTime() - now.getTime() < 7 * 24 * 60 * 60 * 1000;
  if (within7Days) {
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return `today at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
    }
    return d.toLocaleString(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit"
    });
  }
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function DayDivider({ label, className }: { label: string; className?: string }) {
  // Faster collapse on focus enter (150ms) than expand on exit
  // (300ms) — matches the bubble timing so dividers and bubbles
  // animate together.
  const dimmed = className?.includes("opacity-0") ?? false;
  return (
    <div className={`my-3 flex items-center gap-3 self-stretch transition-all ${dimmed ? "duration-150" : "duration-300"} ${className ?? ""}`}>
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-[11px] font-medium tracking-[-0.005em] text-ink-3">{label}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

function ParticipantPopover({
  handle,
  platform,
  onClose
}: {
  handle: string;
  platform: ThreadResponse["platform"];
  onClose: () => void;
}) {
  // Closes on outside-click + Escape. The wrapper sits in a relatively-
  // positioned parent so this floats just below the sender name.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointer = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  // Search-based 1:1 navigation: there is no /people/<handle> detail
  // route and no "find 1:1 thread by handle" endpoint yet, so the
  // popover routes through /inbox?q=<handle>. The existing inbox search
  // matches on personName + preview, so a saved name lands the contact's
  // 1:1 thread directly; a raw phone/email is searchable too. Empty
  // search results are graceful (the existing empty-state handles it).
  const searchHref = `/inbox?q=${encodeURIComponent(handle)}`;
  return (
    <div
      ref={ref}
      role="dialog"
      className="absolute left-0 top-[calc(100%+4px)] z-30 w-[260px] rounded-[10px] border border-hairline bg-paper p-3 shadow-card"
    >
      <p className="m-0 text-[12px] font-medium text-ink">{handle}</p>
      <p className="m-0 mt-[2px] font-mono text-[11px] text-ink-3">{platform.toLowerCase()}</p>
      <Link
        href={searchHref}
        className="mt-3 inline-block w-full rounded-[8px] bg-ink px-3 py-[6px] text-center text-[12px] font-medium text-paper hover:opacity-90"
        onClick={onClose}
      >
        Find 1:1 thread
      </Link>
    </div>
  );
}

/**
 * Shape of a message reaction as the runner stores and returns it. An
 * operator-applied reaction (sent from this dashboard) carries
 * direction "OUT"; reactions the contact left carry "IN". Shared by the
 * native-reactions read, the optimistic local overlay, and the badge
 * renderer so all three agree on one shape.
 */
type MessageReaction = { emoji: string; kind: string; direction: "IN" | "OUT" };

/**
 * #408. The quick-react picker offers a small, common set of emoji.
 * LinkedIn's own message reactions map onto these glyphs, so the
 * operator picks from a familiar row rather than a full keyboard.
 */
const QUICK_REACT_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "👏"] as const;

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const threadId = params.id;

  // Seed from the shared client cache so a prefetched (hover/pointerdown) or
  // previously-seen thread paints the full conversation on the very first
  // render - no "Loading..." frame. refresh() still runs on mount and
  // revalidates, so this is never more than stale-while-revalidate.
  //
  // This page deliberately keeps the useState(peekCache) initializer instead
  // of lib/use-cache-seed (the hydration-safe form the list pages use):
  // `thread` is mutated with functional updaters (setThread(current => ...))
  // which the hook's `state ?? seed` pattern would hand a null `current`
  // while the seed is on screen. That stays hydration-safe here ONLY because
  // nothing outside this page fetches /runner/data/thread/<id> - the cache
  // for this path cannot be warm during a hard load's hydration render, just
  // on client-side navigations. If the app shell (or anything mounted above
  // this boundary) ever starts fetching thread paths, switch this seed to
  // useCacheSeed and rework the functional updaters first.
  const [thread, setThread] = useState<ThreadResponse | null>(
    () => peekCache<ThreadResponse>(`/runner/data/thread/${threadId}`) ?? null
  );
  const [siblings, setSiblings] = useState<InboxRow[]>([]);
  const [siblingPlatform, setSiblingPlatform] = useState<"all" | "LINKEDIN" | "IMESSAGE">("all");
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  // Focused thread: cuid of the parent message whose thread we're zoomed
  // into. Declared up here because the send callback closes over it.
  // Cleared on Esc, the chip ×, or when navigating threads (effect below).
  const [focusedThreadParentId, setFocusedThreadParentId] = useState<string | null>(null);
  // Bumped on every chip / N-Replies click so the focus useLayoutEffect
  // re-fires its scroll-into-view even when the operator clicks a chip
  // whose parent is already the current focus (re-centring after the
  // user scrolled around).
  const [focusTrigger, setFocusTrigger] = useState(0);
  // Snapshot of the timeline's scrollTop just before entering focus
  // mode. Restored on exit so the operator lands back in the same
  // spot they were before they clicked the chip, regardless of how
  // they scrolled inside the focused stack.
  // The exact message the operator was looking at when they entered
  // focus mode. Restored on exit so layout shifts during focus
  // (collapsed bubbles re-expanding, late-loaded attachments) don't
  // leave them at a numerically-equal-but-visually-different scroll
  // position.
  const preFocusAnchorRef = useRef<{ anchorEl: HTMLElement; viewportOffset: number } | null>(null);
  const focusOnParent = useCallback((parentId: string) => {
    const el = timelineRef.current;
    if (el && preFocusAnchorRef.current === null) {
      // Only capture once per focus session — repeated chip clicks
      // (focus swaps) keep the same "where we came from" anchor.
      const elTop = el.getBoundingClientRect().top;
      const anchor = pickScrollAnchor(el, elTop);
      if (anchor) {
        preFocusAnchorRef.current = {
          anchorEl: anchor,
          viewportOffset: anchor.getBoundingClientRect().top - elTop
        };
      }
    }
    setFocusedThreadParentId(parentId);
    setFocusTrigger((n) => n + 1);
  }, []);
  const [composer, setComposer] = useState("");
  // False from the start when the cache seeded `thread` above - the
  // conversation is already on screen, the mount fetch is a revalidation.
  const [loading, setLoading] = useState(
    () => peekCache<ThreadResponse>(`/runner/data/thread/${threadId}`) === undefined
  );
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [sending, setSending] = useState(false);
  // Synchronous re-entrancy guard. The `sending` state lags a render, so a
  // held Cmd+Enter autorepeat (or click + shortcut in one frame) can clear
  // two distinct clientSendIds before it flips — sending the message twice.
  const sendingRef = useRef(false);
  const [reassessing, setReassessing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [transforming, setTransforming] = useState<"SHORTEN" | "MAKE_WARMER" | null>(null);
  // Mirrors the live route thread id so an in-flight transform that resolves
  // AFTER the operator navigates to another thread can detect the switch and
  // refuse to write A's text into B's composer. Synced in the threadId reset
  // effect (the one place that fires on navigation, before B loads).
  const transformRouteIdRef = useRef<string>(threadId);
  // Threads on which the operator has explicitly dismissed the AI predraft
  // (Discard / Delete draft). applyThread must not re-inject a predraft the
  // operator just cleared; keyed by route thread id, cleared on navigation.
  const predraftDismissedRef = useRef<Set<string>>(new Set());
  const [composeIntent, setComposeIntent] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeDraft, setComposeDraft] = useState("");
  const [composeError, setComposeError] = useState<string | null>(null);
  // AI drawer mode: "write" composes a sendable draft in operator voice;
  // "ask" answers a question about this thread without producing a draft.
  // The send-style chevron beside the action button switches between them
  // and a heuristic suggests the other mode when the input shape mismatches.
  const [composeMode, setComposeMode] = useState<"write" | "ask">("write");
  const [composeModeMenuOpen, setComposeModeMenuOpen] = useState(false);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [profileDrawerOpen, setProfileDrawerOpen] = useState(false);
  // Latch the first open of each drawer so the lazy chunk loads on demand and
  // then stays mounted (preserving the existing open-prop open/close path).
  const [receiptsEverOpened, setReceiptsEverOpened] = useState(false);
  const [profileEverOpened, setProfileEverOpened] = useState(false);
  useEffect(() => {
    if (receiptsOpen) setReceiptsEverOpened(true);
  }, [receiptsOpen]);
  useEffect(() => {
    if (profileDrawerOpen) setProfileEverOpened(true);
  }, [profileDrawerOpen]);
  const [error, setError] = useState<string | null>(null);
  // #408. Per-message reaction trigger state (LinkedIn only). The picker
  // id tracks which bubble's emoji row is open; the reacting id is the
  // single in-flight request so its control shows a pending state; the
  // error map surfaces a calm inline failure on the bubble that failed;
  // the optimistic overlay renders the just-applied "OUT" reaction
  // immediately, before the next thread refresh confirms it server-side.
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [reactingMessageId, setReactingMessageId] = useState<string | null>(null);
  const [reactionErrorByMessageId, setReactionErrorByMessageId] = useState<Record<string, string>>({});
  const [optimisticReactionsByMessageId, setOptimisticReactionsByMessageId] = useState<
    Record<string, MessageReaction[]>
  >({});
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingEditMessageId, setSavingEditMessageId] = useState<string | null>(null);
  const [savedEditMessageId, setSavedEditMessageId] = useState<string | null>(null);
  const [editErrorByMessageId, setEditErrorByMessageId] = useState<Record<string, string>>({});
  const [optimisticTextByMessageId, setOptimisticTextByMessageId] = useState<Record<string, string>>({});
  useEffect(() => {
    setEditingMessageId(null);
    setEditDraft("");
    setSavingEditMessageId(null);
    setSavedEditMessageId(null);
    setEditErrorByMessageId({});
    setOptimisticTextByMessageId({});
  }, [threadId]);
  // Optimistic favourite override (R-0066 / #483). null = follow the server
  // value (thread.personFavourite); a boolean wins until the request settles,
  // so the header star flips instantly and reverts if the toggle fails.
  const [favOverride, setFavOverride] = useState<boolean | null>(null);
  // Drop the override when navigating to a different thread so it can't leak
  // onto the next contact (this component persists across /thread/:id changes).
  useEffect(() => {
    setFavOverride(null);
  }, [threadId]);
  const [chipsMenuOpen, setChipsMenuOpen] = useState(false);
  // Defensive 30s ceiling on the suggestions spinner. See the
  // `repliesGenerating` derivation below for why this exists.
  const [suggestionsTimedOut, setSuggestionsTimedOut] = useState(false);
  // Outbound attachments staged in the composer. Cleared after a successful
  // send. Each entry holds the actual File for upload + a previewUrl for the
  // chip thumbnail (image previews; a generic icon for everything else).
  const [composerAttachments, setComposerAttachments] = useState<Array<{
    id: string;
    file: File;
    previewUrl: string;
    kind: "photo" | "voice_note" | "video" | "audio" | "pdf" | "unknown";
  }>>([]);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);
  // Held so the mic stream can be released on unmount even if onstop never
  // runs (e.g. navigating away mid-record).
  const recordingStreamRef = useRef<MediaStream | null>(null);
  // #466 (pilot R-0065): remembers the most recent autocorrection so an
  // immediate Backspace can revert it (iOS-style). Cleared on any other edit.
  const lastAutocorrectRef = useRef<{ original: string; corrected: string; value: string } | null>(null);
  // #462 (pilot R-0061): voice-to-text dictation into the composer. Separate
  // from the iMessage voice-note recorder above (that one sends an audio
  // attachment; this one transcribes speech into editable text).
  const [dictationStatus, setDictationStatus] = useState<"idle" | "recording" | "transcribing">("idle");
  const [dictationAvailable, setDictationAvailable] = useState(false);
  const dictationRecorderRef = useRef<MediaRecorder | null>(null);
  const dictationChunksRef = useRef<BlobPart[]>([]);
  // Held so the mic stream can be released on unmount even if onstop never
  // runs (e.g. navigating away mid-dictation).
  const dictationStreamRef = useRef<MediaStream | null>(null);
  // #462 follow-up: when a dictation transcription fails for a *transient*
  // reason (lost connection to the runner, a proxy hiccup, or a runner-side
  // timeout), keep the already-prepared WAV in memory so the operator can
  // retry the SAME clip with one tap instead of speaking again. The audio is
  // never persisted server-side — this lives only in this page's memory and
  // is dropped on success, on a fresh recording, or on dismiss. The message
  // (non-null) drives the inline retry banner above the composer.
  const failedDictationWavRef = useRef<Blob | null>(null);
  const [dictationRetry, setDictationRetry] = useState<string | null>(null);
  // Source of the current composer text: empty / explicit draft typed
  // by the operator / AI predraft (first suggested reply auto-filled
  // when no explicit draft exists). Drives the "AI predraft" badge.
  const [composerSource, setComposerSource] = useState<"empty" | "draft" | "predraft" | "user">("empty");
  // Whether a draft is persisted in the DB for this thread (issue #486 /
  // pilot R-0067). Drives the "Delete draft" button — it only appears
  // when there's actually a saved draft to remove, never for an AI
  // predraft (no DB row) or unsaved typing. Set on load from the fetched
  // draft, after a successful Save, and cleared after delete / on switch.
  const [hasSavedDraft, setHasSavedDraft] = useState(false);
  // Operator voice profile — its aiHelpLevel decides which AI affordances
  // this page surfaces. The ref mirror lets `refresh` (a useCallback that
  // must not depend on profile) read the latest value when deciding
  // whether to auto-fill a predraft.
  const [profile, setProfile] = useState<OperatorProfile | null>(null);
  const profileRef = useRef<OperatorProfile | null>(null);
  // AI-suggested snooze chips, populated lazily when the operator opens
  // the snooze chip menu. Empty list = AI saw no time hint and refused
  // to fabricate one (correct, expected behaviour for most threads).
  const [snoozeSuggestions, setSnoozeSuggestions] = useState<
    null | { loading: boolean; items: Array<{ label: string; hours: number; reason: string }> }
  >(null);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  // Inspectable popover for the memory chip - opens a quick list of
  // the other threads/notes the AI prompts can pull from.
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Voice-match: rebuilt only when the thread's outbound history
  // changes. Score is debounced against the composer text below.
  const [voiceRewritePending, setVoiceRewritePending] = useState(false);
  // Issue #331. Per-loop coverage verdicts the AI returns for the
  // current draft. "addressed" rows auto-tick at full_drafts (or
  // highlight at writing_support); "partial" rows stay unticked but
  // render a soft "partly covered" hint with a short reason, so the
  // operator can see why the row didn't tick and what's still missing.
  // Cleared when the thread changes or the composer empties; refreshed
  // by a debounced effect that hits /control/thread/:id/check-draft.
  const [aiCoverageItems, setAiCoverageItems] = useState<
    Array<{ loop: string; status: "addressed" | "partial"; reason?: string }>
  >([]);
  const chipsMenuRef = useRef<HTMLDivElement>(null);
  // AI assist rail starts collapsed so a 1-message thread doesn't burn 25%
  // of the viewport on duplicate paraphrases. Operator opens it explicitly.
  const [aiOpen, setAiOpen] = useState(false);
  // Phone-width header: the secondary actions (save draft, snooze, archive)
  // leave no room for the person's name, so below sm they fold into the
  // kebab menu instead. Tracked as state (not a render-time matchMedia
  // read) so rotation / window resizes re-render the menu items.
  const [compactActions, setCompactActions] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setCompactActions(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // How much AI writing help to surface is driven by the operator's
  // configured aiHelpLevel (see the `profile` state below). Full sendable
  // drafts, predraft, and compose-in-voice only appear at "full_drafts".

  // Sibling-threads rail collapse — operator can hide the 240px list to
  // give the chat column more room. State persists in localStorage and
  // toggles with the `]` keyboard shortcut.
  const [threadsCollapsed, setThreadsCollapsed] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("dashboard_threads_collapsed");
    if (stored === "true") setThreadsCollapsed(true);
  }, []);

  // Open the context rail once per thread when there's a brief to show — i.e.
  // a Where it stands or On you string the operator can use to write the
  // reply without scrolling. Previously the rail only auto-opened when the
  // thread had open loops, which left the panel hidden on dormant or
  // social-update threads where the brief is still useful (Brandon-style:
  // "He hasn't asked you anything. Acknowledge the offer, ask what he's
  // looking at now, and you're done.").
  const railAutoOpenForThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!thread || railAutoOpenForThreadRef.current === thread.id) return;
    railAutoOpenForThreadRef.current = thread.id;
    // Below xl the rail is a slide-over covering the conversation, so
    // auto-opening would bury the chat on every thread open. Narrower
    // widths get the pinned brief band instead; the AI button summons
    // the rail on demand.
    if (!window.matchMedia("(min-width: 1280px)").matches) return;
    const brief = thread.replyBrief;
    const hasBriefContent = Boolean(
      brief && (brief.where_it_stands?.trim() || brief.on_you?.trim())
    );
    if (
      hasBriefContent ||
      thread.openLoops.length > 0 ||
      thread.dismissedOpenLoops.length > 0
    ) {
      setAiOpen(true);
    }
  }, [thread]);

  useEffect(() => {
    window.localStorage.setItem(
      "dashboard_threads_collapsed",
      threadsCollapsed ? "true" : "false"
    );
  }, [threadsCollapsed]);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "]") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      setThreadsCollapsed((prev) => !prev);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, []);

  // Scheduled-send picker state. The picker hangs off a chevron next to the
  // Send button; opens a popover with quick presets ("In 1 hour", "Tomorrow
  // 9 am", custom). When the user picks a time, we POST /send with
  // `scheduledFor` and the runner persists a SCHEDULED row instead of
  // enqueuing immediately. The picker also exposes a custom datetime-local
  // input for arbitrary times.
  const [scheduleMenuOpen, setScheduleMenuOpen] = useState(false);
  const [customScheduleValue, setCustomScheduleValue] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [cancellingScheduledId, setCancellingScheduledId] = useState<string | null>(null);
  // Inline edit state for the scheduled-send pill. `editingScheduledId`
  // is the clientSendId of the row currently being edited (null = none),
  // `editingScheduledDraft` is the working textarea value,
  // `editingScheduledTime` is the working <input type="datetime-local">
  // value (local wall-clock, "YYYY-MM-DDTHH:mm"), and `savingScheduledId`
  // flips during the runner round-trip.
  const [editingScheduledId, setEditingScheduledId] = useState<string | null>(null);
  const [editingScheduledDraft, setEditingScheduledDraft] = useState("");
  const [editingScheduledTime, setEditingScheduledTime] = useState("");
  const [originalScheduledTime, setOriginalScheduledTime] = useState("");
  const [savingScheduledId, setSavingScheduledId] = useState<string | null>(null);
  const scheduleMenuRef = useRef<HTMLDivElement>(null);

  // Coarse once-a-minute clock. The late-night LinkedIn schedule nudge below
  // the composer keys off the local time, so this lets it appear/disappear
  // live as the clock crosses the 22:00 / 06:00 quiet-window boundary without
  // the operator needing to re-type. One render a minute is negligible next to
  // the 3s send-queue poll already running on this page.
  const [clockNow, setClockNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setClockNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const [pendingSends, setPendingSends] = useState<
    Array<{
      clientSendId: string;
      text: string;
      sentAt: string;
      failed?: boolean;
      errorMessage?: string;
      // Coarse classification used to render a one-tap recovery action
      // (Open browser / Run selector tests / Reset session / Retry now)
      // instead of dumping a raw error message at the operator.
      errorKind?: "AUTH_REQUIRED" | "SELECTOR_FAIL" | "PROFILE_LOCKED" | "TRANSIENT" | "UNKNOWN";
    }>
  >([]);
  const pendingSendsRef = useRef(pendingSends);
  useEffect(() => {
    pendingSendsRef.current = pendingSends;
  }, [pendingSends]);

  // Sibling cohort for SSE routing (iMessage phone + email handle rows). Held
  // in a ref so the []-stable SSE handler reads the latest cohort without
  // re-subscribing on every thread fetch. Falls back to [threadId] until the
  // first /data/thread payload (or when talking to a runner that predates
  // siblingIds), which makes the match degrade to exact-id — the old behaviour.
  const siblingIdsRef = useRef<string[]>(threadId ? [threadId] : []);
  useEffect(() => {
    siblingIdsRef.current =
      thread?.siblingIds && thread.siblingIds.length > 0
        ? thread.siblingIds
        : threadId
          ? [threadId]
          : [];
  }, [thread?.siblingIds, threadId]);

  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  // #461 (pilot R-0060): controls the floating "jump to latest" button.
  // True when the operator has scrolled up away from the newest message.
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // After a load-older fires, the layout effect needs to put the
  // operator's viewport back where it was. We anchor on a specific
  // visible message element rather than on `prevTop + (newHeight -
  // prevHeight)` because the bare height-delta math is wrong whenever
  // the prepended content isn't the only thing that changes (e.g.,
  // a day-divider is inserted at the prepend/existing boundary, the
  // sticky header re-measures, the load button swaps to "loading…").
  // anchorEl is a React-keyed message DOM node so its identity
  // survives the re-render; viewportOffset is its top relative to
  // the scroller's top at the moment of the snapshot.
  const restoreScrollRef = useRef<{
    anchorEl: HTMLElement;
    viewportOffset: number;
  } | null>(null);
  // The post-load guard's stop fn — held so a new load (or unmount)
  // can cancel the prior guard before installing a new one.
  const anchorGuardStopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    if (anchorGuardStopRef.current) anchorGuardStopRef.current();
  }, []);
  // Tracks the thread.id we last pinned to the bottom for. When this
  // doesn't match the currently loaded thread, the layout effect
  // treats it as a fresh landing (page refresh or thread switch) and
  // unconditionally scrolls to the bottom — bypassing the sticky
  // verification, which would otherwise reject the bottom-pin
  // because the operator hasn't had a chance to scroll yet.
  const lastBottomedThreadIdRef = useRef<string | null>(null);
  const prevThreadIdRef = useRef<string | null>(null);

  // Apply a freshly-fetched thread payload to local state. Extracted so the
  // conversation can paint off /data/thread ALONE (first paint must not wait
  // on the inbox/platforms/logs context fetches), and so a stale-while-
  // revalidate cache hit can paint instantly and then re-apply the network
  // value via this same path.
  const applyThread = useCallback((fresh: ThreadResponse) => {
    // Merge the fresh recent-messages window with any older messages
    // the operator has already paginated in. Without this, every poll
    // (every send, every SSE event, the 3s polling tick) would
    // overwrite the loaded older history and the operator would get
    // yanked back to the bottom — exactly the "I scroll up, more
    // loads, then I get kicked back down" symptom.
    setThread((current) => {
      if (!current || current.id !== fresh.id) return fresh;
      const freshIds = new Set(fresh.messages.map((m) => m.id));
      const olderKept = current.messages.filter((m) => !freshIds.has(m.id));
      return {
        ...fresh,
        messages: [...olderKept, ...fresh.messages],
        // Keep the operator's paginated cursor — fresh.messagePage
        // describes only the recent window and would re-show the
        // "load older messages" button as if no history were loaded.
        messagePage: olderKept.length > 0 ? current.messagePage : fresh.messagePage
      };
    });
    // Ghost-reconcile pendingSends against the freshly-fetched message
    // list. The primary clear paths are the MESSAGE_SENT SSE event and
    // the send-queue poll, both of which key off `clientSendId`. When
    // either misses (SSE drop, race between the event and the page
    // mount, sibling-thread routing on iMessage so the event's threadId
    // doesn't match the user's view) the optimistic bubble used to
    // linger forever, double-rendering on top of the real Message row.
    // Any pending whose text matches a recent OUT message in the
    // freshly-loaded window can be safely dropped — the real bubble is
    // already on screen, the optimistic one is now noise.
    const RECONCILE_WINDOW_MS = 5 * 60 * 1000;
    const freshOutTexts = new Map<string, number>();
    for (const m of fresh.messages) {
      if (m.direction !== "OUT") continue;
      const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
      if (Number.isNaN(ts)) continue;
      const prior = freshOutTexts.get(m.text);
      if (prior === undefined || ts > prior) {
        freshOutTexts.set(m.text, ts);
      }
    }
    setPendingSends((prev) =>
      prev.filter((pending) => {
        if (pending.failed) return true; // keep failed bubbles so the operator can retry
        const ts = freshOutTexts.get(pending.text);
        if (ts === undefined) return true;
        const pendingTs = Date.parse(pending.sentAt);
        if (Number.isNaN(pendingTs)) return false; // can't compare timestamps; trust the text+thread match
        return Math.abs(ts - pendingTs) > RECONCILE_WINDOW_MS;
      })
    );
    setComposer((prev) => {
      if (prev) return prev; // operator already typed something
      const explicitDraft = fresh.draft;
      if (explicitDraft) {
        setComposerSource("draft");
        return explicitDraft;
      }
      // No explicit draft - fall back to AI predraft (first suggested
      // reply) so the operator opens an already-filled composer when
      // /today has pre-warmed the cache. Only when the operator has
      // opted into full AI drafts — at lower help levels the composer
      // stays empty so they write it themselves.
      const aiPredraft = fresh.suggestedReplies?.replies?.[0]?.text?.trim();
      // Don't re-inject a predraft the operator explicitly dismissed on this
      // thread (Discard / Delete draft). transformRouteIdRef.current is the
      // live route thread id (this callback is []-memoised so `threadId` would
      // be stale here).
      if (
        aiPredraft &&
        profileRef.current?.aiHelpLevel === "full_drafts" &&
        !predraftDismissedRef.current.has(transformRouteIdRef.current)
      ) {
        setComposerSource("predraft");
        return aiPredraft;
      }
      return "";
    });
    // Track DB-persisted draft presence independently of the composer
    // text (the operator may have typed over it), so "Delete draft"
    // reflects what's actually saved server-side.
    setHasSavedDraft(Boolean((fresh.draft ?? "").trim()));
    setError(null);
  }, []);

  // Paint the conversation off /data/thread alone. This is the ONLY fetch
  // that gates first paint — time-to-first-message is now a single runner
  // round-trip instead of max(thread, full-inbox, platforms, 150-row-logs).
  // Uses the SWR cache so a hover-prefetched or previously-seen thread paints
  // instantly and revalidates in the background.
  const refreshThread = useCallback(async () => {
    try {
      const fresh = await apiGet<ThreadResponse>(`/runner/data/thread/${threadId}`, {
        swr: true,
        onFresh: (data) => applyThread(data as ThreadResponse)
      });
      applyThread(fresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load thread";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [threadId, applyThread]);

  // Secondary, non-blocking context: the siblings picker, platform cards and
  // the degraded-banner log link. Never gates first paint and is cached, so
  // it is cheap and does not re-fire on the chat-paint path.
  const refreshSiblings = useCallback(async () => {
    const [inboxResult, platformsResult, logsResult] = await Promise.allSettled([
      apiGet<InboxResponse>("/runner/data/inbox", { ttlMs: 5000 }),
      apiGet<PlatformCard[]>("/runner/data/platforms", { ttlMs: 10000 }),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=150", { ttlMs: 5000 })
    ]);
    if (inboxResult.status === "fulfilled") setSiblings(inboxResult.value.rows);
    if (platformsResult.status === "fulfilled") setPlatforms(platformsResult.value);
    if (logsResult.status === "fulfilled") setLogs(logsResult.value);
  }, []);

  // Full refresh used by user actions (send / snooze / schedule / mark-done):
  // paint the thread first, then refresh the surrounding context in the
  // background. SSE-driven refreshes use refreshThread directly so a scan
  // burst never re-pulls the inbox/platforms/logs.
  const refresh = useCallback(async () => {
    await refreshThread();
    void refreshSiblings();
  }, [refreshThread, refreshSiblings]);

  useEffect(() => {
    refresh().catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to load thread";
      setError(message);
      setLoading(false);
    });
  }, [refresh]);

  // Debounced thread-only refresh for SSE bursts. A multi-thread scan emits
  // one THREAD_UPDATED per touched thread; without this, each event triggered
  // a full refetch and the open thread page fired ~N requests and janked.
  // Trailing debounce collapses a burst into a single /data/thread refetch.
  const threadRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleThreadRefresh = useCallback(() => {
    if (threadRefreshTimerRef.current) clearTimeout(threadRefreshTimerRef.current);
    threadRefreshTimerRef.current = setTimeout(() => {
      threadRefreshTimerRef.current = null;
      void refreshThread();
    }, 450);
  }, [refreshThread]);
  useEffect(
    () => () => {
      if (threadRefreshTimerRef.current) clearTimeout(threadRefreshTimerRef.current);
    },
    []
  );

  // Thread-local composer + AI state must NOT leak across threads. The page
  // does not remount when navigating /thread/A -> /thread/B (same App Router
  // dynamic segment), so without this reset a reply typed for A, staged
  // attachments, in-flight optimistic sends, and A's AI snooze suggestions
  // would carry into B — risking A's draft being sent to B. Keyed on the
  // route param so it clears the instant navigation starts, before B loads.
  useEffect(() => {
    // Point the guard ref at the thread we're now on. An in-flight transform
    // started on the previous thread will see this changed value once it
    // resolves and skip its setComposer.
    transformRouteIdRef.current = threadId;
    // A freshly-opened thread starts with its predraft un-dismissed.
    predraftDismissedRef.current.delete(threadId);
    setComposer("");
    setComposerSource("empty");
    setHasSavedDraft(false);
    setComposeIntent("");
    setComposeDraft("");
    setComposeError(null);
    setAskAnswer(null);
    // Clear the in-flight transform flag so the new thread's shorten/warmer
    // buttons aren't stranded disabled by the previous thread's pending call.
    setTransforming(null);
    setSnoozeSuggestions(null);
    setSnoozeMenuOpen(false);
    // The suggested-replies safety-timeout flag is thread-local: it means
    // "we gave up waiting on THIS thread's spinner". The safety-timer effect
    // only clears it when generatingActive flips false, which never happens
    // for a thread that is continuously generating, so it must be reset here
    // on navigation. Otherwise a timeout latched on the previous thread keeps
    // repliesGenerating false for a still-generating next thread and the
    // spinner is replaced by static fallback chips.
    setSuggestionsTimedOut(false);
    setPendingSends([]);
    setComposerAttachments((prev) => {
      for (const a of prev) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
      return [];
    });
  }, [threadId]);

  // Load the operator voice profile once. Reloads on a profile-saved
  // event so an AI-help-level change in Settings lands without a reload.
  useEffect(() => {
    const loadProfile = () => {
      void apiGet<OperatorProfile>("/runner/data/operator-profile")
        .then((data) => {
          profileRef.current = data ?? null;
          setProfile(data ?? null);
        })
        .catch(() => undefined);
    };
    loadProfile();
    window.addEventListener("operator-profile-saved", loadProfile);
    return () => window.removeEventListener("operator-profile-saved", loadProfile);
  }, []);

  // Per-thread rescan in-flight flag. Progress copy renders in the
  // TopStatus ticker ("Checking <name>'s messages"); here it only guards
  // the menu item against double-clicks and flips its label.
  // Cleared when SCAN_THREAD_FINISHED arrives or after a 30s defensive
  // timeout so a missed event can never strand the UI in "rescanning".
  const [rescanStage, setRescanStage] = useState<string | null>(null);
  const rescanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // SSE reconciliation for sends.
  useEffect(() => {
    const onRunnerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        type?: string;
        threadId?: string;
        clientSendId?: string;
        errorMessage?: string;
        errorKind?: "AUTH_REQUIRED" | "SELECTOR_FAIL" | "PROFILE_LOCKED" | "TRANSIENT" | "UNKNOWN";
        stage?: string;
      }>).detail;
      if (!detail || !threadId) return;
      // Sibling-aware routing: accept events for the open thread OR any sibling
      // in its cohort (a split iMessage Person's other handle), so a new inbound
      // / reassess / scan on the other handle refetches the open view.
      if (!shouldRefetchForThreadEvent(detail.threadId, threadId, siblingIdsRef.current)) return;
      if (detail.type === "MESSAGE_SENT" && detail.clientSendId) {
        void refreshThread().finally(() => {
          setPendingSends((prev) => prev.filter((p) => p.clientSendId !== detail.clientSendId));
        });
      } else if (detail.type === "MESSAGE_SEND_FAILED" && detail.clientSendId) {
        const message = detail.errorMessage ?? "Send failed";
        setPendingSends((prev) =>
          prev.map((p) =>
            p.clientSendId === detail.clientSendId
              ? { ...p, failed: true, errorMessage: message, errorKind: detail.errorKind }
              : p
          )
        );
      } else if (detail.type === "SUGGESTED_REPLIES_UPDATED" || detail.type === "THREAD_UPDATED") {
        // Thread-only + debounced: a scan burst of THREAD_UPDATED events
        // collapses into one /data/thread refetch instead of N full refreshes.
        scheduleThreadRefresh();
      } else if (detail.type === "SCAN_THREAD_STARTED") {
        setRescanStage("Opening thread");
        if (rescanTimeoutRef.current) clearTimeout(rescanTimeoutRef.current);
        rescanTimeoutRef.current = setTimeout(() => setRescanStage(null), 30_000);
      } else if (detail.type === "SCAN_THREAD_PROGRESS" && detail.stage) {
        setRescanStage(detail.stage);
      } else if (detail.type === "SCAN_THREAD_FINISHED") {
        setRescanStage(null);
        if (rescanTimeoutRef.current) {
          clearTimeout(rescanTimeoutRef.current);
          rescanTimeoutRef.current = null;
        }
        void refreshThread();
      }
    };
    window.addEventListener("runner-event", onRunnerEvent as EventListener);
    return () => {
      window.removeEventListener("runner-event", onRunnerEvent as EventListener);
      if (rescanTimeoutRef.current) clearTimeout(rescanTimeoutRef.current);
    };
  }, [threadId, refreshThread, scheduleThreadRefresh]);

  // Send-queue polling fallback for SSE-degraded environments.
  useEffect(() => {
    if (!threadId) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (pendingSendsRef.current.length === 0) return;
      try {
        const queue = await apiGet<{
          recent: Array<{
            clientSendId: string;
            threadId: string;
            status: "SENT" | "FAILED";
            errorMessage?: string;
          }>;
        }>("/runner/data/send-queue");
        if (cancelled) return;
        const recentByClientId = new Map(queue.recent.map((row) => [row.clientSendId, row]));
        let sawSent = false;
        const sentIds = new Set<string>();
        const next = pendingSendsRef.current.map((pending) => {
          const match = recentByClientId.get(pending.clientSendId);
          if (!match) return pending;
          if (match.threadId !== threadId) return pending;
          if (match.status === "SENT") {
            sawSent = true;
            sentIds.add(pending.clientSendId);
            return pending;
          }
          if (match.status === "FAILED" && !pending.failed) {
            return {
              ...pending,
              failed: true,
              errorMessage: match.errorMessage ?? "Send failed"
            };
          }
          return pending;
        });
        if (sawSent) {
          await refresh();
          if (cancelled) return;
          setPendingSends((prev) => prev.filter((p) => !sentIds.has(p.clientSendId)));
        } else if (next.some((p, i) => p !== pendingSendsRef.current[i])) {
          setPendingSends(next);
        }
      } catch {
        // Network blip - try again next tick.
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [threadId, refresh]);

  // Suggestions-spinner safety timer. When the runner-side status is
  // "generating", arm a 30s ceiling. If real chips arrive sooner the
  // status flips and this resets. If the status hangs (missed event or
  // a stalled AI call) we flip the local timeout flag so the spinner
  // disappears and fallback chips render.
  const generatingActive =
    thread?.suggestedRepliesStatus === "generating" &&
    (thread?.suggestedReplies.replies.length ?? 0) === 0;
  useEffect(() => {
    if (!generatingActive) {
      setSuggestionsTimedOut(false);
      return undefined;
    }
    const timer = setTimeout(() => setSuggestionsTimedOut(true), 30_000);
    return () => clearTimeout(timer);
  }, [generatingActive]);

  const kindFromMime = (mime: string | undefined, filename: string | undefined): string => {
    const m = (mime ?? "").toLowerCase();
    const n = (filename ?? "").toLowerCase();
    if (m.startsWith("image/")) return "photo";
    if (m.startsWith("video/")) return "video";
    if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
    if (m.startsWith("audio/")) return /audio.message|voice/i.test(n) ? "voice_note" : "audio";
    return "unknown";
  };

  const onSend = useCallback(async () => {
    if (!thread || sending || sendingRef.current) return;
    if (!composer.trim() && composerAttachments.length === 0) return;
    sendingRef.current = true;
    const clientSendId = uuid();
    const text = composer;
    const attachmentsToSend = composerAttachments;
    const sentAt = new Date().toISOString();
    setPendingSends((prev) => [...prev, { clientSendId, text, sentAt }]);
    setComposer("");
    // Reset the source too: an emptied composer must never keep the AI-predraft
    // accent frame + badge (#350). Without this the badge frames a blank input
    // after sending a predraft on the same thread until the operator types.
    setComposerSource(composerSourceAfterClear());
    setComposerAttachments([]);
    setSending(true);
    setError(null);
    stickToBottomRef.current = true;
    try {
      // Snapshot the focused-thread parent at send time so the post-send
      // exit-focus doesn't race the network call and drop the linkage.
      const replyToMessageId = focusedThreadParentId ?? undefined;
      if (attachmentsToSend.length > 0) {
        // Multipart upload - needed for binary file payloads.
        const form = new FormData();
        form.append("text", text);
        form.append("clientSendId", clientSendId);
        if (replyToMessageId) form.append("replyToMessageId", replyToMessageId);
        for (const a of attachmentsToSend) {
          form.append("attachments", a.file, a.file.name);
        }
        const resp = await fetch(`/runner/control/thread/${thread.id}/send`, {
          method: "POST",
          body: form
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(errText || `Send failed (${resp.status})`);
        }
      } else {
        await apiPost(`/runner/control/thread/${thread.id}/send`, {
          text,
          clientSendId,
          ...(replyToMessageId ? { replyToMessageId } : {})
        });
      }
      // Send succeeded — the optimistic clear above already removed these
      // from the composer, so release their image preview object URLs. (On
      // failure we instead restore them below, keeping the URLs alive.)
      for (const a of attachmentsToSend) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Failed to enqueue send";
      setPendingSends((prev) =>
        prev.map((p) =>
          p.clientSendId === clientSendId ? { ...p, failed: true, errorMessage: message } : p
        )
      );
      setError(message);
      setComposer(text);
      // Merge rather than overwrite: prepend the failed attachments to whatever
      // the operator staged while the send was in flight. The optimistic clear
      // emptied the list at send time, so `prev` holds only newly-staged items
      // and there are no duplicates. Overwriting (the old behaviour) discarded
      // those new items and leaked their previewUrl object URLs.
      setComposerAttachments((prev) => restoreFailedAttachments(attachmentsToSend, prev));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [composer, composerAttachments, sending, thread, focusedThreadParentId]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    setComposerAttachments((prev) => [
      ...prev,
      ...list.map((file) => ({
        id: uuid(),
        file,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
        kind: kindFromMime(file.type, file.name) as "photo" | "voice_note" | "video" | "audio" | "pdf" | "unknown"
      }))
    ]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setComposerAttachments((prev) => {
      const next = prev.filter((a) => a.id !== id);
      const removed = prev.find((a) => a.id === id);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  }, []);

  // Revoke any outstanding image preview object URLs when the thread view
  // unmounts (e.g. navigating away mid-compose) so they don't leak.
  const composerAttachmentsRef = useRef(composerAttachments);
  useEffect(() => {
    composerAttachmentsRef.current = composerAttachments;
  }, [composerAttachments]);
  useEffect(
    () => () => {
      for (const a of composerAttachmentsRef.current) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    },
    []
  );

  // Stop any in-progress voice-note / dictation recorder and release its mic
  // stream when the thread view unmounts (e.g. navigating away mid-record) so
  // the microphone isn't left live and the stream/recorder don't leak. The
  // recorders only stop their tracks in onstop, which fires solely on an
  // explicit stop* call that never runs on unmount.
  useEffect(
    () => () => {
      stopRecorderAndStream(recorderRef.current, recordingStreamRef.current);
      recorderRef.current = null;
      recordingStreamRef.current = null;
      stopRecorderAndStream(dictationRecorderRef.current, dictationStreamRef.current);
      dictationRecorderRef.current = null;
      dictationStreamRef.current = null;
    },
    []
  );

  const startRecording = useCallback(async () => {
    if (recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer mp4/aac if supported (Safari + iMessage friendly); fall back
      // to webm/opus everywhere else and let the runner transcode.
      const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: recorder.mimeType });
        const ext = recorder.mimeType.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `Voice Message.${ext}`, { type: recorder.mimeType });
        addFiles([file]);
        stream.getTracks().forEach((t) => t.stop());
        recordingStreamRef.current = null;
      };
      recorder.start();
      recorderRef.current = recorder;
      recordingStreamRef.current = stream;
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access denied");
    }
  }, [addFiles, recording]);

  const stopRecording = useCallback(() => {
    if (!recording || !recorderRef.current) return;
    recorderRef.current.stop();
    recorderRef.current = null;
    setRecording(false);
  }, [recording]);

  // #462: probe once whether the runner can transcribe, so the Dictate
  // control renders enabled vs. disabled-with-explanation.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ dictationAvailable: boolean }>("/runner/data/transcription-capabilities")
      .then((d) => {
        if (!cancelled) setDictationAvailable(Boolean(d?.dictationAvailable));
      })
      .catch(() => {
        /* leave disabled — the button explains why on hover */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // #462 follow-up: POST a prepared 16 kHz WAV to the runner and fold the
  // returned transcript into the composer. Extracted so the initial
  // dictation and the inline "Try again" both submit through one path.
  // Nothing is persisted server-side; on a *transient* failure we keep the
  // WAV in memory (failedDictationWavRef) and show a retry banner so the
  // operator never loses a recording to a dropped connection.
  const submitDictationWav = useCallback(async (wav: Blob) => {
    setDictationRetry(null);
    setDictationStatus("transcribing");
    try {
      const form = new FormData();
      form.append("audio", wav, "dictation.wav");
      let resp: Response;
      try {
        resp = await fetch("/runner/control/transcribe-dictation", {
          method: "POST",
          body: form
        });
      } catch {
        // The request never completed — network / dev-proxy drop. The clip
        // is fine; keep it for a one-tap retry rather than losing the audio.
        failedDictationWavRef.current = wav;
        setDictationRetry(DICTATION_LOST_CONNECTION_MESSAGE);
        return;
      }
      const data = (await resp.json().catch(() => ({}))) as DictationResponseBody;
      const outcome = classifyDictationResponse({
        ok: resp.ok,
        status: resp.status,
        data
      });
      switch (outcome.kind) {
        case "text": {
          failedDictationWavRef.current = null;
          const spoken = outcome.text;
          setComposer((prev) => (prev && !/\s$/.test(prev) ? `${prev} ${spoken}` : `${prev}${spoken}`));
          setComposerSource("user");
          break;
        }
        case "empty":
          failedDictationWavRef.current = null;
          setError("Didn't catch any speech. Try again.");
          break;
        case "retry":
          // Transport / server hiccup — keep the clip and offer a retry.
          failedDictationWavRef.current = wav;
          setDictationRetry(outcome.message);
          break;
        case "error":
          // A specific reason that a retry of the same audio won't fix.
          failedDictationWavRef.current = null;
          setError(outcome.message);
          break;
      }
    } catch (err) {
      // Defensive: anything unexpected after a completed request. Keep the
      // clip so the operator can still retry without re-recording.
      failedDictationWavRef.current = wav;
      setDictationRetry(
        err instanceof Error && err.message
          ? `${err.message}. Your recording is still here, try again.`
          : "Dictation failed. Your recording is still here. Try again."
      );
    } finally {
      setDictationStatus("idle");
    }
  }, []);

  // #462: record a short clip, prepare it as 16 kHz mono WAV, and hand it to
  // submitDictationWav. No autosend; nothing is persisted server-side.
  const startDictation = useCallback(async () => {
    if (dictationStatus !== "idle") return;
    // A fresh recording supersedes any earlier failed clip + retry banner.
    failedDictationWavRef.current = null;
    setDictationRetry(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // webm/opus is the broadly-supported recording format (incl. Firefox);
      // fall back to mp4/aac on Safari. The runner transcodes either way.
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      dictationChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) dictationChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        dictationStreamRef.current = null;
        const raw = new Blob(dictationChunksRef.current, { type: recorder.mimeType });
        if (raw.size === 0) {
          setDictationStatus("idle");
          return;
        }
        setDictationStatus("transcribing");
        // Convert the recording to 16 kHz mono WAV in the browser. The
        // runner's local-whisper provider normalises audio with macOS
        // afconvert, which can't read the webm/opus MediaRecorder emits
        // (and ffmpeg isn't installed); WAV is afconvert-friendly. #462.
        let wav: Blob;
        try {
          wav = await blobToWhisperWav(raw);
        } catch {
          setError("Could not prepare the recording for transcription.");
          setDictationStatus("idle");
          return;
        }
        await submitDictationWav(wav);
      };
      recorder.start();
      dictationRecorderRef.current = recorder;
      dictationStreamRef.current = stream;
      setDictationStatus("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access denied");
      setDictationStatus("idle");
    }
  }, [dictationStatus, submitDictationWav]);

  const stopDictation = useCallback(() => {
    if (dictationStatus !== "recording" || !dictationRecorderRef.current) return;
    dictationRecorderRef.current.stop();
    dictationRecorderRef.current = null;
  }, [dictationStatus]);

  // #462 follow-up: re-submit the last failed clip without re-recording.
  const retryDictation = useCallback(() => {
    const wav = failedDictationWavRef.current;
    if (!wav || dictationStatus !== "idle") return;
    void submitDictationWav(wav);
  }, [dictationStatus, submitDictationWav]);

  const dismissDictationRetry = useCallback(() => {
    failedDictationWavRef.current = null;
    setDictationRetry(null);
  }, []);

  // Cmd/Ctrl-Enter sends.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void onSend();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onSend]);

  // Schedule the current composer text to send at `at`. Closes the picker,
  // refreshes the thread (to pick up the new SCHEDULED row), and clears the
  // composer on success. Errors surface in the existing inline error slot
  // - sends are persisted server-side so an error here is rare (validation
  // only).
  const scheduleSend = useCallback(
    async (at: Date) => {
      if (!thread || !composer.trim() || scheduling) return;
      const clientSendId = uuid();
      const text = composer;
      setScheduling(true);
      setError(null);
      try {
        await apiPost(`/runner/control/thread/${thread.id}/send`, {
          text,
          clientSendId,
          scheduledFor: at.toISOString()
        });
        setComposer("");
        // Reset the source too (see onSend): a scheduled predraft empties the
        // composer, so the predraft badge/frame must not linger over a blank
        // input.
        setComposerSource(composerSourceAfterClear());
        setScheduleMenuOpen(false);
        setCustomScheduleValue("");
        await refresh();
      } catch (sendError) {
        const message = sendError instanceof Error ? sendError.message : "Failed to schedule send";
        setError(message);
      } finally {
        setScheduling(false);
      }
    },
    [composer, refresh, scheduling, thread]
  );

  const cancelScheduledSend = useCallback(
    async (clientSendId: string) => {
      if (!thread) return;
      setCancellingScheduledId(clientSendId);
      try {
        await apiPost(`/runner/control/thread/${thread.id}/cancel-send`, {
          clientSendId
        });
        await refresh();
      } catch (cancelError) {
        const message =
          cancelError instanceof Error ? cancelError.message : "Failed to cancel scheduled send";
        setError(message);
      } finally {
        setCancellingScheduledId(null);
      }
    },
    [refresh, thread]
  );

  const beginEditScheduled = useCallback(
    (clientSendId: string, currentText: string, currentScheduledFor: string | null) => {
      const localTime = toLocalInputValue(currentScheduledFor);
      setEditingScheduledId(clientSendId);
      setEditingScheduledDraft(currentText);
      setEditingScheduledTime(localTime);
      setOriginalScheduledTime(localTime);
      setError(null);
    },
    []
  );

  const cancelEditScheduled = useCallback(() => {
    setEditingScheduledId(null);
    setEditingScheduledDraft("");
    setEditingScheduledTime("");
    setOriginalScheduledTime("");
  }, []);

  const saveEditScheduled = useCallback(
    async (clientSendId: string) => {
      if (!thread) return;
      const text = editingScheduledDraft.trim();
      if (!text) return;
      // Only include scheduledFor when the operator changed it. Sending
      // an unchanged "now-ish" datetime risks the runner's
      // future-only validation rejecting because seconds elapsed
      // between open + save.
      const body: { clientSendId: string; text: string; scheduledFor?: string } = {
        clientSendId,
        text
      };
      if (editingScheduledTime && editingScheduledTime !== originalScheduledTime) {
        const parsed = new Date(editingScheduledTime);
        if (Number.isNaN(parsed.getTime())) {
          setError("Invalid date/time.");
          return;
        }
        body.scheduledFor = parsed.toISOString();
      }
      setSavingScheduledId(clientSendId);
      try {
        await apiPost(`/runner/control/thread/${thread.id}/update-send`, body);
        cancelEditScheduled();
        await refresh();
      } catch (saveError) {
        const message =
          saveError instanceof Error ? saveError.message : "Failed to update scheduled send";
        setError(message);
      } finally {
        setSavingScheduledId(null);
      }
    },
    [cancelEditScheduled, editingScheduledDraft, editingScheduledTime, originalScheduledTime, refresh, thread]
  );

  // Click-outside / Escape closes the schedule picker. Mirrors the
  // suggested-replies dropdown behaviour right below.
  useEffect(() => {
    if (!scheduleMenuOpen) return undefined;
    const onClick = (event: MouseEvent) => {
      if (!scheduleMenuRef.current?.contains(event.target as Node)) {
        setScheduleMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setScheduleMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [scheduleMenuOpen]);

  // Click-outside / Escape closes the suggestion dropdown.
  useEffect(() => {
    if (!chipsMenuOpen) return undefined;
    const onClick = (event: MouseEvent) => {
      if (!chipsMenuRef.current?.contains(event.target as Node)) {
        setChipsMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChipsMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [chipsMenuOpen]);

  const retryPendingSend = (clientSendId: string) => {
    const target = pendingSends.find((p) => p.clientSendId === clientSendId);
    if (!target || !thread) return;
    // Re-queue the existing failed SendRequest under a fresh clientSendId
    // via the runner's /retry-send endpoint (the runner keeps the failed
    // row for receipts and inserts a new PENDING row with the same text).
    setPendingSends((prev) =>
      prev.map((p) =>
        p.clientSendId === clientSendId ? { ...p, failed: false, errorMessage: undefined, errorKind: undefined } : p
      )
    );
    apiPost<{ clientSendId: string }>(`/runner/control/thread/${thread.id}/retry-send`, {
      clientSendId
    })
      .then((r) => {
        // Swap the local pending row's clientSendId so SSE reconciliation
        // matches the new, in-flight one.
        setPendingSends((prev) =>
          prev.map((p) =>
            p.clientSendId === clientSendId ? { ...p, clientSendId: r.clientSendId } : p
          )
        );
      })
      .catch((retryErr: unknown) => {
        const message = retryErr instanceof Error ? retryErr.message : "Retry failed";
        setPendingSends((prev) =>
          prev.map((p) =>
            p.clientSendId === clientSendId ? { ...p, failed: true, errorMessage: message } : p
          )
        );
      });
  };

  const recoveryActionFor = (
    pending: { errorKind?: string; errorMessage?: string; clientSendId: string },
    platform?: string
  ): { label: string; run: () => void } | null => {
    if (!thread) return null;
    const platformName = platform ?? thread.platform;
    switch (pending.errorKind) {
      case "AUTH_REQUIRED":
        if (platformName === "IMESSAGE") {
          return {
            label: "Grant Messages access",
            run: async () => {
              try {
                await apiPost("/runner/control/imessage/permission-reset", {});
                setError(
                  "Permission reset triggered. macOS should re-pop the Allow Messages dialog (or System Settings opened to Automation). Click Allow, then click retry."
                );
              } catch (err) {
                setError(err instanceof Error ? err.message : "Permission reset failed");
              }
            }
          };
        }
        return {
          label: "Open browser to sign in",
          run: () =>
            runAction(
              apiPost("/runner/control/platform/open-browser", { platform: platformName }),
              setError
            )
        };
      case "SELECTOR_FAIL":
        return {
          label: "Run selector tests",
          run: () =>
            runAction(
              apiPost("/runner/control/platform/test-selectors", { platform: platformName }),
              setError,
              refresh
            )
        };
      case "PROFILE_LOCKED":
        return {
          label: "Reset session",
          run: () =>
            runAction(
              apiPost("/runner/control/platform/reset-session", { platform: platformName }),
              setError,
              refresh
            )
        };
      default:
        return null;
    }
  };

  // Server-paginated older-message fetch. Pairs with the runner's
  // `messagePage` field (added in #3): the runner now sends a recent
  // slice and the dashboard requests older pages with `?beforeMessageId`
  // when the operator scrolls near the top of the timeline.
  const loadOlderMessages = async () => {
    if (!thread?.messagePage.hasOlder || !thread.messagePage.olderCursor || loadingOlderMessages) {
      return;
    }
    setLoadingOlderMessages(true);
    try {
      const olderPage = await apiGet<ThreadResponse>(
        `/runner/data/thread/${thread.id}?beforeMessageId=${encodeURIComponent(thread.messagePage.olderCursor)}&messagesLimit=${thread.messagePage.limit}`
      );
      setThread((current) => {
        // Race guard: if the user has navigated to a different thread
        // mid-fetch, the in-flight older-messages response now belongs
        // to a stale thread and would clobber the visible one. Drop it.
        if (!current || current.id !== olderPage.id) {
          return current;
        }
        const existingIds = new Set(current.messages.map((message) => message.id));
        const olderMessages = olderPage.messages.filter((message) => !existingIds.has(message.id));
        return {
          ...current,
          messages: [...olderMessages, ...current.messages],
          messagePage: olderPage.messagePage,
          receipts: olderPage.receipts,
          suggestedReplies:
            olderPage.suggestedRepliesStatus === "ready"
              ? olderPage.suggestedReplies
              : current.suggestedReplies,
          suggestedRepliesStatus:
            olderPage.suggestedRepliesStatus === "ready"
              ? "ready"
              : current.suggestedRepliesStatus
        };
      });
      setError(null);
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "Failed to load older messages";
      setError(message);
    } finally {
      setLoadingOlderMessages(false);
    }
  };

  // `transform` and `composeFromIntent` are defined further down with
  // loading-state tracking for the redesign's button labels - the older
  // duplicate from #62 was dropped here on the post-merge sweep. The
  // `toggleOpenLoop` helper still lives here because it's used by the
  // right-rail open-loops checkboxes.
  const toggleOpenLoop = async (loop: string, dismissed: boolean) => {
    if (!thread) return;
    // Optimistic local update so the checkbox flips immediately. The
    // refresh that follows will reconcile against the runner.
    setThread((current) => {
      if (!current || current.id !== thread.id) return current;
      const dismissedSet = new Set(current.dismissedOpenLoops);
      const activeSet = new Set(current.openLoops);
      if (dismissed) {
        dismissedSet.add(loop);
        activeSet.delete(loop);
      } else {
        dismissedSet.delete(loop);
        activeSet.add(loop);
      }
      return {
        ...current,
        openLoops: Array.from(activeSet),
        dismissedOpenLoops: Array.from(dismissedSet)
      };
    });
    try {
      await apiPost(`/runner/control/thread/${thread.id}/open-loop`, { loop, dismissed });
    } catch (loopError) {
      // Roll back via a fresh refresh; surfacing the error inline is
      // enough - the operator sees the box flip back.
      const message = loopError instanceof Error ? loopError.message : "Failed to update open loop";
      setError(message);
      void refresh();
    }
  };

  const reassessThread = () => {
    if (!thread || reassessing) return;
    setReassessing(true);
    // Issue #369. Reassess is a 5-15s LLM call — ongoing work, not an
    // event. Surface the in-flight state in TopStatus (via
    // signalReassessStart) instead of a static pending toast. The
    // discrete outcome (success / error) still uses the toast surface
    // because those ARE events. This mirrors the surface rule
    // established by #337 for the pilot feedback modal.
    const threadId = thread.id;
    const stopTickerSignal = signalReassessStart(threadId);
    apiPost(`/runner/control/thread/${threadId}/reassess`, {})
      .then(async () => {
        showToast({ kind: "success", title: "Reply Brief refreshed" });
        setError(null);
        await refresh();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        showToast({
          kind: "error",
          title: "Reassess failed",
          description: message,
          durationMs: 9000
        });
      })
      .finally(() => {
        stopTickerSignal();
        setReassessing(false);
      });
  };

  const transform = async (mode: "SHORTEN" | "MAKE_WARMER") => {
    if (!thread || !composer.trim() || transforming) return;
    // Snapshot the route thread id BEFORE the await. The page does not remount
    // across /thread/A -> /thread/B, so a transform fired on A can resolve
    // after navigation; without this guard its setComposer would overwrite B's
    // composer with A's text -> wrong-recipient send.
    const startThreadId = threadId;
    setTransforming(mode);
    setError(null);
    try {
      const output = await apiPost<{ text: string }>(`/runner/control/thread/${thread.id}/transform`, {
        mode,
        text: composer
      });
      if (!shouldApplyThreadScopedResult(startThreadId, transformRouteIdRef.current)) return;
      setComposer(output.text);
    } catch (transformError) {
      if (!shouldApplyThreadScopedResult(startThreadId, transformRouteIdRef.current)) return;
      const message = transformError instanceof Error ? transformError.message : "Transform failed";
      setError(message);
    } finally {
      // Only clear if we're still on the thread that started this transform.
      // After a switch the reset effect already cleared the flag for the new
      // thread; clearing here would clobber a transform B may have started.
      if (shouldApplyThreadScopedResult(startThreadId, transformRouteIdRef.current)) {
        setTransforming(null);
      }
    }
  };

  // #408. Apply an operator reaction to a single LinkedIn message. Mirrors
  // the transform / reassess handlers: a single in-flight id drives the
  // pending state, the catch surfaces a calm per-message inline error, and
  // the finally clears the in-flight flag. The reaction is rendered
  // optimistically (OUT direction) the instant it is sent, then confirmed
  // by refresh(); on failure the optimistic glyph is rolled back.
  const reactToMessage = async (messageId: string, emoji: string) => {
    if (!thread || reactingMessageId) return;
    const optimistic: MessageReaction = { emoji, kind: "emoji", direction: "OUT" };
    setReactionPickerMessageId(null);
    setReactingMessageId(messageId);
    setReactionErrorByMessageId((prev) => {
      if (!(messageId in prev)) return prev;
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    setOptimisticReactionsByMessageId((prev) => ({
      ...prev,
      [messageId]: [...(prev[messageId] ?? []), optimistic]
    }));
    try {
      await apiPost<{ status: string; emoji: string }>(
        `/runner/control/thread/${thread.id}/message/${messageId}/react`,
        { emoji }
      );
      setError(null);
      // The runner has persisted the reaction; the refresh below pulls the
      // authoritative copy. Drop our optimistic overlay for this message so
      // the badge isn't double-counted once the server copy lands.
      setOptimisticReactionsByMessageId((prev) => {
        if (!(messageId in prev)) return prev;
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
      await refresh();
    } catch (reactError) {
      const message = reactError instanceof Error ? reactError.message : "Reaction failed";
      // Roll the optimistic glyph back so the bubble reflects reality, then
      // surface the failure inline on this message only.
      setOptimisticReactionsByMessageId((prev) => {
        const current = prev[messageId];
        if (!current) return prev;
        const idx = current.lastIndexOf(optimistic);
        const trimmed = idx >= 0 ? [...current.slice(0, idx), ...current.slice(idx + 1)] : current;
        const next = { ...prev };
        if (trimmed.length > 0) {
          next[messageId] = trimmed;
        } else {
          delete next[messageId];
        }
        return next;
      });
      setReactionErrorByMessageId((prev) => ({ ...prev, [messageId]: message }));
    } finally {
      setReactingMessageId(null);
    }
  };

  const startMessageEdit = (message: ThreadMessage) => {
    const currentText = optimisticTextByMessageId[message.id] ?? message.text;
    setReactionPickerMessageId(null);
    setEditingMessageId(message.id);
    setEditDraft(currentText);
    setSavedEditMessageId(null);
    setEditErrorByMessageId((prev) => {
      if (!(message.id in prev)) return prev;
      const next = { ...prev };
      delete next[message.id];
      return next;
    });
  };

  const cancelMessageEdit = () => {
    setEditingMessageId(null);
    setEditDraft("");
    setSavedEditMessageId(null);
  };

  const saveMessageEdit = async (messageId: string) => {
    if (!thread || savingEditMessageId) return;
    const nextText = editDraft.trim();
    if (!nextText) {
      setEditErrorByMessageId((prev) => ({ ...prev, [messageId]: "Message cannot be empty" }));
      return;
    }
    setSavingEditMessageId(messageId);
    setSavedEditMessageId(null);
    setEditErrorByMessageId((prev) => {
      if (!(messageId in prev)) return prev;
      const next = { ...prev };
      delete next[messageId];
      return next;
    });
    try {
      const output = await apiPost<{ status: string; text: string }>(
        `/runner/control/thread/${thread.id}/message/${messageId}/edit`,
        { text: nextText }
      );
      const confirmedText = output.text || nextText;
      setOptimisticTextByMessageId((prev) => ({ ...prev, [messageId]: confirmedText }));
      setEditDraft(confirmedText);
      setSavedEditMessageId(messageId);
      setError(null);
      await refresh();
      window.setTimeout(() => {
        setEditingMessageId((current) => (current === messageId ? null : current));
      }, 700);
      window.setTimeout(() => {
        setSavedEditMessageId((current) => (current === messageId ? null : current));
      }, 1800);
    } catch (editError) {
      const message = editError instanceof Error ? editError.message : "Edit failed";
      setEditErrorByMessageId((prev) => ({ ...prev, [messageId]: message }));
    } finally {
      setSavingEditMessageId(null);
    }
  };

  const composeFromIntent = async () => {
    if (!thread) return;
    const intent = composeIntent.trim();
    if (!intent || composing) return;
    setComposing(true);
    setComposeError(null);
    setAskAnswer(null);
    const startThreadId = threadId;
    try {
      const output = await apiPost<{ text: string }>(`/runner/control/thread/${thread.id}/compose`, {
        intent
      });
      // Multi-second LLM call; the page does not remount across /thread/A ->
      // /thread/B, so bail if the operator navigated away rather than writing
      // A's draft into B's drawer (a wrong-recipient hazard).
      if (!shouldApplyThreadScopedResult(startThreadId, transformRouteIdRef.current)) return;
      setComposeDraft(output.text);
    } catch (composeErr) {
      const message = composeErr instanceof Error ? composeErr.message : "Compose failed";
      setComposeError(message);
    } finally {
      setComposing(false);
    }
  };

  const askAi = async () => {
    if (!thread) return;
    const question = composeIntent.trim();
    if (!question || composing) return;
    setComposing(true);
    setComposeError(null);
    setComposeDraft("");
    const startThreadId = threadId;
    try {
      const output = await apiPost<{ answer: string }>(
        `/runner/control/person/${thread.personId}/ask`,
        { question }
      );
      if (!shouldApplyThreadScopedResult(startThreadId, transformRouteIdRef.current)) return;
      setAskAnswer(output.answer ?? "");
    } catch (askErr) {
      const message = askErr instanceof Error ? askErr.message : "Ask failed";
      setComposeError(message);
    } finally {
      setComposing(false);
    }
  };

  const useDraft = () => {
    if (!composeDraft) return;
    setComposer(composeDraft);
    setComposeDraft("");
    setComposeIntent("");
  };

  const degraded = useMemo(() => {
    if (!thread) return undefined;
    // Only surface the error for a platform the operator actually uses
    // (connected at least once); a never-connected platform is "not set
    // up", not "broken". (issue #708)
    return platforms.find((p) => p.platform === thread.platform && isDegradedAndInUse(p));
  }, [platforms, thread]);

  const degradedDomDump = useMemo(() => {
    if (!thread) return undefined;
    return (
      logs.find((log) => log.platform === thread.platform && log.domDumpFile)?.domDumpFile ??
      thread.receipts.find((row) => row.domDumpFile)?.domDumpFile
    );
  }, [logs, thread]);

  // (Removed dead voice-match computation: a per-keystroke
  // scoreDraftAgainstCorpus(composer, …) plus a per-thread buildCorpusStats
  // over the entire OUT history whose result was never rendered — wasted
  // work on the composer's hot path.)

  // Issue #331. Debounced draft-coverage check: ~1.4s after the operator
  // stops typing, ask the runner which open loops the in-flight draft
  // addresses. Skipped at memory_only (the privacy-tightest tier opts
  // out of all AI writing aids), when there are no open loops to score
  // against, and for drafts under 20 chars (saves tokens on stubs like
  // "ok" or "yeah"). The ref guard discards stale responses if the
  // operator keeps typing or switches threads mid-flight.
  const draftCoverageThreadIdRef = useRef<string | null>(null);
  const draftCoverageDraftRef = useRef<string>("");
  // Depend on the specific primitives this effect reads, not the whole
  // `thread` object — `thread` is a fresh reference on every background
  // poll/SSE refresh, which would otherwise re-arm the 1.4s debounce timer
  // continuously and could starve the coverage check during event bursts.
  const draftCoverageThreadId = thread?.id ?? null;
  const draftCoverageOpenLoopCount = thread?.openLoops.length ?? 0;
  useEffect(() => {
    if (!draftCoverageThreadId) return;
    const aiLevel = profile?.aiHelpLevel ?? "writing_support";
    // Functional updater + ref-equal short-circuit so clearing on every
    // re-render doesn't itself become a dependency that re-fires the
    // effect.
    const clearIfNotEmpty = () =>
      setAiCoverageItems((prev) => (prev.length === 0 ? prev : []));
    if (aiLevel === "memory_only") {
      clearIfNotEmpty();
      return;
    }
    const trimmed = composer.trim();
    if (trimmed.length < 20 || draftCoverageOpenLoopCount === 0) {
      clearIfNotEmpty();
      return;
    }
    const threadId = draftCoverageThreadId;
    draftCoverageThreadIdRef.current = threadId;
    draftCoverageDraftRef.current = trimmed;
    const handle = window.setTimeout(() => {
      void apiPost<{ items: Array<{ loop: string; status: "addressed" | "partial"; reason?: string }> }>(
        `/runner/control/thread/${threadId}/check-draft`,
        { draft: trimmed }
      )
        .then((output) => {
          // Latest-write-wins: ignore responses from a stale debounce
          // (operator either kept typing past this fire or moved on
          // to a different thread).
          if (
            draftCoverageThreadIdRef.current !== threadId ||
            draftCoverageDraftRef.current !== trimmed
          ) {
            return;
          }
          setAiCoverageItems(output.items ?? []);
        })
        .catch((coverageError: unknown) => {
          // Coverage is a polish — never escalate to the visible error
          // badge. A console line is enough for debugging without
          // distracting the operator mid-draft.
          console.warn(
            "[draft-coverage]",
            coverageError instanceof Error ? coverageError.message : String(coverageError)
          );
        });
    }, 1400);
    return () => window.clearTimeout(handle);
  }, [composer, draftCoverageThreadId, draftCoverageOpenLoopCount, profile?.aiHelpLevel]);

  // Reset AI coverage when the thread changes — local state from the
  // previous thread shouldn't bleed into a new one.
  useEffect(() => {
    setAiCoverageItems([]);
    draftCoverageThreadIdRef.current = null;
    draftCoverageDraftRef.current = "";
  }, [thread?.id]);

  // Pagination is now driven by the runner: `thread.messages` is whatever
  // the latest fetch returned (initial slice or initial + lazily-pulled
  // older pages). `messagePage.hasOlder` tells us whether more history
  // exists on the server.
  // Render-time filter on top of the runner's API filter. Drops:
  //   - iMessage "kept an audio message" system events (the runner
  //     hides these too; this is belt-and-braces);
  //   - bubbles with no displayable content at all (empty text + no
  //     playable attachments + no transcript) so the thread never
  //     paints a literally-blank bubble.
  // Memoized on thread.messages so a keystroke in the composer (which
  // re-renders this 4000-line component) or a 3s poll tick does NOT re-run
  // this full filter pass and hand a fresh array reference to the reaction-
  // fold and reply-graph memos below — they only recompute when messages
  // actually change.
  const visibleMessagesBeforeReactionFold: ThreadMessage[] = useMemo(
    () =>
      (thread?.messages ?? []).filter((m) => {
        if (isNonContentIMessageSystemEvent(m.text)) return false;
        const text = (m.text ?? "").trim();
        const hasText = text.length > 0;
        const hasPlayable = (m.attachments ?? []).some(
          (a) => Boolean(a.guid) && a.kind !== undefined && a.kind !== "unknown"
        );
        const hasTranscript =
          !!m.audioTranscription &&
          m.audioTranscription.status === "transcribed" &&
          !!m.audioTranscription.transcript &&
          m.audioTranscription.transcript.trim().length > 0;
        return hasText || hasPlayable || hasTranscript;
      }),
    [thread?.messages]
  );
  // #422: iMessage stores arbitrary-emoji reactions as "Reacted X to
  // 'Y'" text bubbles when either party isn't on iOS 18. Collapse those
  // synthesised bubbles into reaction stickers on the parent so the
  // operator sees the same UI as native ❤️/👍 tapbacks.
  const { synthesizedByParentId: synthesizedReactionsByParentId, hiddenMessageIds: synthesizedReactionHiddenIds } =
    useMemo(
      () =>
        foldSynthesizedReactions(
          visibleMessagesBeforeReactionFold.map((m) => ({
            id: m.id,
            direction: m.direction,
            text: m.text ?? ""
          }))
        ),
      [visibleMessagesBeforeReactionFold]
    );
  const visibleMessages: ThreadMessage[] = useMemo(
    () => visibleMessagesBeforeReactionFold.filter((m) => !synthesizedReactionHiddenIds.has(m.id)),
    [visibleMessagesBeforeReactionFold, synthesizedReactionHiddenIds]
  );
  const hasOlder = thread?.messagePage.hasOlder ?? false;

  // Threaded-reply lookups — unifies two sources:
  //   (1) Apple-native: child carries `raw.replyToGuid` from chat.db's
  //       `thread_originator_guid`, resolved against another row's
  //       `platformMessageKey`.
  //   (2) App-level: child carries `replyToMessageId` (a Message.id cuid)
  //       set by the dashboard's focused-thread composer.
  // Either way we end up with a parent cuid → child cuids map plus a
  // per-child parent pointer the render code consumes uniformly.
  const { messageById, replyCountByParentId, replyChildIdsByParentId, parentIdOf } = useMemo(() => {
    const byKey = new Map<string, ThreadMessage>();
    const byId = new Map<string, ThreadMessage>();
    for (const m of visibleMessages) {
      byId.set(m.id, m);
      if (m.platformMessageKey) byKey.set(m.platformMessageKey, m);
    }
    const parentOf = new Map<string, string>();
    const counts = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const m of visibleMessages) {
      let parentId: string | undefined;
      if (m.replyToMessageId && byId.has(m.replyToMessageId)) {
        parentId = m.replyToMessageId;
      } else {
        const parentGuid = (m.raw as { replyToGuid?: string } | undefined)?.replyToGuid;
        if (parentGuid) {
          const parent = byKey.get(parentGuid);
          if (parent) parentId = parent.id;
        }
      }
      if (parentId) {
        parentOf.set(m.id, parentId);
        counts.set(parentId, (counts.get(parentId) ?? 0) + 1);
        const list = children.get(parentId) ?? [];
        list.push(m.id);
        children.set(parentId, list);
      }
    }
    return {
      messageById: byId,
      replyCountByParentId: counts,
      replyChildIdsByParentId: children,
      parentIdOf: parentOf
    };
  }, [visibleMessages]);

  // Focused thread: see state declaration up top (lifted there so the
  // send callback closes over it). The derived state below depends on
  // `messageById` which is only available after `visibleMessages` is
  // computed, so it stays here.
  const focusedParentMessage = focusedThreadParentId
    ? (messageById.get(focusedThreadParentId) ?? null)
    : null;
  // The set of message ids that are "in focus" — the parent + every
  // reply linked to it. Used by the render to bright-light those bubbles
  // and dim/blur everything else, matching Messages.app's focused-thread
  // overlay. When no focus, the set is null and every bubble renders at
  // full opacity.
  const focusedIdSet = useMemo<Set<string> | null>(() => {
    if (!focusedThreadParentId) return null;
    const childIds = replyChildIdsByParentId.get(focusedThreadParentId) ?? [];
    return new Set<string>([focusedThreadParentId, ...childIds]);
  }, [focusedThreadParentId, replyChildIdsByParentId]);
  useEffect(() => {
    // Clear focused thread when navigating to a different thread so the
    // user doesn't carry stale focus across conversations.
    setFocusedThreadParentId(null);
  }, [thread?.id]);
  useEffect(() => {
    if (!focusedThreadParentId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocusedThreadParentId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusedThreadParentId]);
  // Click-outside-to-exit. Anything that isn't a focused bubble, the
  // composer, the sticky "FOCUSED THREAD" pill, or another "Focus
  // thread" chip (which should swap focus, not dismiss) exits focused
  // mode — Messages.app's tap-outside model.
  // We use `click` (not `mousedown`) so the focusOnParent handler that
  // activates focus has already updated state by the time we arrive,
  // and we use `setTimeout(..., 0)` to push the listener attachment
  // past the current click's bubbling phase — otherwise the same
  // click that activated focus would also dismiss it.
  useEffect(() => {
    if (!focusedThreadParentId) return;
    let cancelled = false;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const focusedBubble = target.closest('[data-focused-bubble="true"]');
      const composer = target.closest('[data-thread-composer="true"]');
      const pill = target.closest('[data-focused-pill="true"]');
      const focusSwap = target.closest('button[title^="Focus"]');
      if (focusedBubble || composer || pill || focusSwap) return;
      setFocusedThreadParentId(null);
    };
    // Delay listener arming so the focusing click itself doesn't
    // immediately dismiss. 200ms covers test-runner / extension
    // emulated event sequences that fire a trailing synthetic event
    // after the React click handler runs.
    const handle = setTimeout(() => {
      if (cancelled) return;
      document.addEventListener("click", onClick);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(handle);
      document.removeEventListener("click", onClick);
    };
  }, [focusedThreadParentId]);
  // Bring the focused parent into view when the focus changes. Two
  // pieces of timing care:
  //   1. Flip `stickToBottomRef` off so the global timeline
  //      useLayoutEffect doesn't immediately snap scrollTop back to
  //      scrollHeight after our scroll (it fires on every
  //      visibleMessages re-creation).
  //   2. Scroll the timeline container EXPLICITLY rather than relying
  //      on element.scrollIntoView's "nearest scrollable ancestor"
  //      heuristic, which picks the wrong context on multi-monitor /
  //      Retina setups and silently no-ops.
  // We use a useLayoutEffect so the scroll happens synchronously after
  // DOM update, before the browser paints — same frame as the dim/blur
  // class applies, so users see them animate together rather than the
  // dim happen, pause, then the scroll yank.
  useLayoutEffect(() => {
    const container = timelineRef.current;
    if (!focusedThreadParentId) {
      // Exit: restore the operator's pre-focus visual position by
      // re-pinning the message they were looking at. Numeric scrollTop
      // restoration drifts when the layout has shifted during focus
      // (collapsed bubbles re-expanding, late-loaded attachments,
      // reply-context placeholders filling in), so we anchor on the
      // specific message instead. The settling guard re-pins through
      // the 300ms collapse-back transition.
      if (container && preFocusAnchorRef.current) {
        const { anchorEl, viewportOffset } = preFocusAnchorRef.current;
        preFocusAnchorRef.current = null;
        if (container.contains(anchorEl)) {
          repinAnchor(container, anchorEl, viewportOffset);
          if (anchorGuardStopRef.current) anchorGuardStopRef.current();
          anchorGuardStopRef.current = startPostLoadAnchorGuard(container, anchorEl, viewportOffset);
        }
      }
      return;
    }
    stickToBottomRef.current = false;
    const target = container?.querySelector(
      `[data-message-id="${focusedThreadParentId}"]`
    ) as HTMLElement | null;
    if (!container || !target) return;
    // #465 (pilot R-0064): position the focused message as HIGH as
    // possible — its top sits just below the sticky header — rather than
    // centring it, so the message and the replies beneath it read
    // top-down. scrollTop clamps at the bottom, so a focused message near
    // the end of the thread still lands as high as the remaining content
    // allows. Bubbles + dividers collapse over 150ms (see bubble/DayDivider
    // className), so re-align on every layout change during that window
    // rather than relying on a one-shot calculation.
    const realignToTop = () => {
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      // FOCUS_HEADER_OFFSET matches the scroller's scrollPaddingTop so the
      // message clears the glassy sticky header.
      const FOCUS_HEADER_OFFSET = 64;
      const delta = (targetRect.top - containerRect.top) - FOCUS_HEADER_OFFSET;
      container.scrollTop = container.scrollTop + delta;
    };
    realignToTop();
    if (anchorGuardStopRef.current) anchorGuardStopRef.current();
    anchorGuardStopRef.current = startScrollSettlingGuard(container, realignToTop);
    // `focusTrigger` is included so clicking a chip whose parent is
    // already the current focus re-aligns rather than no-opping.
  }, [focusedThreadParentId, focusTrigger]);

  // Group-chat detection (#753). The runner now sends the authoritative
  // Thread.isGroup flag; the sender-count heuristic stays as a fallback
  // for older runners (2+ distinct inbound sender names = group). False
  // positives on a 1:1 whose contact display name changed mid-thread are
  // tolerable in the fallback - the popover still shows useful info.
  const isGroupChat = useMemo(() => {
    if (typeof thread?.isGroup === "boolean") return thread.isGroup;
    const senders = new Set<string>();
    for (const m of visibleMessages) {
      if (m.direction === "IN" && m.senderName) senders.add(m.senderName);
      if (senders.size > 1) return true;
    }
    return false;
  }, [thread?.isGroup, visibleMessages]);
  const [participantPopover, setParticipantPopover] = useState<string | null>(null);

  // Annotate each message with a date-divider flag/label so consecutive
  // messages crossing a date boundary get a centered hairline label
  // (e.g. "Tuesday, Jan 12") rendered above the bubble.
  const dateLabelFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric"
      }),
    []
  );
  const timelineRows = useMemo(() => {
    let lastDate = "";
    return visibleMessages.map((message) => {
      const dateKey = new Date(message.timestamp).toDateString();
      const showDivider = dateKey !== lastDate;
      lastDate = dateKey;
      return {
        message,
        showDivider,
        dividerLabel: showDivider ? dateLabelFormatter.format(new Date(message.timestamp)) : ""
      };
    });
  }, [visibleMessages, dateLabelFormatter]);

  // Sibling-thread list: surface the operator's other open conversations
  // alongside the current thread so they can jump between them without
  // bouncing to /today. Sort RED → AMBER → GREEN, then by recency.
  const siblingRows = useMemo(() => {
    const order: Record<"RED" | "AMBER" | "GREEN", number> = { RED: 0, AMBER: 1, GREEN: 2 };
    return [...siblings]
      .filter((row) => siblingPlatform === "all" || row.platform === siblingPlatform)
      .sort((a, b) => {
        const riskDiff = (order[a.riskLevel] ?? 3) - (order[b.riskLevel] ?? 3);
        if (riskDiff !== 0) return riskDiff;
        const aAt = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
        const bAt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
        return bAt - aAt;
      });
  }, [siblings, siblingPlatform]);

  // Force-scroll-to-bottom when switching threads.
  useEffect(() => {
    if (thread && prevThreadIdRef.current !== thread.id) {
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
      prevThreadIdRef.current = thread.id;
    }
  }, [thread]);

  // After every layout pass that affects the timeline, do one of:
  //  (a) restore scroll position by re-pinning a captured anchor
  //      element to its previous viewport offset (we just prepended
  //      older messages and the operator should stay on the same
  //      message they were looking at)
  //  (b) jump to bottom (fresh thread or stickToBottomRef is true)
  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    if (restoreScrollRef.current) {
      const { anchorEl, viewportOffset } = restoreScrollRef.current;
      restoreScrollRef.current = null;
      if (el.contains(anchorEl)) {
        repinAnchor(el, anchorEl, viewportOffset);
        if (anchorGuardStopRef.current) anchorGuardStopRef.current();
        anchorGuardStopRef.current = startPostLoadAnchorGuard(el, anchorEl, viewportOffset);
      }
      return;
    }
    // First layout pass for this thread.id — fresh landing (page
    // refresh, thread switch). Always pin to the bottom regardless
    // of the sticky ref's verification, since scrollTop is 0 here
    // (the page just rendered) and the verification would otherwise
    // reject the legitimate bottom-pin. Then keep re-pinning for a
    // short window so attachment images and other async content that
    // loads after the initial layout pass don't leave the operator
    // shy of the actual most-recent message.
    if (thread && lastBottomedThreadIdRef.current !== thread.id) {
      lastBottomedThreadIdRef.current = thread.id;
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
      if (anchorGuardStopRef.current) anchorGuardStopRef.current();
      anchorGuardStopRef.current = startInitialBottomGuard(el);
      return;
    }
    if (stickToBottomRef.current) {
      // Verify the ref against the operator's actual scroll position
      // before yanking them down. The ref is set to true in places
      // that pre-state assumptions (focus exit, send, scrolled near
      // bottom) and is supposed to be flipped off by the onScroll
      // handler when the operator scrolls up — but if React hasn't
      // dispatched the scroll event yet (programmatic scroll races,
      // fast scroll bursts), the ref can be stale. A refresh
      // (THREAD_UPDATED, send completion, etc.) firing in that window
      // would otherwise pin the operator to the bottom mid-read.
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      // 4× the scroll-handler threshold gives the new-message-at-bottom
      // case (most common reason this branch fires) plenty of headroom
      // while still rejecting "operator is way up the thread" cases.
      if (distanceFromBottom < SCROLL_BOTTOM_THRESHOLD * 4) {
        el.scrollTop = el.scrollHeight;
      } else {
        stickToBottomRef.current = false;
      }
    }
  }, [visibleMessages, pendingSends.length, loading, thread]);

  const onTimelineScroll = (event: React.UIEvent<HTMLDivElement>) => {
    // In focused-thread mode, suppress both the bottom-stickiness
    // tracking and the load-older trigger. Scroll inside the focused
    // stack is naturally bounded by the collapsed background, and
    // pulling in new history would shift the underlying timeline so
    // exit-focus lands the operator far from where they started.
    if (focusedThreadParentId) {
      // The jump-to-latest affordance is meaningless inside the bounded
      // focused stack — keep it hidden there.
      if (showJumpToLatest) setShowJumpToLatest(false);
      return;
    }
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < SCROLL_BOTTOM_THRESHOLD;
    // #461 (pilot R-0060): surface the floating jump-to-latest button once
    // the operator has scrolled meaningfully up from the newest message.
    setShowJumpToLatest(distanceFromBottom > JUMP_TO_LATEST_THRESHOLD);
    // Scroll near the top + server says more exists → request the next
    // older page. Capture an anchor element (the topmost visible message
    // bubble below the sticky header) and its viewport offset so the
    // layout effect above can re-pin it once the prepended messages
    // render. Element-anchored preservation handles structural shifts
    // (extra day-dividers at the prepend boundary, etc.) that the
    // earlier prevHeight/prevTop math couldn't.
    if (el.scrollTop < SCROLL_TOP_THRESHOLD && hasOlder && !loadingOlderMessages) {
      const elTop = el.getBoundingClientRect().top;
      const anchorEl = pickScrollAnchor(el, elTop);
      if (anchorEl) {
        restoreScrollRef.current = {
          anchorEl,
          viewportOffset: anchorEl.getBoundingClientRect().top - elTop
        };
      }
      void loadOlderMessages();
    }
  };

  // #461 (pilot R-0060): jump straight back to the newest message and
  // re-arm bottom-stickiness so subsequent inbound messages keep the
  // operator pinned at the foot of the thread.
  const scrollToLatest = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  if (!thread) {
    // `loading` flips false the moment the fetch settles. A failed fetch
    // (stale / removed thread id, runner unreachable) leaves `thread` null
    // with an `error` set — render that instead of a "Loading…" that would
    // otherwise hang forever with the error trapped in the unreached main
    // render below.
    return (
      <div className="px-5 pt-14 sm:px-12">
        {loading ? (
          <BrandLoader />
        ) : (
          <div className="max-w-[440px]">
            <p className="m-0 mb-2 font-display text-[18px] font-semibold text-ink">
              Can’t open this thread.
            </p>
            <p className="m-0 mb-4 text-[13px] leading-[1.55] text-ink-3">
              {error ??
                "This conversation could not be loaded. It may have been removed, or the runner is unavailable."}
            </p>
            <Link
              href="/today"
              className="inline-block rounded-[8px] bg-ink px-3 py-[6px] text-[12px] font-medium text-paper hover:opacity-90"
            >
              Back to Today
            </Link>
          </div>
        )}
      </div>
    );
  }

  const firstName = thread.personName.split(/\s+/)[0] ?? thread.personName;
  const risk = toDisplayRisk(thread.riskLevel);

  // Favourite star in the header (R-0066 / #483). Optimistic: flip locally,
  // persist, then refresh so the inbox/today views re-sort; revert on failure.
  const favourite = favOverride ?? thread.personFavourite ?? false;
  const toggleFavourite = () => {
    const next = !favourite;
    const personId = thread.personId;
    const startThreadId = threadId;
    setFavOverride(next);
    void setFavourite(personId, next)
      .then(() => refresh())
      .catch(() => {
        // favOverride is thread-local; don't revert it onto a different thread
        // if the operator navigated away before this request failed.
        if (shouldApplyThreadScopedResult(startThreadId, transformRouteIdRef.current)) {
          setFavOverride(!next);
        }
      });
  };

  // Late-night LinkedIn send nudge (see lib/late-night-send.ts). Shown only
  // while a LinkedIn draft is open inside the 22:00 to 06:00 quiet window; one
  // click schedules the draft for the next 08:00 instead of pinging the
  // recipient at an odd hour. Hidden while an immediate send is in flight.
  const showLateNightNudge =
    !sending &&
    shouldOfferLateNightSchedule({
      platform: thread.platform,
      hasDraft: composer.trim().length > 0,
      now: clockNow
    });
  const lateNightSlot = showLateNightNudge ? nextMorningSendSlot(clockNow) : null;
  let lastInboundAt: string | null = null;
  for (let i = thread.messages.length - 1; i >= 0; i -= 1) {
    const message = thread.messages[i];
    if (message && message.direction === "IN") {
      lastInboundAt = message.timestamp;
      break;
    }
  }
  const lastTimestamp = thread.messages[thread.messages.length - 1]?.timestamp ?? null;
  const riskLabel =
    risk === "overdue"
      ? `overdue · last reply ${formatRelative(lastInboundAt)}`
      : risk === "waiting"
        ? `waiting · last reply ${formatRelative(lastInboundAt)}`
        : `fresh · last reply ${formatRelative(lastTimestamp)}`;

  // Suggestion source: prefer runner-generated chips when present,
  // otherwise fall back to the static prototype set so the dropdown is
  // never empty. The runner now exposes `suggestedRepliesStatus` and a
  // `source` describing which provider produced the chips (and whether
  // fallback fired) - both surfaced inline below.
  const repliesReady = thread.suggestedReplies.replies.length > 0;
  const serverSaysGenerating =
    thread.suggestedRepliesStatus === "generating" && !repliesReady;
  // Defensive 30s timeout: if the runner reports "generating" but the
  // SUGGESTED_REPLIES_UPDATED event is missed (or the AI call hangs in
  // a way that never lands a status update), the spinner would stay
  // pinned forever. After 30s we locally fall back to the static
  // suggestion set so the operator isn't blocked. If the runner does
  // eventually finish, the next thread refresh swaps in real chips.
  const repliesGenerating = computeRepliesGenerating(serverSaysGenerating, suggestionsTimedOut);
  const chips = repliesReady
    ? thread.suggestedReplies.replies.slice(0, 3).map((reply) => ({
        intent: reply.intent,
        glyph: "↵",
        text: reply.text
      }))
    : FALLBACK_SUGGESTIONS.map((s) => ({ intent: s.intent, glyph: s.glyph, text: s.build(firstName) }));
  const fallbackSource = thread.suggestedReplies.source?.fellBackFromProviderId
    ? thread.suggestedReplies.source
    : null;

  // Right-rail framing splits on `needsReply`:
  // - active reply (contact's message is newest): rail surfaces what they're
  //   waiting on + topical open loops + reply chips
  // - reopen (operator already replied or thread dormant): rail surfaces a
  //   warm reconnect hook + transcript-grounded callbacks + conversation
  //   starters in the chips
  // The Reply Brief itself is generated mode-aware on the server. This page
  // only flips the compose helper + the AI predraft heading on reopen.
  const isReopenMode = thread.needsReply === false;
  const composeHelper = isReopenMode
    ? "Type shorthand for a fresh opener. The AI writes the message in your voice grounded in things from the transcript."
    : "Type shorthand. The AI composes a full reply in your voice. For polishing an existing draft, use the “rewrite in my voice” action above the composer instead.";

  // AI help level gates which writing affordances this page surfaces.
  // It NEVER hides the summary, "what they want", open loops, or memory —
  // those are the core support and stay on at every level.
  //   - full_drafts:     suggested replies + Compose-a-full-draft + rewrites
  //   - writing_support: rewrites ("shorten" / "warmer") on the operator's
  //                      own draft, but no complete AI-written drafts
  //   - memory_only:     no AI writing help at all (Ask is still allowed —
  //                      it answers from the thread, it doesn't draft)
  const aiHelpLevel = profile?.aiHelpLevel ?? "writing_support";
  const showFullDrafts = aiHelpLevel === "full_drafts";
  const showWritingSupport = aiHelpLevel !== "memory_only";
  // When full drafts are off, the compose drawer offers "Ask" only.
  const effectiveComposeMode = showFullDrafts ? composeMode : "ask";

  const platformLabel = PLATFORM_LABEL[thread.platform];

  // Reply Brief, computed once and shared between the always-visible brief
  // band (pinned under the header, the default-visible reply-readiness
  // summary) and the full Reply Brief in the AI rail.
  const displayBrief = chooseDisplayBrief(thread);
  const activeOpenLoops = thread.openLoops.filter(
    (loop) => !thread.dismissedOpenLoops.includes(loop)
  );

  const threadsRailWidth = threadsCollapsed ? "56px" : "240px";
  // Two column plans: lg gets threads rail + chat (the AI rail floats as a
  // slide-over there — docking it too would crush the chat to ~220px), xl
  // and up docks the AI rail as a third column when open.
  const gridColsLg = `${threadsRailWidth} minmax(0,1fr)`;
  const gridColsXl = aiOpen
    ? `${threadsRailWidth} minmax(0,1fr) 360px`
    : `${threadsRailWidth} minmax(0,1fr)`;

  return (
    <div
      // Below lg the rails are hidden, so the grid must be a true single
      // column — the column plans therefore travel in CSS vars that only
      // apply from lg/xl up. Setting gridTemplateColumns as a plain inline
      // style kept the 240px/360px rail tracks reserved at every width,
      // which crushed the conversation into a thin centre strip on phones.
      className="grid h-full min-h-0 grid-cols-1 lg:[grid-template-columns:var(--thread-cols-lg)] xl:[grid-template-columns:var(--thread-cols-xl)]"
      style={
        {
          "--thread-cols-lg": gridColsLg,
          "--thread-cols-xl": gridColsXl
        } as CSSProperties
      }
    >
      {/* ───── Sibling-thread list ───── */}
      <aside
        className={`hidden h-full min-h-0 flex-col overflow-y-auto border-r border-hairline bg-paper-2/30 lg:flex ${
          threadsCollapsed ? "overflow-x-hidden" : ""
        }`}
      >
        <div
          className={`sticky top-0 z-10 border-b border-hairline bg-[color-mix(in_oklch,var(--paper)_72%,transparent)] backdrop-blur-md backdrop-saturate-150 ${
            threadsCollapsed ? "px-1 py-3" : "px-4 py-4"
          }`}
        >
          {threadsCollapsed ? (
            <button
              type="button"
              onClick={() => setThreadsCollapsed(false)}
              aria-label="Expand threads (])"
              title="Expand threads (])"
              className="mx-auto grid h-8 w-8 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
            >
              <PanelLeftOpen className="h-[16px] w-[16px]" strokeWidth={1.6} />
            </button>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                Threads
              </p>
              <div className="flex items-center gap-1">
                <select
                  value={siblingPlatform}
                  onChange={(e) => setSiblingPlatform(e.target.value as "all" | "LINKEDIN" | "IMESSAGE")}
                  className="rounded border border-hairline bg-paper px-1 py-[2px] font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 focus:border-ink-3 focus:outline-none"
                  aria-label="Filter sibling threads by platform"
                >
                  <option value="all">All</option>
                  <option value="LINKEDIN">LinkedIn</option>
                  <option value="IMESSAGE">iMessage</option>
                </select>
                <button
                  type="button"
                  onClick={() => setThreadsCollapsed(true)}
                  aria-label="Collapse threads (])"
                  title="Collapse threads (])"
                  className="grid h-6 w-6 place-items-center rounded-[6px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
                >
                  <PanelLeftClose className="h-[14px] w-[14px]" strokeWidth={1.6} />
                </button>
              </div>
            </div>
          )}
        </div>
        <ul className={`m-0 list-none ${threadsCollapsed ? "space-y-[4px] p-1" : "space-y-[2px] p-2"}`}>
          {siblingRows.map((row) => {
            const active = row.id === thread.id;
            const dotClass =
              row.riskLevel === "RED"
                ? "bg-risk-overdue"
                : row.riskLevel === "AMBER"
                  ? "bg-risk-waiting"
                  : "bg-risk-fresh";
            if (threadsCollapsed) {
              return (
                <li key={row.id}>
                  <Link
                    href={`/thread/${row.id}`}
                    title={`${row.personName} · ${PLATFORM_LABEL[row.platform]}`}
                    className={`relative flex items-center justify-center rounded-row p-1 transition-colors duration-calm ${
                      active ? "bg-paper-2" : "hover:bg-paper-2/60"
                    }`}
                  >
                    <PersonAvatar
                      name={row.personName}
                      avatarUrl={row.personAvatarUrl}
                      size={32}
                      className={`font-mono text-[10px] ${active ? "ring-2 ring-ink/40" : ""}`}
                    />
                    <span
                      className={`absolute -right-[1px] -top-[1px] h-[8px] w-[8px] rounded-full border border-paper ${dotClass}`}
                      aria-hidden
                    />
                  </Link>
                </li>
              );
            }
            return (
              <li key={row.id}>
                <Link
                  href={`/thread/${row.id}`}
                  className={`flex items-start gap-2 rounded-row px-2 py-2 transition-colors duration-calm ${
                    active ? "bg-paper-2" : "hover:bg-paper-2/60"
                  }`}
                >
                  <span
                    className={`mt-[6px] inline-block h-[6px] w-[6px] flex-shrink-0 rounded-full ${dotClass}`}
                    aria-hidden
                  />
                  <PersonAvatar
                    name={row.personName}
                    avatarUrl={row.personAvatarUrl}
                    size={28}
                    className="flex-shrink-0 font-mono text-[10px]"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[12.5px] leading-[1.3] ${
                        active ? "font-semibold text-ink" : "font-medium text-ink-2"
                      }`}
                    >
                      {row.personName}
                    </span>
                    <span className="block truncate font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                      {PLATFORM_LABEL[row.platform]}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
          {siblingRows.length === 0 && !threadsCollapsed ? (
            <li className="px-3 py-3 font-mono text-[11px] text-ink-3">no other threads</li>
          ) : null}
        </ul>
      </aside>

      {/* ───── Chat column ───── */}
      <div className="flex h-full min-h-0 flex-col border-r border-hairline">
        {degraded ? (
          <div className="flex-shrink-0 px-4 pt-6 sm:px-8 lg:px-12">
            <DegradedBanner
              platform={degraded.platform}
              stage={degraded.lastScanFailure?.stage}
              reason={degraded.lastScanFailure?.reason}
              requestId={degraded.lastScanFailure?.requestId}
              errorSummary={degraded.lastScanFailure?.errorSummary ?? degraded.lastError ?? undefined}
              screenshotFile={degraded.lastScanFailure?.screenshotFile}
              domDumpFile={degradedDomDump}
              onRunSelectorTests={() =>
                runAction(
                  apiPost("/runner/control/platform/test-selectors", { platform: degraded.platform }),
                  setError,
                  refresh
                )
              }
              onOpenReceipts={() => setReceiptsOpen(true)}
            />
          </div>
        ) : null}

        <div
          ref={timelineRef}
          onScroll={onTimelineScroll}
          className="relative min-h-0 flex-1 overflow-y-auto"
          // overflowAnchor: disable the browser's native scroll anchoring
          // so it doesn't race with the load-older restoration in
          // useLayoutEffect. When both fire on the same prepend, the
          // browser anchors on its own heuristic-picked element (often a
          // wrapper) and our code anchors on a specific message bubble —
          // the difference shows up as a small visible jolt as the scroll
          // position settles.
          //
          // scrollPaddingTop: the glassy sticky header below sits INSIDE
          // this scroller, so any programmatic scroll (scrollIntoView,
          // future snap-to-message features) would otherwise land target
          // elements at scroll-container-top — i.e. behind the header.
          // Reserving a top scroll-padding zone the size of the header
          // makes those alignments respect the header. Value tuned to the
          // header's resting height (single row, h-9 avatar + py-2.5 ≈
          // 60-64px); if the header grows another row of chips this may
          // need a ref-based measurement.
          style={{ overflowAnchor: "none", scrollPaddingTop: "64px" }}
        >
          {/* Glassy sticky header. Sits inside the scroll container so the
              timeline scrolls visibly behind it - matches the iOS / Apple
              translucent-bar aesthetic the rest of the redesign nods at.
              Single-row layout keeps vertical real estate for the chat.
              Opacity is high (92%) on purpose: at lower values (~70%)
              message bubbles passing behind the bar stayed legible enough
              to read as a layout bug — the operator saw a clipped bubble
              rather than a tinted bar. 92% + backdrop-blur reads as
              frosted glass while making clipped content visually fade. */}
          <div className="sticky top-0 z-10 border-b border-hairline bg-[color-mix(in_oklch,var(--paper)_92%,transparent)] backdrop-blur-md backdrop-saturate-150 px-2 py-2 sm:px-6 sm:py-2.5 lg:px-8">
            <header className="flex items-center gap-1 sm:gap-2">
              <button
                type="button"
                onClick={() => router.push("/today")}
                aria-label="Back to today"
                title="Back to today (Esc)"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
              >
                <ChevronLeft className="h-[16px] w-[16px]" strokeWidth={1.6} />
              </button>
              <button
                type="button"
                onClick={() => setProfileDrawerOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-row px-2 py-1 text-left transition-colors duration-calm hover:bg-paper-2"
                title="Open profile"
              >
                {thread.personAvatarUrl ? (
                  <span className="grid h-9 w-9 place-items-center overflow-hidden rounded-full bg-paper-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thread.personAvatarUrl}
                      alt=""
                      width={36}
                      height={36}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  </span>
                ) : (
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[12px] font-semibold text-white">
                    {initials(thread.personName)}
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <h2 className="m-0 truncate font-display text-[16px] font-semibold tracking-[-0.02em]">
                    {thread.personName}
                  </h2>
                  {/* Single clipped line, never wraps: on a crushed phone
                      header the old flex-wrap stacked "overdue · last reply
                      6d ago" one word per line beside the avatar. */}
                  <p className="m-0 flex min-w-0 items-center gap-x-1 overflow-hidden whitespace-nowrap text-[11px] text-ink-2">
                    <span className="shrink-0 rounded bg-paper-2 px-[5px] py-[1px] text-[9px] font-medium uppercase tracking-[0.04em]">
                      {platformLabel}
                    </span>
                    <span className="truncate text-ink-3">· {riskLabel}</span>
                    {thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now() ? (
                      <span
                        className="ml-1 hidden shrink-0 rounded-full bg-[oklch(94%_0.03_85)] px-2 py-[1px] text-[9px] font-medium uppercase tracking-[0.04em] text-[oklch(45%_0.10_60)] sm:inline"
                        title={`Hidden from active inbox until ${new Date(thread.snoozedUntil).toLocaleString()}`}
                      >
                        Snoozed · wakes {formatScheduledFor(thread.snoozedUntil)}
                      </span>
                    ) : null}
                  </p>
                </div>
              </button>
              {/* Favourite star (R-0066 / #483). Pins this contact so their
                  threads float to the top of the Inbox / Today. Optimistic. */}
              <button
                type="button"
                onClick={toggleFavourite}
                aria-label={favourite ? `Unfavourite ${thread.personName}` : `Favourite ${thread.personName}`}
                aria-pressed={favourite}
                data-testid="thread-favourite-toggle"
                title={favourite ? "Remove favourite" : "Favourite this contact"}
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-[8px] transition-colors duration-calm hover:bg-paper-2",
                  favourite ? "text-accent" : "text-ink-3 hover:text-ink"
                )}
              >
                <Star className="h-[16px] w-[16px]" strokeWidth={1.6} fill={favourite ? "currentColor" : "none"} />
              </button>
              <ActionButton
                variant="ghost"
                runningLabel="Saving…"
                doneLabel="Saved"
                onError={setError}
                action={() =>
                  apiPost(`/runner/control/thread/${thread.id}/draft`, { text: composer })
                }
                onSuccess={() => setHasSavedDraft(composer.trim().length > 0)}
                title="Save draft"
                className="hidden px-2 py-1.5 text-[12px] sm:inline-flex 2xl:px-3"
              >
                <Save className="h-[14px] w-[14px] 2xl:hidden" strokeWidth={1.6} aria-hidden />
                <span className="hidden 2xl:inline">Save draft</span>
              </ActionButton>
              {/* Delete the persisted draft (issue #486 / pilot R-0067).
                  Only shown when a draft is actually saved server-side —
                  the AI predraft has its own local-only "Discard" below.
                  Clearing the composer + hiding this button is the success
                  signal; the inline "Deleting…" covers the in-flight state. */}
              {hasSavedDraft ? (
                <ActionButton
                  variant="ghost"
                  runningLabel="Deleting…"
                  doneLabel="Deleted"
                  onError={setError}
                  action={() =>
                    apiPost(`/runner/control/thread/${thread.id}/delete-draft`, {})
                  }
                  onSuccess={() => {
                    predraftDismissedRef.current.add(thread.id);
                    setComposer("");
                    setComposerSource("empty");
                    setHasSavedDraft(false);
                  }}
                  title="Delete the saved draft for this thread"
                  className="hidden px-2 py-1.5 text-[12px] sm:inline-flex 2xl:px-3"
                >
                  <Trash2 className="h-[14px] w-[14px] 2xl:hidden" strokeWidth={1.6} aria-hidden />
                  <span className="hidden 2xl:inline">Delete draft</span>
                </ActionButton>
              ) : null}
              {/* Clear-thread cluster: wrapped so the guided tour can spotlight
                  snooze + mark-done + archive together (data-demo-target). */}
              <div data-demo-target="thread-actions" className="flex shrink-0 items-center gap-1 sm:gap-2">
                {thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now() ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    runAction(
                      apiPost(`/runner/control/thread/${thread.id}/unsnooze`, {}),
                      setError,
                      refresh
                    )
                  }
                  title="Bring this thread back into the active inbox now"
                  className="hidden px-2 py-1.5 text-[12px] sm:inline-flex 2xl:px-3"
                >
                  <Sun className="h-[14px] w-[14px] 2xl:hidden" strokeWidth={1.6} aria-hidden />
                  <span className="hidden 2xl:inline">Wake up</span>
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => {
                    // Toggle the AI snooze menu, lazily fetching once. The
                    // popover renders above this row when `snoozeMenuOpen`.
                    if (!snoozeMenuOpen && !snoozeSuggestions) {
                      setSnoozeSuggestions({ loading: true, items: [] });
                      void apiGet<{ suggestions: Array<{ label: string; hours: number; reason: string }> }>(
                        `/runner/control/thread/${thread.id}/suggest-snooze`
                      )
                        .then((r) => setSnoozeSuggestions({ loading: false, items: r.suggestions ?? [] }))
                        .catch(() => setSnoozeSuggestions({ loading: false, items: [] }));
                    }
                    setSnoozeMenuOpen((prev) => !prev);
                  }}
                  aria-expanded={snoozeMenuOpen}
                  title="Hide from active inbox until later"
                  className="hidden px-2 py-1.5 text-[12px] sm:inline-flex 2xl:px-3"
                >
                  <Moon className="h-[14px] w-[14px] 2xl:hidden" strokeWidth={1.6} aria-hidden />
                  <span className="hidden 2xl:inline">Snooze</span>
                </Button>
              )}
              <ActionButton
                variant="ghost"
                runningLabel="Marking…"
                doneLabel="Handled"
                onError={setError}
                onSuccess={refresh}
                action={() => apiPost(`/runner/control/thread/${thread.id}/mark-done`, {})}
                title="Mark as handled"
                className="px-2 py-1.5 text-[12px] 2xl:px-3"
              >
                <Check className="h-[14px] w-[14px] 2xl:hidden" strokeWidth={1.6} aria-hidden />
                <span className="hidden 2xl:inline">Mark as handled</span>
              </ActionButton>
              <Button
                variant="ghost"
                disabled={archiving}
                onClick={() => {
                  if (archiving) return;
                  setArchiving(true);
                  // Issue #336. Return to whichever list the operator
                  // came from (Inbox, Reconnect, Archived, At risk…)
                  // rather than always /today; falls back to /today
                  // when no source was recorded (deep link, fresh tab).
                  const returnTo = readThreadSource();
                  runAction(
                    apiPost(`/runner/control/thread/${thread.id}/archive`, {}),
                    (message) => {
                      setError(message);
                      if (message) setArchiving(false);
                    },
                    () => router.push(returnTo)
                  );
                }}
                title="Move this thread out of the active inbox (you can find it in Archived)"
                className="hidden px-2 py-1.5 text-[12px] sm:inline-flex 2xl:px-3"
              >
                <Archive className="h-[14px] w-[14px] 2xl:hidden" strokeWidth={1.6} aria-hidden />
                {/* In-flight label stays visible at icon-only widths — the
                    button must show its own running state inline. */}
                <span className={archiving ? "inline" : "hidden 2xl:inline"}>
                  {archiving ? "Archiving…" : "Archive"}
                </span>
              </Button>
              </div>
              <Button
                variant={aiOpen ? "primary" : "quiet"}
                onClick={() => setAiOpen((v) => !v)}
                title="Toggle the AI assist sidebar"
                className="px-3 py-1.5 text-[12px]"
              >
                <Sparkles className="h-[13px] w-[13px]" strokeWidth={1.6} />
                AI
              </Button>
              <Menu
                align="end"
                trigger={
                  <Button
                    variant="ghost"
                    aria-label="More actions"
                    title="More actions"
                    className="px-2 py-1.5 text-[12px]"
                  >
                    <MoreHorizontal className="h-[14px] w-[14px]" strokeWidth={1.6} />
                  </Button>
                }
                items={[
                  // Phone-width header: the secondary actions live here so
                  // the person's name keeps its space. Menu-launched actions
                  // surface progress via pending/success toasts because the
                  // menu closes on select (no inline button state to show).
                  ...(compactActions
                    ? [
                        {
                          label: "Save draft",
                          onSelect: () =>
                            runActionWithFeedback(
                              apiPost(`/runner/control/thread/${thread.id}/draft`, { text: composer }),
                              {
                                pending: "Saving draft…",
                                success: "Draft saved",
                                setError,
                                onDone: () => setHasSavedDraft(composer.trim().length > 0)
                              }
                            )
                        },
                        ...(hasSavedDraft
                          ? [
                              {
                                label: "Delete draft",
                                onSelect: () =>
                                  runActionWithFeedback(
                                    apiPost(`/runner/control/thread/${thread.id}/delete-draft`, {}),
                                    {
                                      pending: "Deleting draft…",
                                      success: "Draft deleted",
                                      setError,
                                      onDone: () => {
                                        predraftDismissedRef.current.add(thread.id);
                                        setComposer("");
                                        setComposerSource("empty");
                                        setHasSavedDraft(false);
                                      }
                                    }
                                  )
                              }
                            ]
                          : []),
                        thread.snoozedUntil && Date.parse(thread.snoozedUntil) > Date.now()
                          ? {
                              label: "Wake up",
                              onSelect: () =>
                                runAction(
                                  apiPost(`/runner/control/thread/${thread.id}/unsnooze`, {}),
                                  setError,
                                  refresh
                                )
                            }
                          : {
                              label: "Snooze…",
                              onSelect: () => {
                                if (!snoozeSuggestions) {
                                  setSnoozeSuggestions({ loading: true, items: [] });
                                  void apiGet<{ suggestions: Array<{ label: string; hours: number; reason: string }> }>(
                                    `/runner/control/thread/${thread.id}/suggest-snooze`
                                  )
                                    .then((r) =>
                                      setSnoozeSuggestions({ loading: false, items: r.suggestions ?? [] })
                                    )
                                    .catch(() => setSnoozeSuggestions({ loading: false, items: [] }));
                                }
                                setSnoozeMenuOpen(true);
                              }
                            },
                        {
                          label: archiving ? "Archiving…" : "Archive",
                          onSelect: () => {
                            if (archiving) return;
                            setArchiving(true);
                            const returnTo = readThreadSource();
                            runAction(
                              apiPost(`/runner/control/thread/${thread.id}/archive`, {}),
                              (message) => {
                                setError(message);
                                if (message) setArchiving(false);
                              },
                              () => router.push(returnTo)
                            );
                          }
                        }
                      ]
                    : []),
                  {
                    label: reassessing ? "Reassessing…" : "Reassess",
                    onSelect: () => {
                      if (reassessing) return;
                      void reassessThread();
                    }
                  },
                  {
                    // Issue #392 / R-0032. "Remind me to follow up in 3 days"
                    // → AI parses → thread snoozes until then with the
                    // reminder text saved on Thread.reminderText. When the
                    // snooze expires the thread returns to inbox with a
                    // "Reminder: <text>" banner. window.prompt for the
                    // input is intentionally rough — see #392 for the
                    // upcoming dedicated compose-mode polish.
                    label: "Remind me…",
                    onSelect: () => {
                      if (!thread) return;
                      const intent = window.prompt(
                        "Remind me to…\n\nExample: \"follow up with him next Tuesday\" or \"ask about the offer in 3 days\"."
                      );
                      if (!intent || !intent.trim()) return;
                      apiPost<{
                        ok: boolean;
                        remindAt?: string;
                        reminderText?: string;
                        needsClarification?: boolean;
                        reason?: string;
                      }>(`/runner/control/thread/${thread.id}/remind`, { intent: intent.trim() })
                        .then(async (res) => {
                          if (res.ok && res.remindAt && res.reminderText) {
                            const whenLabel = new Date(res.remindAt).toLocaleString(undefined, {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit"
                            });
                            showToast({
                              kind: "success",
                              title: `Reminder set for ${whenLabel}`,
                              description: res.reminderText
                            });
                            await refresh();
                          } else {
                            showToast({
                              kind: "error",
                              title: "Couldn't set the reminder",
                              description:
                                res.reason ??
                                "Try rewriting with a clearer time, like 'in 3 days' or 'next Tuesday'.",
                              durationMs: 9000
                            });
                          }
                        })
                        .catch((err) => {
                          showToast({
                            kind: "error",
                            title: "Reminder failed",
                            description: err instanceof Error ? err.message : String(err),
                            durationMs: 9000
                          });
                        });
                    }
                  },
                  {
                    label: `Open in ${platformLabel}`,
                    onSelect: () =>
                      runAction(apiPost(`/runner/control/thread/${thread.id}/open`, {}), setError)
                  },
                  {
                    // Progress lives in the TopStatus ticker ("Checking
                    // <name>'s messages"), not the thread header — the
                    // menu label only flips while running so a re-click
                    // reads as already in flight.
                    label: rescanStage ? "Checking for new messages…" : "Check for new messages",
                    onSelect: () => {
                      if (rescanStage) return;
                      runAction(
                        apiPost(`/runner/control/thread/${thread.id}/rescan`, {}),
                        setError,
                        refresh
                      );
                    }
                  },
                  { label: "Receipts", onSelect: () => setReceiptsOpen(true) }
                ]}
              />
            </header>
            {/* Always-visible reply-readiness band: what the reply needs to
                do, why it matters, what's still open — so the operator
                understands the thread without opening the AI rail or
                rereading. Pinned with the header. Hidden at lg only when the
                full rail is open (it supersedes the summary there); stays
                visible on mobile, where the rail can't open. */}
            {thread.needsReply !== false ? (
              <div className={aiOpen ? "xl:hidden" : undefined}>
                <ThreadBriefBand
                  onYou={displayBrief.on_you}
                  whereItStands={displayBrief.where_it_stands}
                  openLoops={activeOpenLoops}
                />
              </div>
            ) : null}
          </div>

          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-[18px] px-4 py-3 sm:px-8 lg:px-12">
            {/* Issue #412. "🎂 birthday in N days" pill. Surfaces when
                the contact's birthday is within the next 30 days
                (pilot wanted "in the next month"). Wider than the
                7-day inbox-row threshold because the operator opened
                this specific thread — anything birthday-relevant in
                the next month is worth flagging. Renders the age
                ("turns 30") when birthYear is known. */}
            {(() => {
              if (!thread.personBirthday) return null;
              const days = daysUntilBirthday(thread.personBirthday);
              if (days === null || days > 30) return null;
              const label = birthdayCountdownLabel(days);
              const age = ageOnNextBirthday(thread.personBirthYear ?? null, thread.personBirthday);
              return (
                <div
                  className={cn(
                    "self-center flex items-center gap-2 rounded-pill border border-hairline px-3 py-[6px] text-[12.5px]",
                    days === 0 ? "border-accent-ink text-accent-ink" : "text-ink-2"
                  )}
                >
                  <span>🎂</span>
                  <span>
                    {thread.personName}'s birthday {label}
                    {age ? ` · turns ${age}` : ""}
                  </span>
                </div>
              );
            })()}
            {/* Issue #392. "Remind me to…" banner. Surfaces when the
                operator set a reminder via the kebab menu — visible
                whenever the thread is loaded, so the operator sees
                WHY the thread is in front of them. Cleared on
                unsnooze (server-side) and on the next reassess that
                ships a fresh state. */}
            {thread.reminderText ? (
              <div className="self-center flex items-center gap-3 rounded-row border border-hairline bg-paper-2 px-3 py-[8px] text-[12.5px] text-ink-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">Reminder</span>
                <span>{thread.reminderText}</span>
                {thread.snoozedUntil ? (
                  <span className="font-mono text-[10.5px] text-ink-3">
                    · resurfaces {new Date(thread.snoozedUntil).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit"
                    })}
                  </span>
                ) : null}
              </div>
            ) : null}
            {focusedThreadParentId ? (
              <div
                data-focused-pill="true"
                className="sticky top-2 z-10 flex items-center justify-center gap-3 self-center rounded-full border border-hairline bg-paper/95 px-3 py-[6px] font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 shadow-sm backdrop-blur"
              >
                <span>focused thread · {(replyChildIdsByParentId.get(focusedThreadParentId) ?? []).length} {(replyChildIdsByParentId.get(focusedThreadParentId) ?? []).length === 1 ? "reply" : "replies"}</span>
                <button
                  type="button"
                  onClick={() => setFocusedThreadParentId(null)}
                  className="text-ink-2 hover:text-ink underline-offset-2 hover:underline"
                  title="Esc"
                >
                  exit
                </button>
              </div>
            ) : null}
            {hasOlder && !focusedThreadParentId ? (
              <div className="flex items-center justify-center gap-2 self-center font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                {loadingOlderMessages ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    loading older messages…
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const el = timelineRef.current;
                      if (el) {
                        const elTop = el.getBoundingClientRect().top;
                        const anchorEl = pickScrollAnchor(el, elTop);
                        if (anchorEl) {
                          restoreScrollRef.current = {
                            anchorEl,
                            viewportOffset: anchorEl.getBoundingClientRect().top - elTop
                          };
                        }
                      }
                      void loadOlderMessages();
                    }}
                    className="hover:text-ink"
                  >
                    load older messages
                  </button>
                )}
              </div>
            ) : (
              <div className={`self-center font-mono text-[11px] uppercase tracking-[0.06em] text-ink-4 transition-opacity duration-300 ${focusedThreadParentId ? "opacity-30" : ""}`}>
                start of conversation
              </div>
            )}
            {visibleMessages.map((message, idx) => {
              const prev = visibleMessages[idx - 1];
              const dayLabel = dayDividerLabel(prev?.timestamp, message.timestamp);
              if (message.text.trim() === "[system event]") {
                return (
                  <div key={message.id} className="contents">
                    {dayLabel ? <DayDivider label={dayLabel} /> : null}
                    <div className="self-center font-mono text-[11px] tracking-[0.02em] text-ink-3">
                      · automated reply at {formatClock(message.timestamp)} ·
                    </div>
                  </div>
                );
              }
              // Operator-authored messages always render as "You". The
              // platform-scraped senderName for an outbound bubble is the
              // operator's own platform identity (e.g. their phone number on
              // iMessage, or whatever LinkedIn writes into the bubble header)
              // - never useful as a label, sometimes actively wrong (#129,
              // where iMessage put the contact's number on every bubble).
              const senderLabel =
                message.direction === "OUT"
                  ? "You"
                  : (message.senderName ?? firstName);
              const parentMessageId = parentIdOf.get(message.id);
              const parentMessage = parentMessageId ? messageById.get(parentMessageId) : undefined;
              const replyCount = replyCountByParentId.get(message.id) ?? 0;
              // A message can carry a reply pointer (replyToMessageId or
              // raw.replyToGuid) before its parent is in the loaded
              // window. We render the reply-context stub anyway so the
              // bubble's height doesn't change when an older-messages
              // load brings the parent in — the snippet text just fills
              // in. Same pattern as iMessage / WhatsApp.
              const hasReplyIntent =
                !!message.replyToMessageId ||
                !!(message.raw as { replyToGuid?: string } | undefined)?.replyToGuid;
              // In focused mode, bubbles outside the parent+replies set
              // fade + blur so the focused thread "pops out" like
              // Messages.app's overlay. Pointer events off prevents
              // accidental clicks on the dimmed background.
              const dimmedByFocus = focusedIdSet !== null && !focusedIdSet.has(message.id);
              // A day divider between two focused messages stays; a divider
              // between collapsed bubbles needs to collapse too (otherwise
              // the focused stack gets random "Yesterday" headers from
              // dates that no focused message even touches).
              const dividerInFocusedRange =
                !dimmedByFocus &&
                (idx === 0 || (prev && focusedIdSet ? focusedIdSet.has(prev.id) : true));
              return (
                <div key={message.id} className="contents">
                  {dayLabel ? (
                    <DayDivider
                      label={dayLabel}
                      className={
                        focusedIdSet && !dividerInFocusedRange
                          ? "opacity-0 max-h-0 overflow-hidden my-0 -mt-[18px] pointer-events-none"
                          : ""
                      }
                    />
                  ) : null}
                  <div
                    data-message-id={message.id}
                    data-focused-bubble={focusedIdSet && focusedIdSet.has(message.id) ? "true" : undefined}
                    className={`flex max-w-[86%] flex-col ease-out transition-all sm:max-w-[72%] ${
                      // Focus enter is animated too — same easing as
                      // exit, just faster (150ms vs 300ms) so the
                      // focused stack snaps into view without
                      // dragging out the dim. The post-load anchor
                      // guard re-centres the focused parent on every
                      // layout change during the collapse, so the
                      // operator sees the focused stack slide into
                      // place rather than the parent drifting.
                      focusedThreadParentId ? "duration-150" : "duration-300"
                    } ${
                      message.direction === "OUT" ? "self-end items-end" : "self-start items-start"
                    } ${
                      dimmedByFocus
                        // Collapse non-focused bubbles to zero height so the
                        // focused thread members visually come together —
                        // matches Messages.app's overlay where the focused
                        // bubbles stack tight. Negative margin cancels the
                        // parent's gap-[18px] so the collapse is total.
                        // Kept in the DOM (no display:none) so the
                        // layout-effect-driven scroll-into-view can still
                        // find adjacent anchors.
                        ? "max-h-0 opacity-0 overflow-hidden -mt-[18px] pointer-events-none"
                        : ""
                    }`}
                  >
                    {hasReplyIntent ? (() => {
                      // Prefer the in-window parent (we already have it
                      // loaded, so the focus action can navigate to it)
                      // but fall back to the server-resolved replyTo
                      // snippet for parents that live outside the
                      // pagination window or in a sibling iMessage
                      // thread. Last resort: the generic literal stub.
                      const localSnippet = parentMessage
                        ? parentMessage.text.slice(0, 120) || "(media)"
                        : null;
                      const serverSnippet = message.replyTo?.snippet ?? null;
                      const snippet =
                        localSnippet ??
                        serverSnippet ??
                        "Replying to an earlier message";
                      // The focus button only navigates when the parent
                      // is loaded in the current window. For server-only
                      // snippets we still show the text but make the
                      // button non-interactive (focus would jump
                      // nowhere).
                      const navigable = Boolean(parentMessageId);
                      return (
                        <button
                          type="button"
                          onClick={() => navigable && parentMessageId && focusOnParent(parentMessageId)}
                          disabled={!navigable}
                          className={`mb-[6px] flex max-w-[260px] items-start gap-[6px] rounded-[14px] border border-hairline bg-paper-2/60 px-[10px] py-[5px] text-[11px] leading-snug text-ink-3 hover:bg-paper-2 hover:text-ink-2 hover:border-ink-3/40 disabled:cursor-default disabled:hover:bg-paper-2/60 disabled:hover:text-ink-3 disabled:hover:border-hairline ${
                            message.direction === "OUT" ? "self-end" : "self-start"
                          }`}
                          title={`Focus thread: ${snippet}`}
                        >
                          <span className="text-ink-4" aria-hidden="true">↳</span>
                          <span className="line-clamp-2 italic text-left min-h-[30px]">
                            {snippet}
                          </span>
                        </button>
                      );
                    })() : null}
                    {isGroupChat && message.direction === "IN" && message.senderName ? (
                      <div className="relative mb-[4px]">
                        <button
                          type="button"
                          onClick={() =>
                            setParticipantPopover((prev) =>
                              prev === message.senderName ? null : (message.senderName ?? null)
                            )
                          }
                          className="text-[11px] font-medium tracking-[-0.005em] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                        >
                          {senderLabel}
                        </button>
                        {participantPopover === message.senderName ? (
                          <ParticipantPopover
                            handle={message.senderName}
                            platform={thread.platform}
                            onClose={() => setParticipantPopover(null)}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <span className="mb-[4px] text-[11px] font-medium tracking-[-0.005em] text-ink-2">
                        {senderLabel}
                      </span>
                    )}
                    {(() => {
                      const playableAttachments = (message.attachments ?? []).filter(
                        (a) => a.guid && a.kind && a.kind !== "unknown"
                      );
                      const hasInlineMedia = playableAttachments.length > 0;
                      const displayText = optimisticTextByMessageId[message.id] ?? message.text;
                      const isAttachmentOnlyText = /^\[.+\]$/.test(displayText.trim());
                      const showText = !(hasInlineMedia && isAttachmentOnlyText);
                      // Pilot R-0094: an image sent with no caption shouldn't
                      // sit in the coloured message bubble - the operator wants
                      // just the picture. When the message is nothing but
                      // photos/stickers, drop the bubble chrome (background,
                      // padding, tail) so the image floats on the thread. Video
                      // and audio keep the bubble: video carries its own frame
                      // and both surface a transcript line that needs it.
                      const isImageOnly =
                        hasInlineMedia &&
                        !showText &&
                        playableAttachments.every(
                          (a) => a.kind === "photo" || a.kind === "sticker"
                        );
                      const nativeReactions =
                        (message.raw?.reactions as MessageReaction[] | undefined) ?? [];
                      const synthesizedReactions = synthesizedReactionsByParentId.get(message.id) ?? [];
                      // #408. Operator reactions just sent from this dashboard,
                      // shown optimistically until the next refresh folds them
                      // into the runner's native copy.
                      const optimisticReactions = optimisticReactionsByMessageId[message.id] ?? [];
                      const reactions: MessageReaction[] = [
                        ...nativeReactions,
                        ...synthesizedReactions,
                        ...optimisticReactions
                      ];
                      // #408. The quick-react trigger is LinkedIn-only: iMessage
                      // reactions are read-only here (applied from the Messages
                      // app, surfaced via synthesised stickers), so we never show
                      // the picker for them.
                      const canReact = thread.platform === "LINKEDIN";
                      const canEdit =
                        thread.platform === "LINKEDIN" && message.direction === "OUT" && showText;
                      const pickerOpen = reactionPickerMessageId === message.id;
                      const isReacting = reactingMessageId === message.id;
                      const reactionError = reactionErrorByMessageId[message.id];
                      const isEditingMessage = editingMessageId === message.id;
                      const isSavingEdit = savingEditMessageId === message.id;
                      const isSavedEdit = savedEditMessageId === message.id;
                      const editError = editErrorByMessageId[message.id];
                      return (
                        <>
                        <div className="group relative">
                          <div
                            className={
                              isImageOnly
                                ? "flex flex-col gap-2"
                                : `flex flex-col gap-2 px-4 py-3 text-[14.5px] leading-[1.5] ${
                                    message.direction === "OUT"
                                      ? "rounded-2xl rounded-br-[6px] bg-ink text-paper"
                                      : "rounded-2xl rounded-bl-[6px] bg-paper-2 text-ink"
                                  }`
                            }
                          >
                            {hasInlineMedia ? (
                              <div className="flex flex-col gap-2">
                                {playableAttachments.map((a, attIdx) => (
                                  <IMessageMedia key={a.guid ?? attIdx} attachment={a} />
                                ))}
                                {(() => {
                                  // Pick the first transcribable attachment to
                                  // drive the per-message transcript surface.
                                  // Voice notes win over plain audio, which
                                  // win over video, so a multi-attachment
                                  // bubble (rare) labels itself sensibly.
                                  const transcribableKind = playableAttachments
                                    .map((a) => a.kind)
                                    .find(
                                      (k) =>
                                        k === "voice_note" ||
                                        k === "audio" ||
                                        k === "video"
                                    );
                                  if (!transcribableKind) return null;
                                  return (
                                    <VoiceMessageTranscript
                                      messageId={message.id}
                                      transcription={message.audioTranscription ?? null}
                                      attachmentKind={transcribableKind}
                                    />
                                  );
                                })()}
                              </div>
                            ) : null}
                            {showText ? (
                              isEditingMessage ? (
                                <div className="flex min-w-[min(72vw,340px)] flex-col gap-2">
                                  <textarea
                                    value={editDraft}
                                    onChange={(event) => {
                                      setEditDraft(event.target.value);
                                      setSavedEditMessageId(null);
                                    }}
                                    autoFocus
                                    rows={Math.max(2, Math.min(8, editDraft.split("\n").length))}
                                    className="w-full resize-y rounded-[8px] border border-hairline bg-paper px-3 py-2 text-[14px] leading-[1.5] text-ink outline-none focus:border-hairline-strong"
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                        event.preventDefault();
                                        void saveMessageEdit(message.id);
                                      } else if (event.key === "Escape") {
                                        event.preventDefault();
                                        cancelMessageEdit();
                                      }
                                    }}
                                  />
                                  <div className="flex items-center justify-end gap-2">
                                    <button
                                      type="button"
                                      onClick={cancelMessageEdit}
                                      disabled={isSavingEdit}
                                      className="inline-flex h-[30px] items-center gap-1 rounded-[6px] px-2 text-[12px] text-paper/75 transition-colors duration-calm hover:bg-paper/10 hover:text-paper disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      <X className="h-[13px] w-[13px]" strokeWidth={1.8} />
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void saveMessageEdit(message.id)}
                                      disabled={isSavingEdit || isSavedEdit || editDraft.trim().length === 0}
                                      className="inline-flex h-[30px] items-center gap-1 rounded-[6px] bg-paper px-2.5 text-[12px] font-medium text-ink transition-colors duration-calm hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-70"
                                    >
                                      {isSavingEdit ? (
                                        <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} />
                                      ) : isSavedEdit ? (
                                        <Check className="h-[13px] w-[13px]" strokeWidth={1.8} />
                                      ) : (
                                        <Save className="h-[13px] w-[13px]" strokeWidth={1.8} />
                                      )}
                                      {isSavingEdit ? "Saving" : isSavedEdit ? "Saved" : "Save"}
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <span className="text-balance whitespace-pre-wrap">{displayText}</span>
                              )
                            ) : null}
                          </div>
                          {reactions.length > 0 ? (
                            <div
                              className={`pointer-events-none absolute -top-[14px] flex -space-x-[6px] ${
                                message.direction === "OUT" ? "-left-[10px]" : "-right-[10px]"
                              }`}
                            >
                              {reactions.map((r, i) => (
                                <span
                                  key={`${r.kind}-${r.direction}-${i}`}
                                  title={`${r.direction === "OUT" ? "You" : senderLabel} reacted ${r.kind}`}
                                  className={`flex h-[24px] w-[24px] items-center justify-center rounded-full border-2 border-paper text-[13px] leading-none shadow-sm ${
                                    r.direction === "OUT"
                                      ? "bg-ink text-paper"
                                      : "bg-paper-2 text-ink"
                                  }`}
                                >
                                  {r.emoji}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {canReact || canEdit ? (
                            <div
                              className={`absolute top-1/2 flex -translate-y-1/2 flex-col gap-1 ${
                                message.direction === "OUT"
                                  ? "right-[calc(100%+8px)]"
                                  : "left-[calc(100%+8px)]"
                              }`}
                            >
                              {/* React trigger: revealed on bubble hover, or
                                  kept visible while its picker is open / a
                                  request is in flight so the affordance does not
                                  vanish mid-interaction. */}
                              <button
                                type="button"
                                disabled={isReacting}
                                onClick={() =>
                                  setReactionPickerMessageId((prev) =>
                                    prev === message.id ? null : message.id
                                  )
                                }
                                aria-label="React to message"
                                title="React"
                                className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-full border border-hairline bg-paper text-ink-2 shadow-sm transition-opacity duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${
                                  pickerOpen || isReacting
                                    ? "opacity-100"
                                    : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                }`}
                              >
                                {isReacting ? (
                                  <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} />
                                ) : (
                                  <span className="text-[13px] leading-none">☺</span>
                                )}
                              </button>
                              {canEdit ? (
                                <button
                                  type="button"
                                  disabled={isSavingEdit}
                                  onClick={() => startMessageEdit(message)}
                                  aria-label="Edit message"
                                  title="Edit"
                                  className={`inline-flex h-[26px] w-[26px] items-center justify-center rounded-full border border-hairline bg-paper text-ink-2 shadow-sm transition-opacity duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 ${
                                    isEditingMessage || isSavingEdit || isSavedEdit
                                      ? "opacity-100"
                                      : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                  }`}
                                >
                                  {isSavingEdit ? (
                                    <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} />
                                  ) : isSavedEdit ? (
                                    <Check className="h-[13px] w-[13px]" strokeWidth={1.8} />
                                  ) : (
                                    <Pencil className="h-[13px] w-[13px]" strokeWidth={1.8} />
                                  )}
                                </button>
                              ) : null}
                              {pickerOpen ? (
                                <div
                                  className={`absolute bottom-[calc(100%+6px)] z-20 flex items-center gap-[2px] rounded-full border border-hairline bg-paper p-[4px] shadow-pop ${
                                    message.direction === "OUT" ? "right-0" : "left-0"
                                  }`}
                                >
                                  {QUICK_REACT_EMOJI.map((emoji) => (
                                    <button
                                      key={emoji}
                                      type="button"
                                      disabled={isReacting}
                                      onClick={() => void reactToMessage(message.id, emoji)}
                                      aria-label={`React with ${emoji}`}
                                      title={emoji}
                                      className="inline-flex h-[28px] w-[28px] items-center justify-center rounded-full text-[16px] leading-none transition-colors duration-calm hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      {emoji}
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        {reactionError ? (
                          <span
                            className={`mt-[6px] font-mono text-[11px] text-risk-overdue ${
                              message.direction === "OUT" ? "self-end" : "self-start"
                            }`}
                          >
                            {reactionError}
                          </span>
                        ) : null}
                        {editError ? (
                          <span
                            className={`mt-[6px] font-mono text-[11px] text-risk-overdue ${
                              message.direction === "OUT" ? "self-end" : "self-start"
                            }`}
                          >
                            {editError}
                          </span>
                        ) : null}
                        {isSavedEdit && !isEditingMessage ? (
                          <span
                            className={`mt-[6px] inline-flex items-center gap-1 font-mono text-[11px] text-ink-3 ${
                              message.direction === "OUT" ? "self-end" : "self-start"
                            }`}
                          >
                            <Check className="h-[12px] w-[12px]" strokeWidth={1.8} />
                            Saved
                          </span>
                        ) : null}
                        </>
                      );
                    })()}
                    <span className="mt-[6px] flex items-center gap-2 text-[11px] text-ink-3">
                      <span>{formatClock(message.timestamp)}</span>
                      {/* Honest "Sent via automation ✓" - only shown when
                          the runner actually flagged this message as sent
                          via the bot, per #65. The previous always-on
                          indicator from #61 was dishonest. */}
                      {message.direction === "OUT" && message.sentVia === "automation" ? (
                        <span className="text-ink-4">· sent via automation ✓</span>
                      ) : null}
                      {replyCount > 0 ? (
                        <button
                          type="button"
                          onClick={() => focusOnParent(message.id)}
                          className="text-ink-2 hover:text-ink underline-offset-2 hover:underline"
                          title="Focus this thread"
                        >
                          · {replyCount} {replyCount === 1 ? "Reply" : "Replies"}
                        </button>
                      ) : null}
                    </span>
                  </div>
                </div>
              );
            })}

            {/* Scheduled-send rows. Render before pending so the timeline
                reads chronologically: inflight at the bottom, scheduled
                above. They're outbound, so right-aligned, but visually
                quieter (dashed border, ink-3) so the operator clocks
                "this hasn't sent yet" without the bubble pretending. */}
            {(thread.scheduledSends ?? []).map((scheduled) => {
              const isEditing = editingScheduledId === scheduled.clientSendId;
              const isSaving = savingScheduledId === scheduled.clientSendId;
              const isCancelling = cancellingScheduledId === scheduled.clientSendId;
              return (
                <div
                  key={`scheduled-${scheduled.clientSendId}`}
                  className="flex max-w-[86%] flex-col items-end self-end sm:max-w-[72%]"
                >
                  {isEditing ? (
                    <textarea
                      value={editingScheduledDraft}
                      onChange={(event) => setEditingScheduledDraft(event.target.value)}
                      autoFocus
                      rows={Math.max(2, Math.min(8, editingScheduledDraft.split("\n").length))}
                      className="w-full resize-y rounded-2xl rounded-br-[6px] border border-hairline-strong bg-paper px-4 py-3 text-[14.5px] leading-[1.5] text-ink outline-none focus:border-ink-2"
                      onKeyDown={(event) => {
                        // Cmd/Ctrl-Enter saves, Escape cancels - same shortcuts the
                        // composer uses, so the muscle memory carries over.
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          void saveEditScheduled(scheduled.clientSendId);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEditScheduled();
                        }
                      }}
                    />
                  ) : (
                    <div className="text-balance whitespace-pre-wrap rounded-2xl rounded-br-[6px] border border-dashed border-hairline-strong bg-paper px-4 py-3 text-[14.5px] leading-[1.5] text-ink">
                      {scheduled.text}
                    </div>
                  )}
                  <div className="mt-[6px] flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    <Clock className="h-3 w-3" strokeWidth={1.8} />
                    {isEditing ? (
                      <>
                        <span>scheduled ·</span>
                        <input
                          type="datetime-local"
                          value={editingScheduledTime}
                          onChange={(event) => setEditingScheduledTime(event.target.value)}
                          className="rounded-row border border-hairline bg-paper px-2 py-[2px] font-mono text-[11px] text-ink outline-none focus:border-ink-2"
                        />
                        <button
                          type="button"
                          onClick={() => void saveEditScheduled(scheduled.clientSendId)}
                          disabled={isSaving || !editingScheduledDraft.trim()}
                          className="text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                        >
                          {isSaving ? "saving…" : "save"}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditScheduled}
                          disabled={isSaving}
                          className="text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                        >
                          discard
                        </button>
                      </>
                    ) : (
                      <>
                        <span>scheduled · {formatScheduledFor(scheduled.scheduledFor)}</span>
                        <button
                          type="button"
                          onClick={() =>
                            beginEditScheduled(
                              scheduled.clientSendId,
                              scheduled.text,
                              scheduled.scheduledFor
                            )
                          }
                          disabled={isCancelling}
                          className="text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                        >
                          edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancelScheduledSend(scheduled.clientSendId)}
                          disabled={isCancelling}
                          className="text-ink-2 underline-offset-2 hover:text-ink hover:underline disabled:opacity-50"
                        >
                          {isCancelling ? "cancelling…" : "cancel"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {pendingSends.map((pending) => (
              <div
                key={`pending-${pending.clientSendId}`}
                className="flex max-w-[86%] flex-col items-end self-end sm:max-w-[72%]"
              >
                <div
                  className={`text-balance whitespace-pre-wrap px-4 py-3 text-[14.5px] leading-[1.5] ${
                    pending.failed
                      ? "rounded-2xl rounded-br-[6px] border border-risk-overdue bg-paper text-ink"
                      : "rounded-2xl rounded-br-[6px] bg-ink text-paper opacity-80"
                  }`}
                >
                  {pending.text}
                </div>
                <div className="mt-[6px] flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-ink-3">
                  <span>{formatClock(pending.sentAt)}</span>
                  {pending.failed ? (
                    <>
                      <span className="text-risk-overdue">
                        · {pending.errorKind === "AUTH_REQUIRED"
                          ? "auth required"
                          : pending.errorKind === "SELECTOR_FAIL"
                            ? "selector failed"
                            : pending.errorKind === "PROFILE_LOCKED"
                              ? "profile locked"
                              : "failed"}
                      </span>
                      {(() => {
                        const recovery = recoveryActionFor(pending);
                        return recovery ? (
                          <button
                            type="button"
                            onClick={recovery.run}
                            className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                            title={pending.errorMessage}
                          >
                            {recovery.label}
                          </button>
                        ) : null;
                      })()}
                      <button
                        type="button"
                        onClick={() => retryPendingSend(pending.clientSendId)}
                        className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                        title={pending.errorMessage}
                      >
                        retry
                      </button>
                    </>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      sending…
                    </span>
                  )}
                </div>
                {pending.failed && pending.errorMessage ? (
                  <p className="mt-[6px] max-w-[420px] text-right font-mono text-[11px] leading-[1.45] text-risk-overdue">
                    {pending.errorMessage}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="relative flex-shrink-0 border-t border-hairline bg-paper">
          {/* #461 (pilot R-0060): floating jump-to-latest button. Centred
              above the composer's top edge so it sits in the middle just
              above the input, with a glassy frosted-surface treatment that
              matches the sticky header. Hidden in focused mode (the stack is
              bounded there). */}
          {showJumpToLatest && !focusedThreadParentId ? (
            <button
              type="button"
              onClick={scrollToLatest}
              aria-label="Jump to latest message"
              title="Jump to latest"
              className="absolute -top-12 left-1/2 z-20 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-hairline bg-[color-mix(in_oklch,var(--paper)_72%,transparent)] text-ink-2 shadow-card backdrop-blur-md backdrop-saturate-150 transition-colors duration-calm hover:border-hairline-strong hover:bg-[color-mix(in_oklch,var(--paper)_88%,transparent)] hover:text-ink"
            >
              <ChevronDown className="h-[18px] w-[18px]" strokeWidth={2} />
            </button>
          ) : null}
          <div className="mx-auto w-full max-w-[820px] px-3 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 sm:px-8 sm:pb-2">
            {error ? (
              <p className="mb-1.5 font-mono text-[11px] text-risk-overdue">{error}</p>
            ) : null}
            {/* #462 follow-up: a transient dictation failure keeps the
                recorded clip in memory so the operator can retry the same
                audio with one tap instead of speaking again. */}
            {dictationRetry ? (
              <div className="mb-1.5 flex items-center gap-2 rounded-[10px] border border-risk-overdue/30 bg-risk-overdue/5 px-2.5 py-1.5 text-[11px] text-risk-overdue">
                <span className="flex-1 leading-snug">{dictationRetry}</span>
                <button
                  type="button"
                  onClick={retryDictation}
                  disabled={dictationStatus !== "idle"}
                  className="shrink-0 rounded-pill border border-risk-overdue/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors duration-calm hover:bg-risk-overdue/10 disabled:opacity-50"
                >
                  {dictationStatus === "transcribing" ? "Retrying…" : "Try again"}
                </button>
                <button
                  type="button"
                  onClick={dismissDictationRetry}
                  disabled={dictationStatus === "transcribing"}
                  aria-label="Dismiss"
                  className="shrink-0 text-risk-overdue/70 transition-colors duration-calm hover:text-risk-overdue disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            ) : null}
            {/* Focus Reply Buffer: when this thread arrived during the active
                window, a one-tap acknowledgement sits above the composer. The
                proper reply still gets written in the composer below. */}
            <FocusThreadStrip thread={thread} onSent={refresh} />
            <div
              data-thread-composer="true"
              data-demo-target="composer-input"
              // Predraft state earns a tinted accent border + soft ring
              // (#350): the textarea on its own looks like a passive
              // surface, so operators read the AI predraft as static
              // text rather than something they're meant to edit. The
              // accent frame signals "this is suggested content, click
              // anywhere to refine, or discard and start fresh". As soon
              // as composerSource flips to "user" (typing starts) the
              // frame reverts to the neutral hairline.
              className={`rounded-card border bg-paper px-3 pb-1.5 pt-1.5 transition-colors duration-calm ${
                composerSource === "predraft"
                  ? "border-accent-ink/40 ring-1 ring-accent-ink/10"
                  : "border-hairline"
              }`}
            >
              {focusedParentMessage ? (
                <div className="mb-2 flex items-start gap-2 rounded-[10px] border border-hairline bg-paper-2/60 px-2 py-1.5 text-[12px] leading-snug text-ink-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                    Replying to
                  </span>
                  <span className="flex-1 italic line-clamp-2">
                    {focusedParentMessage.text.slice(0, 160) || "(media)"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFocusedThreadParentId(null)}
                    className="text-ink-3 hover:text-ink"
                    aria-label="Exit thread"
                    title="Exit thread (Esc)"
                  >
                    ×
                  </button>
                </div>
              ) : null}
              {composerSource === "predraft" ? (
                <div
                  data-testid="ai-predraft-badge"
                  className="mb-1.5 flex items-center justify-between gap-2"
                >
                  <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.06em] text-accent-ink">
                    <Sparkles className="h-[12px] w-[12px]" />
                    {isReopenMode ? "AI opener · review before sending" : "AI predraft · review before sending"}
                  </span>
                  {/* Bumped from a tiny "clear" link to a proper Discard
                      button at body-text size with an icon (#350). Old
                      treatment was easy to miss when the operator wanted
                      to throw away the AI draft and write their own. */}
                  <button
                    type="button"
                    onClick={() => {
                      predraftDismissedRef.current.add(threadId);
                      setComposer("");
                      setComposerSource("empty");
                    }}
                    title="Discard the AI draft and start fresh"
                    className="flex items-center gap-1 rounded-[6px] px-2 py-1 text-[12px] text-ink-2 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
                  >
                    <X className="h-[12px] w-[12px]" strokeWidth={1.6} />
                    Discard
                  </button>
                </div>
              ) : null}
              <textarea
                placeholder={`Reply to ${firstName}…`}
                value={composer}
                // #466 (pilot R-0065): native browser assists where supported
                // (spellCheck underlines on desktop; autoCapitalize/autoCorrect
                // on iOS/Safari). The JS layer below covers desktop Firefox.
                spellCheck
                autoCapitalize="sentences"
                autoCorrect="on"
                onChange={(event) => {
                  const nextValue = event.target.value;
                  const caret = event.target.selectionStart ?? nextValue.length;
                  if (composerSource === "predraft" || composerSource === "empty") {
                    setComposerSource("user");
                  }
                  // #466: autocorrect only on a single typed character that
                  // appends at the very end of the text, so the caret stays
                  // put and mid-text edits are never disturbed.
                  if (nextValue.length === composer.length + 1 && caret === nextValue.length) {
                    const fix = autocorrectAtCaret(nextValue, caret);
                    if (fix) {
                      lastAutocorrectRef.current = {
                        original: fix.original,
                        corrected: fix.corrected,
                        value: fix.text
                      };
                      setComposer(fix.text);
                      return;
                    }
                  }
                  lastAutocorrectRef.current = null;
                  setComposer(nextValue);
                }}
                onKeyDown={(event) => {
                  // #466: an immediate Backspace reverts the last
                  // autocorrection to exactly what the operator typed.
                  if (
                    event.key === "Backspace" &&
                    lastAutocorrectRef.current &&
                    composer === lastAutocorrectRef.current.value
                  ) {
                    event.preventDefault();
                    const { original, corrected, value } = lastAutocorrectRef.current;
                    const terminator = value.slice(-1);
                    const reverted =
                      value.slice(0, value.length - 1 - corrected.length) + original + terminator;
                    lastAutocorrectRef.current = null;
                    setComposer(reverted);
                    return;
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    // #65: stop the native window-level keydown listener
                    // (still in scope for global shortcuts) so onSend
                    // doesn't fire twice when the composer has focus.
                    event.nativeEvent.stopImmediatePropagation();
                    void onSend();
                  }
                }}
                rows={2}
                ref={(el) => {
                  if (!el) return;
                  // Autosize: grow with content from 2 rows up to ~7 rows
                  // before capping so the composer doesn't eat the chat
                  // when pasting walls of text.
                  el.style.height = "auto";
                  el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 160)}px`;
                }}
                className="block w-full resize-none border-0 bg-transparent text-[14px] leading-[1.45] text-ink outline-none placeholder:text-ink-4"
                style={{ minHeight: 44, maxHeight: 160 }}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {/* Memory icon - opens the prior-conversations popover.
                    Compact replacement for the old chip that used to sit
                    above the composer and burn a row of vertical space. */}
                {thread.relationshipMemory && thread.relationshipMemory.otherThreadCount > 0 ? (
                  <div data-testid="memory-chip" className="relative">
                    <button
                      type="button"
                      onClick={() => setMemoryOpen((prev) => !prev)}
                      aria-expanded={memoryOpen}
                      title={`Memory · ${thread.relationshipMemory.otherThreadCount} prior conversation${thread.relationshipMemory.otherThreadCount === 1 ? "" : "s"}${thread.relationshipMemory.tags.length > 0 ? ` · ${thread.relationshipMemory.tags.length} tag${thread.relationshipMemory.tags.length === 1 ? "" : "s"}` : ""}`}
                      className="relative grid h-[30px] w-[30px] place-items-center rounded-full border border-hairline bg-paper text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
                    >
                      <Sparkles className="h-[13px] w-[13px]" strokeWidth={1.6} />
                      <span className="absolute -right-[2px] -top-[2px] grid h-[14px] min-w-[14px] place-items-center rounded-full bg-ink px-[3px] font-mono text-[9px] font-medium text-paper">
                        {thread.relationshipMemory.otherThreadCount}
                      </span>
                    </button>
                    {memoryOpen ? (
                      <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-[480px] max-w-[80vw] rounded-card border border-hairline bg-paper p-3 text-[12px] leading-snug shadow-card">
                        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                          What the AI can lean on
                        </div>
                        {thread.relationshipMemory.tags.length > 0 ? (
                          <div className="mb-2 flex flex-wrap gap-1">
                            {thread.relationshipMemory.tags.map((tag) => (
                              <span
                                key={tag}
                                className="rounded-full border border-hairline-strong px-2 py-[1px] text-[11px] text-ink-2"
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {thread.relationshipMemory.notes ? (
                          <p className="mb-2 text-ink-2">{thread.relationshipMemory.notes}</p>
                        ) : null}
                        <ul className="space-y-1">
                          {thread.relationshipMemory.recentExchanges.map((ex) => (
                            <li key={ex.threadId} className="text-ink-2">
                              <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-ink-3">
                                {ex.platform.toLowerCase()}
                                {ex.lastMessageAt ? ` · ${formatRelative(ex.lastMessageAt)}` : ""}
                              </span>
                              <br />
                              <span className="text-ink-2">
                                {ex.preview ?? ex.whatTheyWant ?? "(no recent message)"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {/* Suggested-replies dropdown. Complete sendable drafts —
                    shown only when the operator has opted into full AI
                    drafts via the AI help level. Lower levels keep the
                    composer centred on the operator's own writing. */}
                {showFullDrafts ? (
                <div className="relative" ref={chipsMenuRef}>
                  <button
                    type="button"
                    onClick={() => setChipsMenuOpen((v) => !v)}
                    disabled={repliesGenerating}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-hairline px-2.5 py-1 text-[11px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:opacity-50"
                  >
                    {repliesGenerating ? (
                      <Loader2 className="h-[13px] w-[13px] animate-spin" />
                    ) : (
                      <Sparkles className="h-[13px] w-[13px]" strokeWidth={1.6} />
                    )}
                    {repliesGenerating ? "Generating suggestions…" : "Suggested replies"}
                    {repliesGenerating ? null : (
                      <ChevronDown
                        className={`h-[13px] w-[13px] transition-transform duration-calm ${chipsMenuOpen ? "rotate-180" : ""}`}
                        strokeWidth={1.6}
                      />
                    )}
                  </button>
                  {chipsMenuOpen && !repliesGenerating ? (
                    <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-row border border-hairline bg-paper p-[6px] shadow-pop">
                      {fallbackSource ? (
                        <p
                          className="m-0 mb-1 px-3 pb-2 pt-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3"
                          title={fallbackSource.fellBackMessage ?? undefined}
                        >
                          generated with{" "}
                          {fallbackSource.providerDisplayName ?? "fallback provider"} ·{" "}
                          {fallbackSource.fellBackFromProviderDisplayName ??
                            fallbackSource.fellBackFromProviderId}{" "}
                          unavailable
                          {fallbackSource.fellBackReason
                            ? ` (${fallbackSource.fellBackReason.replace(/_/g, " ")})`
                            : ""}
                        </p>
                      ) : null}
                      {chips.map((chip) => (
                        <button
                          key={chip.intent}
                          type="button"
                          onClick={() => {
                            setComposer(chip.text);
                            setChipsMenuOpen(false);
                          }}
                          className="block w-full rounded-[10px] px-3 py-[10px] text-left transition-colors duration-calm hover:bg-paper-2"
                        >
                          <p className="m-0 text-[13px] font-medium text-ink">{chip.intent}</p>
                          <p className="m-0 mt-1 line-clamp-2 text-[12.5px] leading-[1.45] text-ink-3">
                            {chip.text}
                          </p>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                ) : null}
                {/* Tools take a full row of their own on phone (the cluster
                    doesn't fit beside the suggestions pill), right-aligned
                    like the design's composer foot. */}
                <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto sm:flex-1">
                  {/* "shorten" / "warmer" rewrite the operator's OWN draft —
                      writing support, shown unless AI help is memory-only. */}
                  {showWritingSupport ? (
                    <>
                      <button
                        type="button"
                        disabled={!composer.trim() || transforming !== null}
                        onClick={() => void transform("SHORTEN")}
                        className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink disabled:opacity-40"
                      >
                        {transforming === "SHORTEN" ? "shortening…" : "shorten"}
                      </button>
                      <button
                        type="button"
                        disabled={!composer.trim() || transforming !== null}
                        onClick={() => void transform("MAKE_WARMER")}
                        className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink disabled:opacity-40"
                      >
                        {transforming === "MAKE_WARMER" ? "warming…" : "warmer"}
                      </button>
                    </>
                  ) : null}
                  {/* #462 (pilot R-0061): Dictate — record speech and have
                      the runner transcribe it into the composer for review.
                      Distinct from the iMessage voice-note mic (that attaches
                      audio to send). Available on every platform; disabled
                      with an explanation when transcription isn't configured. */}
                  <button
                    type="button"
                    onClick={() =>
                      dictationStatus === "recording" ? stopDictation() : void startDictation()
                    }
                    disabled={!dictationAvailable || dictationStatus === "transcribing"}
                    title={
                      dictationAvailable
                        ? dictationStatus === "recording"
                          ? "Stop and transcribe"
                          : "Dictate your reply"
                        : "Voice dictation needs transcription enabled on the runner"
                    }
                    aria-label="Dictate"
                    className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[11px] transition-colors duration-calm disabled:cursor-not-allowed disabled:opacity-50 ${
                      dictationStatus === "recording"
                        ? "border-risk-overdue bg-risk-overdue/10 text-risk-overdue"
                        : "border-hairline text-ink-2 hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
                    }`}
                  >
                    {dictationStatus === "transcribing" ? (
                      <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} />
                    ) : (
                      <Mic
                        className={`h-[13px] w-[13px] ${dictationStatus === "recording" ? "animate-pulse" : ""}`}
                        strokeWidth={1.8}
                      />
                    )}
                    {/* Icon-only at rest until the chat column is genuinely
                        wide (2xl, matching the header labels); the running
                        states keep their label at every width so the
                        in-flight status stays visible. */}
                    <span className={dictationStatus === "idle" ? "hidden 2xl:inline" : undefined}>
                      {dictationStatus === "recording"
                        ? "Stop"
                        : dictationStatus === "transcribing"
                          ? "Transcribing…"
                          : "Dictate"}
                    </span>
                  </button>
                  <div className="relative" ref={scheduleMenuRef}>
                    <button
                      type="button"
                      onClick={() => setScheduleMenuOpen((v) => !v)}
                      disabled={!composer.trim() || sending || scheduling}
                      title="Schedule send"
                      aria-label="Schedule send"
                      className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-full border border-hairline text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Clock className="h-[13px] w-[13px]" strokeWidth={1.8} />
                    </button>
                    {scheduleMenuOpen ? (
                      <div className="absolute bottom-[calc(100%+8px)] right-0 z-20 w-[min(300px,calc(100vw-32px))] overflow-hidden rounded-row border border-hairline bg-paper p-[6px] shadow-pop">
                        <p className="m-0 px-3 pb-2 pt-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
                          Schedule send
                        </p>
                        {buildSchedulePresets(new Date()).map((preset) => (
                          <button
                            key={preset.label}
                            type="button"
                            onClick={() => void scheduleSend(preset.at)}
                            disabled={scheduling}
                            className="flex w-full items-center justify-between rounded-[10px] px-3 py-[10px] text-left transition-colors duration-calm hover:bg-paper-2 disabled:opacity-50"
                          >
                            <span className="text-[13px] font-medium text-ink">{preset.label}</span>
                            <span className="font-mono text-[11px] text-ink-3">{preset.sub}</span>
                          </button>
                        ))}
                        <div className="mx-2 my-2 border-t border-hairline" />
                        <div className="px-3 pb-2 pt-1">
                          <p className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.06em] text-ink-3">
                            Custom
                          </p>
                          <input
                            type="datetime-local"
                            value={customScheduleValue}
                            onChange={(e) => setCustomScheduleValue(e.target.value)}
                            className="w-full rounded-row border border-hairline bg-paper px-3 py-[7px] text-[13px] text-ink outline-none transition-[border-color] duration-calm focus:border-hairline-strong"
                          />
                          <button
                            type="button"
                            disabled={!customScheduleValue || scheduling}
                            onClick={() => {
                              const at = new Date(customScheduleValue);
                              if (Number.isNaN(at.getTime())) {
                                setError("Pick a valid date and time.");
                                return;
                              }
                              if (at.getTime() <= Date.now()) {
                                setError("Pick a time in the future.");
                                return;
                              }
                              void scheduleSend(at);
                            }}
                            className="mt-2 w-full rounded-pill bg-ink px-3 py-[7px] text-[12px] font-medium text-paper hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {scheduling ? "Scheduling…" : "Schedule"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {thread.platform === "IMESSAGE" ? (
                    <>
                      <input
                        type="file"
                        multiple
                        accept="image/*,video/*,audio/*,application/pdf"
                        className="hidden"
                        id="composer-file-input"
                        onChange={(e) => {
                          if (e.target.files) addFiles(e.target.files);
                          e.target.value = "";
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => document.getElementById("composer-file-input")?.click()}
                        className="grid h-[30px] w-[30px] place-items-center rounded-full border border-hairline bg-paper text-ink-2 hover:text-ink"
                        title="Attach photos / files"
                        aria-label="Attach files"
                      >
                        <Paperclip className="h-[13px] w-[13px]" strokeWidth={1.8} />
                      </button>
                      <button
                        type="button"
                        onClick={() => (recording ? stopRecording() : void startRecording())}
                        className={`grid h-[30px] w-[30px] place-items-center rounded-full border ${
                          recording
                            ? "border-risk-overdue bg-risk-overdue/10 text-risk-overdue animate-pulse"
                            : "border-hairline bg-paper text-ink-2 hover:text-ink"
                        }`}
                        title={recording ? "Stop recording" : "Record voice note"}
                        aria-label={recording ? "Stop recording" : "Record voice note"}
                      >
                        <Mic className="h-[13px] w-[13px]" strokeWidth={1.8} />
                      </button>
                    </>
                  ) : null}
                  <Button
                    variant="primary"
                    onClick={() => void onSend()}
                    disabled={sending || (!composer.trim() && composerAttachments.length === 0)}
                    className="px-3.5 py-1.5 text-[12px]"
                  >
                    {sending ? <Loader2 className="h-[13px] w-[13px] animate-spin" /> : <Send className="h-[13px] w-[13px]" strokeWidth={1.8} />}
                    Send
                  </Button>
                </div>
              </div>
              {showLateNightNudge && lateNightSlot ? (
                <button
                  type="button"
                  data-testid="late-night-schedule-nudge"
                  onClick={() => void scheduleSend(lateNightSlot)}
                  disabled={scheduling}
                  title={`Send at ${lateNightSlot.toLocaleString(undefined, {
                    weekday: "long",
                    hour: "numeric",
                    minute: "2-digit"
                  })} instead of now`}
                  className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-ink-3 transition-colors duration-calm hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Clock className="h-[12px] w-[12px]" strokeWidth={1.6} />
                  <span>
                    {scheduling ? "Scheduling…" : "It’s late, schedule for 8 AM instead?"}
                  </span>
                </button>
              ) : null}
              {composerAttachments.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2 border-t border-hairline pt-2">
                  {composerAttachments.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-2 rounded-pill border border-hairline bg-paper px-2 py-1 text-[12px]"
                    >
                      {a.kind === "photo" && a.previewUrl ? (
                        <img src={a.previewUrl} alt="" className="h-6 w-6 rounded object-cover" />
                      ) : (
                        <span className="text-ink-3">
                          {a.kind === "voice_note" ? "🎤" : a.kind === "video" ? "🎥" : a.kind === "pdf" ? "📄" : "📎"}
                        </span>
                      )}
                      <span className="max-w-[140px] truncate text-ink">{a.file.name}</span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        className="text-ink-3 hover:text-risk-overdue"
                        aria-label="Remove attachment"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            {snoozeMenuOpen ? (
              <div
                data-testid="snooze-suggestions"
                className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-paper-2 p-3"
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                  AI snooze
                </span>
                {snoozeSuggestions?.loading ? (
                  <span className="font-mono text-[11px] text-ink-3">thinking…</span>
                ) : snoozeSuggestions && snoozeSuggestions.items.length > 0 ? (
                  snoozeSuggestions.items.map((s) => (
                    <button
                      key={`${s.label}-${s.hours}`}
                      type="button"
                      title={s.reason}
                      onClick={() => {
                        runAction(
                          apiPost(`/runner/control/thread/${thread.id}/snooze`, { hours: s.hours }),
                          setError,
                          refresh
                        );
                        setSnoozeMenuOpen(false);
                      }}
                      className="rounded-full border border-hairline-strong bg-paper px-3 py-1 text-[12px] text-ink hover:bg-paper-2"
                    >
                      {s.label} <span className="text-ink-3">· {s.hours}h</span>
                    </button>
                  ))
                ) : (
                  <span className="font-mono text-[11px] text-ink-3">
                    No clear time hint in this thread.
                  </span>
                )}
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      runAction(
                        apiPost(`/runner/control/thread/${thread.id}/snooze`, { hours: 6 }),
                        setError,
                        refresh
                      );
                      setSnoozeMenuOpen(false);
                    }}
                    className="rounded-full px-3 py-1 text-[12px] text-ink-3 hover:text-ink"
                  >
                    6h
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      runAction(
                        apiPost(`/runner/control/thread/${thread.id}/snooze`, { hours: 24 }),
                        setError,
                        refresh
                      );
                      setSnoozeMenuOpen(false);
                    }}
                    className="rounded-full px-3 py-1 text-[12px] text-ink-3 hover:text-ink"
                  >
                    1d
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* ───── Context rail ───── */}
      {/* Below xl there is no grid column wide enough to live in, so the
          open rail becomes a right-hand slide-over above the conversation
          (the design's tablet/phone pattern) — same content, same AI
          toggle. The backdrop closes it with a tap. */}
      {aiOpen ? (
        <button
          type="button"
          aria-label="Close AI assist"
          onClick={() => setAiOpen(false)}
          className="fixed inset-0 z-30 cursor-default bg-ink/20 xl:hidden"
        />
      ) : null}
      <aside
        className={
          aiOpen
            ? "fixed inset-y-0 right-0 z-40 w-[min(92vw,380px)] overflow-y-auto border-l border-hairline bg-paper shadow-pop xl:static xl:z-auto xl:h-full xl:min-h-0 xl:w-auto xl:border-l-0 xl:bg-paper-2/40 xl:shadow-none"
            : "hidden"
        }
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3 xl:hidden">
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
            AI assist
          </span>
          <button
            type="button"
            onClick={() => setAiOpen(false)}
            aria-label="Close AI assist"
            className="grid h-8 w-8 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            <X className="h-[16px] w-[16px]" strokeWidth={1.6} />
          </button>
        </div>
        <div className="flex flex-col gap-7 px-5 py-6 sm:px-7 xl:py-10">
          {/* Reply Brief - the single adaptive panel that drives the rail.
              Default visible card carries only Where it stands + On you so
              the operator can read the thread in under 10 seconds; everything
              else (optional follow-ups, fuller context, tone steer, the
              gated reply checklist with its existing auto-tick / dismiss
              behaviour) sits behind one collapsed disclosure. Falls back to
              a safe brief derived from the legacy fields when the runner
              hasn't yet generated one for this row. */}
          <ReplyBriefPanel
            threadId={thread.id}
            brief={displayBrief}
            openLoops={thread.openLoops}
            dismissedOpenLoops={thread.dismissedOpenLoops}
            onDismissLoop={(loop, dismissed) => void toggleOpenLoop(loop, dismissed)}
            aiCoverageItems={aiCoverageItems}
            aiCoverageMode={
              aiHelpLevel === "memory_only"
                ? "off"
                : aiHelpLevel === "full_drafts"
                  ? "auto-tick"
                  : "highlight"
            }
          />

          {/* Things to remember - durable facts (exams, trips, life events)
              the AI re-derives from the transcript each scan. Stays separate
              from the Reply Brief on purpose: this is life context the
              operator wants to carry forward, not reply-state. Read-only and
              self-hiding when empty. */}
          <ThingsToRemember remember={thread.remember ?? []} />

          <section>
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              {effectiveComposeMode === "write" ? "Compose" : "Ask"}
            </p>
            <p className="mb-3 text-[12.5px] leading-[1.55] text-ink-3">
              {effectiveComposeMode === "write"
                ? composeHelper
                : "Ask about this thread or person, or something general. Facts about the person come only from the transcript and what's on record; general questions get a general answer, clearly labelled."}
            </p>
            {!showFullDrafts ? (
              <p className="mb-3 text-[12px] leading-[1.5] text-ink-3">
                Full AI reply drafts are off.{" "}
                <Link href="/settings" className="text-ink-2 underline-offset-2 hover:underline">
                  Change your AI help level in Settings
                </Link>{" "}
                to draft complete replies as well.
              </p>
            ) : null}
            <textarea
              value={composeIntent}
              onChange={(event) => {
                setComposeIntent(event.target.value);
                if (askAnswer) setAskAnswer(null);
                if (composeDraft) setComposeDraft("");
              }}
              placeholder={
                effectiveComposeMode === "write"
                  ? isReopenMode
                    ? "e.g. ask how exams went"
                    : "e.g. ask if free for a quick coffee next week"
                  : "e.g. what did I say about the meeting with alex?"
              }
              rows={3}
              className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
            />
            {/* Mismatch hint: if the input shape clashes with the selected
                mode, surface a one-line nudge below the textarea so the
                operator can flip modes without burying it in a menu. Only
                relevant when both modes are available (full AI drafts on). */}
            {showFullDrafts ? (() => {
              const trimmed = composeIntent.trim();
              if (!trimmed) return null;
              const looksLikeQuestion =
                trimmed.endsWith("?") ||
                /^(what|why|how|when|where|who|which|did|do|does|is|are|was|were|can|could|should|would|will|remind|tell|remember)\b/i.test(
                  trimmed
                );
              if (composeMode === "write" && looksLikeQuestion) {
                return (
                  <p className="mt-1 text-[11px] text-ink-3">
                    Looks like a question.{" "}
                    <button
                      type="button"
                      onClick={() => setComposeMode("ask")}
                      className="text-ink-2 underline-offset-2 hover:underline"
                    >
                      Switch to Ask?
                    </button>
                  </p>
                );
              }
              if (composeMode === "ask" && !looksLikeQuestion) {
                return (
                  <p className="mt-1 text-[11px] text-ink-3">
                    Looks like a directive.{" "}
                    <button
                      type="button"
                      onClick={() => setComposeMode("write")}
                      className="text-ink-2 underline-offset-2 hover:underline"
                    >
                      Switch to Compose?
                    </button>
                  </p>
                );
              }
              return null;
            })() : null}
            <div className="mt-2 flex items-center gap-2">
              {/* Split button: primary action + a chevron to flip the mode.
                  The mode switcher only appears when full AI drafts are on;
                  otherwise this is an Ask-only button. */}
              <div className="relative inline-flex rounded-pill bg-ink text-paper transition-[background-color] duration-calm hover:bg-[oklch(28%_0.01_80)]">
                <button
                  type="button"
                  disabled={composing || !composeIntent.trim()}
                  onClick={() =>
                    effectiveComposeMode === "write" ? void composeFromIntent() : void askAi()
                  }
                  className={`inline-flex items-center gap-2 bg-transparent px-4 py-[10px] text-sm font-medium tracking-[-0.005em] disabled:cursor-not-allowed disabled:opacity-50 ${showFullDrafts ? "rounded-l-pill" : "rounded-pill"}`}
                >
                  {composing ? (
                    <Loader2 className="h-[14px] w-[14px] animate-spin" />
                  ) : (
                    <Sparkles className="h-[14px] w-[14px]" strokeWidth={1.8} />
                  )}
                  {composing
                    ? effectiveComposeMode === "write"
                      ? "Composing…"
                      : "Thinking…"
                    : effectiveComposeMode === "write"
                      ? "Compose"
                      : "Ask"}
                </button>
                {showFullDrafts ? (
                  <>
                <span className="my-[6px] w-px bg-paper/20" aria-hidden />
                <button
                  type="button"
                  onClick={() => setComposeModeMenuOpen((v) => !v)}
                  disabled={composing}
                  aria-haspopup="menu"
                  aria-expanded={composeModeMenuOpen}
                  title="Switch mode"
                  className="grid place-items-center rounded-r-pill bg-transparent px-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ChevronDown
                    className={`h-[14px] w-[14px] transition-transform duration-calm ${composeModeMenuOpen ? "rotate-180" : ""}`}
                    strokeWidth={1.8}
                  />
                </button>
                {composeModeMenuOpen ? (
                  <div className="absolute bottom-[calc(100%+6px)] left-0 z-20 w-[240px] overflow-hidden rounded-row border border-hairline bg-paper p-1 shadow-pop">
                    <button
                      type="button"
                      onClick={() => {
                        setComposeMode("write");
                        setComposeModeMenuOpen(false);
                      }}
                      className={`block w-full rounded-[8px] px-3 py-2 text-left transition-colors duration-calm hover:bg-paper-2 ${composeMode === "write" ? "bg-paper-2" : ""}`}
                    >
                      <p className="m-0 text-[13px] font-medium text-ink">Compose</p>
                      <p className="m-0 mt-0.5 text-[11px] text-ink-3">
                        AI writes a sendable draft in your voice
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setComposeMode("ask");
                        setComposeModeMenuOpen(false);
                      }}
                      className={`block w-full rounded-[8px] px-3 py-2 text-left transition-colors duration-calm hover:bg-paper-2 ${composeMode === "ask" ? "bg-paper-2" : ""}`}
                    >
                      <p className="m-0 text-[13px] font-medium text-ink">Ask</p>
                      <p className="m-0 mt-0.5 text-[11px] text-ink-3">
                        AI answers from the thread context (no draft)
                      </p>
                    </button>
                  </div>
                ) : null}
                  </>
                ) : null}
              </div>
              {composeError ? (
                <span className="font-mono text-[11px] text-risk-overdue">{composeError}</span>
              ) : null}
            </div>
            {composeDraft ? (
              // #436.4: "try again" re-runs composeFromIntent, which keeps the
              // old draft mounted while the new one streams. Fade the stale
              // text and swap the actions for a Regenerating… indicator so two
              // suggestions never sit side by side.
              <div
                className={`mt-3 rounded-row border border-hairline bg-paper p-3 text-[13.5px] leading-[1.55] text-ink transition-opacity duration-calm ${
                  composing ? "opacity-40" : "opacity-100"
                }`}
              >
                <p className="m-0 whitespace-pre-wrap">{composeDraft}</p>
                <div className="mt-3 flex items-center gap-3">
                  {composing ? (
                    <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                      <Loader2 className="h-[12px] w-[12px] animate-spin" />
                      Regenerating…
                    </span>
                  ) : (
                    <>
                      <Button variant="quiet" onClick={useDraft}>
                        Use this
                      </Button>
                      <button
                        type="button"
                        onClick={() => void composeFromIntent()}
                        className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
                      >
                        try again
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : null}
            {askAnswer ? (
              <div className="mt-3 rounded-row border border-hairline bg-paper-2/50 p-3 text-[13.5px] leading-[1.55] text-ink">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                  Answer
                </p>
                <p className="m-0 whitespace-pre-wrap text-ink-2">{askAnswer}</p>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setAskAnswer(null)}
                    className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
                  >
                    dismiss
                  </button>
                  <button
                    type="button"
                    onClick={() => void askAi()}
                    className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
                  >
                    ask again
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </aside>

      {receiptsEverOpened ? (
        <ReceiptsDrawer
          open={receiptsOpen}
          onClose={() => setReceiptsOpen(false)}
          rows={thread.receipts}
          title="Thread receipts"
        />
      ) : null}

      {profileEverOpened ? (
        <ProfileDrawer
          open={profileDrawerOpen}
          personId={thread.personId ?? null}
          onClose={() => setProfileDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
}
