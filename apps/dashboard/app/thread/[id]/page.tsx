"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { v4 as uuid } from "uuid";
import { ChevronDown, ChevronLeft, Clock, Loader2, Send, Sparkles } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard, ThreadMessage, ThreadResponse } from "@/lib/types";
import { formatClock, formatRelative } from "@/lib/time";
import { initials, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { PersonAvatar } from "@/components/common/person-avatar";
import { Button } from "@/components/ui/button";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { ProfileDrawer } from "@/components/common/profile-drawer";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { buildCorpusStats, scoreDraftAgainstCorpus } from "@/lib/voice-score";

// Thread workspace — landscape layout.
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
// the message stream — and scrolls independently when content overflows.
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
  { intent: "Warm yes", glyph: "↵", build: (n) => `Hey ${n}, yes — let's do it.` },
  { intent: "Polite pass", glyph: "·", build: (n) => `Hi ${n}, appreciate it but I'll pass for now.` },
  { intent: "Ask for time", glyph: "⏱", build: (n) => `Hey ${n}, can I get back to you next week?` }
];

// The runner paginates messages server-side and exposes `messagePage`
// on every ThreadResponse. We only own the scroll-position thresholds:
// crossing the top threshold triggers `loadOlderMessages`, and staying
// near the bottom keeps the auto-scroll-on-new-message glue active.
const SCROLL_TOP_THRESHOLD = 120;
const SCROLL_BOTTOM_THRESHOLD = 200;

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
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

// Build the standard list of schedule-send presets relative to `now`.
// Times round forward to whole hours / 9 am the next morning, matching the
// conventions Gmail and the Apple Mail "Send Later" picker use — operators
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
// <input type="datetime-local"> expects. Local timezone — the input is
// user-facing, so we want the wall-clock time the operator sees in
// the existing pill, not UTC.
function toLocalInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Format an absolute timestamp for the "scheduled for X" pill — show the
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

function DayDivider({ label }: { label: string }) {
  return (
    <div className="my-3 flex items-center gap-3 self-stretch">
      <span className="h-px flex-1 bg-hairline" />
      <span className="text-[11px] font-medium tracking-[-0.005em] text-ink-3">{label}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const threadId = params.id;

  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [siblings, setSiblings] = useState<InboxRow[]>([]);
  const [siblingPlatform, setSiblingPlatform] = useState<"all" | "LINKEDIN" | "IMESSAGE">("all");
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [composer, setComposer] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const [reassessing, setReassessing] = useState(false);
  const [transforming, setTransforming] = useState<"SHORTEN" | "MAKE_WARMER" | null>(null);
  const [composeIntent, setComposeIntent] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeDraft, setComposeDraft] = useState("");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [profileDrawerOpen, setProfileDrawerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chipsMenuOpen, setChipsMenuOpen] = useState(false);
  // Source of the current composer text: empty / explicit draft typed
  // by the operator / AI predraft (first suggested reply auto-filled
  // when no explicit draft exists). Drives the "AI predraft" badge.
  const [composerSource, setComposerSource] = useState<"empty" | "draft" | "predraft" | "user">("empty");
  // AI-suggested snooze chips, populated lazily when the operator opens
  // the snooze chip menu. Empty list = AI saw no time hint and refused
  // to fabricate one (correct, expected behaviour for most threads).
  const [snoozeSuggestions, setSnoozeSuggestions] = useState<
    null | { loading: boolean; items: Array<{ label: string; hours: number; reason: string }> }
  >(null);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  // Inspectable popover for the memory chip — opens a quick list of
  // the other threads/notes the AI prompts can pull from.
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Voice-match: rebuilt only when the thread's outbound history
  // changes. Score is debounced against the composer text below.
  const [voiceRewritePending, setVoiceRewritePending] = useState(false);
  const chipsMenuRef = useRef<HTMLDivElement>(null);
  // AI assist rail starts collapsed so a 1-message thread doesn't burn 25%
  // of the viewport on duplicate paraphrases. Operator opens it explicitly.
  const [aiOpen, setAiOpen] = useState(false);

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

  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const restoreScrollRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const prevThreadIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const [threadResult, inboxResult, platformsResult, logsResult] = await Promise.allSettled([
      apiGet<ThreadResponse>(`/runner/data/thread/${threadId}`),
      apiGet<InboxResponse>("/runner/data/inbox"),
      apiGet<PlatformCard[]>("/runner/data/platforms"),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=150")
    ]);
    if (threadResult.status === "fulfilled") {
      setThread(threadResult.value);
      setComposer((prev) => {
        if (prev) return prev; // operator already typed something
        const explicitDraft = threadResult.value.draft;
        if (explicitDraft) {
          setComposerSource("draft");
          return explicitDraft;
        }
        // No explicit draft — fall back to AI predraft (first suggested
        // reply) so the operator opens an already-filled composer when
        // /today has pre-warmed the cache.
        const aiPredraft = threadResult.value.suggestedReplies?.replies?.[0]?.text?.trim();
        if (aiPredraft) {
          setComposerSource("predraft");
          return aiPredraft;
        }
        return "";
      });
      setError(null);
    } else {
      const message =
        threadResult.reason instanceof Error
          ? threadResult.reason.message
          : "Failed to load thread";
      setError(message);
    }
    if (inboxResult.status === "fulfilled") setSiblings(inboxResult.value.rows);
    if (platformsResult.status === "fulfilled") setPlatforms(platformsResult.value);
    if (logsResult.status === "fulfilled") setLogs(logsResult.value);
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    refresh().catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to load thread";
      setError(message);
      setLoading(false);
    });
  }, [refresh]);

  // SSE reconciliation for sends.
  useEffect(() => {
    const onRunnerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        type?: string;
        threadId?: string;
        clientSendId?: string;
        errorMessage?: string;
        errorKind?: "AUTH_REQUIRED" | "SELECTOR_FAIL" | "PROFILE_LOCKED" | "TRANSIENT" | "UNKNOWN";
      }>).detail;
      if (!detail || !threadId || detail.threadId !== threadId) return;
      if (detail.type === "MESSAGE_SENT" && detail.clientSendId) {
        void refresh().finally(() => {
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
        void refresh();
      }
    };
    window.addEventListener("runner-event", onRunnerEvent as EventListener);
    return () => window.removeEventListener("runner-event", onRunnerEvent as EventListener);
  }, [threadId, refresh]);

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
        // Network blip — try again next tick.
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [threadId, refresh]);

  const onSend = useCallback(async () => {
    if (!thread || !composer.trim() || sending) return;
    const clientSendId = uuid();
    const text = composer;
    const sentAt = new Date().toISOString();
    setPendingSends((prev) => [...prev, { clientSendId, text, sentAt }]);
    setComposer("");
    setSending(true);
    setError(null);
    stickToBottomRef.current = true;
    try {
      await apiPost(`/runner/control/thread/${thread.id}/send`, {
        text,
        clientSendId
      });
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : "Failed to enqueue send";
      setPendingSends((prev) =>
        prev.map((p) =>
          p.clientSendId === clientSendId ? { ...p, failed: true, errorMessage: message } : p
        )
      );
      setError(message);
      setComposer(text);
    } finally {
      setSending(false);
    }
  }, [composer, sending, thread]);

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
  // — sends are persisted server-side so an error here is rare (validation
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
  // loading-state tracking for the redesign's button labels — the older
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
      // enough — the operator sees the box flip back.
      const message = loopError instanceof Error ? loopError.message : "Failed to update open loop";
      setError(message);
      void refresh();
    }
  };

  const reassessThread = async () => {
    if (!thread || reassessing) return;
    setReassessing(true);
    setError(null);
    try {
      await apiPost(`/runner/control/thread/${thread.id}/reassess`, {});
      await refresh();
    } catch (reassessError) {
      const message = reassessError instanceof Error ? reassessError.message : "Reassess failed";
      setError(message);
    } finally {
      setReassessing(false);
    }
  };

  const transform = async (mode: "SHORTEN" | "MAKE_WARMER") => {
    if (!thread || !composer.trim() || transforming) return;
    setTransforming(mode);
    setError(null);
    try {
      const output = await apiPost<{ text: string }>(`/runner/control/thread/${thread.id}/transform`, {
        mode,
        text: composer
      });
      setComposer(output.text);
    } catch (transformError) {
      const message = transformError instanceof Error ? transformError.message : "Transform failed";
      setError(message);
    } finally {
      setTransforming(null);
    }
  };

  const composeFromIntent = async () => {
    if (!thread) return;
    const intent = composeIntent.trim();
    if (!intent || composing) return;
    setComposing(true);
    setComposeError(null);
    try {
      const output = await apiPost<{ text: string }>(`/runner/control/thread/${thread.id}/compose`, {
        intent
      });
      setComposeDraft(output.text);
    } catch (composeErr) {
      const message = composeErr instanceof Error ? composeErr.message : "Compose failed";
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
    return platforms.find((p) => p.platform === thread.platform && p.status === "DEGRADED");
  }, [platforms, thread]);

  const degradedDomDump = useMemo(() => {
    if (!thread) return undefined;
    return (
      logs.find((log) => log.platform === thread.platform && log.domDumpFile)?.domDumpFile ??
      thread.receipts.find((row) => row.domDumpFile)?.domDumpFile
    );
  }, [logs, thread]);

  // Voice match — built from this thread's outbound history. Memos
  // live up here (before early returns) so the React hook order is
  // stable across the loading/loaded transition.
  const voiceCorpus = useMemo(() => {
    if (!thread) return buildCorpusStats([]);
    return buildCorpusStats(
      thread.messages.filter((m) => m.direction === "OUT").map((m) => m.text)
    );
  }, [thread]);
  const voiceScore = useMemo(
    () => scoreDraftAgainstCorpus(composer, voiceCorpus),
    [composer, voiceCorpus]
  );

  // Pagination is now driven by the runner: `thread.messages` is whatever
  // the latest fetch returned (initial slice or initial + lazily-pulled
  // older pages). `messagePage.hasOlder` tells us whether more history
  // exists on the server.
  const visibleMessages: ThreadMessage[] = thread?.messages ?? [];
  const hasOlder = thread?.messagePage.hasOlder ?? false;

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
      prevThreadIdRef.current = thread.id;
    }
  }, [thread]);

  // After every layout pass that affects the timeline, do one of:
  //  (a) restore scroll position (we just prepended older messages)
  //  (b) jump to bottom (fresh thread or stickToBottomRef is true)
  useLayoutEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    if (restoreScrollRef.current) {
      const { prevHeight, prevTop } = restoreScrollRef.current;
      const delta = el.scrollHeight - prevHeight;
      el.scrollTop = prevTop + delta;
      restoreScrollRef.current = null;
      return;
    }
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [visibleMessages, pendingSends.length, loading]);

  const onTimelineScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < SCROLL_BOTTOM_THRESHOLD;
    // Scroll near the top + server says more exists → request the next
    // older page. Capture scroll position so the layout effect above can
    // restore it once the prepended messages render (no view jump).
    if (el.scrollTop < SCROLL_TOP_THRESHOLD && hasOlder && !loadingOlderMessages) {
      restoreScrollRef.current = { prevHeight: el.scrollHeight, prevTop: el.scrollTop };
      void loadOlderMessages();
    }
  };

  if (loading || !thread) {
    return (
      <div className="px-12 pt-14">
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      </div>
    );
  }

  const firstName = thread.personName.split(/\s+/)[0] ?? thread.personName;
  const risk = toDisplayRisk(thread.riskLevel);
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
  // fallback fired) — both surfaced inline below.
  const repliesReady = thread.suggestedReplies.replies.length > 0;
  const repliesGenerating =
    thread.suggestedRepliesStatus === "generating" && !repliesReady;
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

  const trimmedSummary = thread.summary?.trim() ?? "";
  const trimmedAsk = thread.whatTheyWant?.trim() ?? "";
  const askDuplicatesSummary =
    trimmedAsk && trimmedSummary &&
    (trimmedSummary.includes(trimmedAsk) || trimmedAsk.includes(trimmedSummary));
  const showAsk = trimmedAsk && !askDuplicatesSummary;

  const platformLabel = PLATFORM_LABEL[thread.platform];

  return (
    <div
      className={`grid h-full min-h-0 grid-cols-1 ${
        aiOpen
          ? "lg:grid-cols-[240px_minmax(0,1fr)_360px]"
          : "lg:grid-cols-[240px_minmax(0,1fr)]"
      }`}
    >
      {/* ───── Sibling-thread list ───── */}
      <aside className="hidden h-full min-h-0 flex-col overflow-y-auto border-r border-hairline bg-paper-2/30 lg:flex">
        <div className="sticky top-0 z-10 border-b border-hairline bg-[color-mix(in_oklch,var(--paper)_72%,transparent)] backdrop-blur-md backdrop-saturate-150 px-4 py-4">
          <div className="flex items-center justify-between gap-2">
            <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              Threads
            </p>
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
          </div>
        </div>
        <ul className="m-0 list-none space-y-[2px] p-2">
          {siblingRows.map((row) => {
            const active = row.id === thread.id;
            const dotClass =
              row.riskLevel === "RED"
                ? "bg-risk-overdue"
                : row.riskLevel === "AMBER"
                  ? "bg-risk-waiting"
                  : "bg-risk-fresh";
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
          {siblingRows.length === 0 ? (
            <li className="px-3 py-3 font-mono text-[11px] text-ink-3">no other threads</li>
          ) : null}
        </ul>
      </aside>

      {/* ───── Chat column ───── */}
      <div className="flex h-full min-h-0 flex-col border-r border-hairline">
        {degraded ? (
          <div className="flex-shrink-0 px-12 pt-6">
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
        >
          {/* Glassy sticky header. Sits inside the scroll container so the
              timeline scrolls visibly behind it — matches the iOS / Apple
              translucent-bar aesthetic the rest of the redesign nods at. */}
          <div className="sticky top-0 z-10 border-b border-hairline bg-[color-mix(in_oklch,var(--paper)_72%,transparent)] backdrop-blur-md backdrop-saturate-150 px-12 pb-4 pt-9">
            <button
              type="button"
              onClick={() => router.push("/today")}
              className="mb-4 inline-flex items-center gap-2 font-mono text-[12px] text-ink-3 hover:text-ink"
            >
              <ChevronLeft className="h-[14px] w-[14px]" strokeWidth={1.6} />
              Back to today
            </button>
            <header className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setProfileDrawerOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-4 rounded-row text-left transition-colors duration-calm hover:bg-paper-2"
                title="Open profile"
              >
                {thread.personAvatarUrl ? (
                  <span className="grid h-12 w-12 place-items-center overflow-hidden rounded-full bg-paper-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thread.personAvatarUrl}
                      alt=""
                      width={48}
                      height={48}
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                    />
                  </span>
                ) : (
                  <span className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[16px] font-semibold text-white">
                    {initials(thread.personName)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="m-0 font-display text-[22px] font-semibold tracking-[-0.02em]">
                    {thread.personName}
                  </h2>
                  <p className="mt-1 text-[12px] text-ink-2">
                    <span className="rounded bg-paper-2 px-[6px] py-[1px] text-[10px] font-medium uppercase tracking-[0.04em]">
                      {platformLabel}
                    </span>{" "}
                    <span className="text-ink-3">· {riskLabel}</span>
                  </p>
                </div>
              </button>
              <Button
                variant="quiet"
                disabled={reassessing}
                onClick={() => void reassessThread()}
                title="Re-summarise, reclassify, and regenerate suggested replies"
              >
                {reassessing ? "Reassessing…" : "Reassess"}
              </Button>
              <Button
                variant={aiOpen ? "primary" : "quiet"}
                onClick={() => setAiOpen((v) => !v)}
                title="Toggle the AI assist sidebar"
              >
                <Sparkles className="h-[14px] w-[14px]" strokeWidth={1.6} />
                AI assist
              </Button>
            </header>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="ghost"
                onClick={() =>
                  runAction(
                    apiPost(`/runner/control/thread/${thread.id}/draft`, { text: composer }),
                    setError
                  )
                }
              >
                Save draft
              </Button>
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
              >
                Snooze
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  runAction(
                    apiPost(`/runner/control/thread/${thread.id}/mark-done`, {}),
                    setError,
                    refresh
                  )
                }
              >
                Mark as handled
              </Button>
              <Button
                variant="ghost"
                onClick={() => runAction(apiPost(`/runner/control/thread/${thread.id}/open`, {}), setError)}
              >
                Open in {platformLabel}
              </Button>
              <Button
                variant="ghost"
                onClick={() => runAction(apiPost(`/runner/control/thread/${thread.id}/rescan`, {}), setError, refresh)}
              >
                Rescan
              </Button>
              <Button variant="ghost" onClick={() => setReceiptsOpen(true)}>
                Receipts
              </Button>
            </div>
          </div>

          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-[18px] px-12 py-7">
            {hasOlder ? (
              <div className="flex items-center justify-center gap-2 self-center font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                {loadingOlderMessages ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    loading older messages…
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void loadOlderMessages()}
                    className="hover:text-ink"
                  >
                    load older messages
                  </button>
                )}
              </div>
            ) : (
              <div className="self-center font-mono text-[11px] uppercase tracking-[0.06em] text-ink-4">
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
              const senderLabel =
                message.senderName ?? (message.direction === "OUT" ? "You" : firstName);
              return (
                <div key={message.id} className="contents">
                  {dayLabel ? <DayDivider label={dayLabel} /> : null}
                  <div
                    className={`flex max-w-[72%] flex-col ${
                      message.direction === "OUT" ? "self-end items-end" : "self-start items-start"
                    }`}
                  >
                    <span className="mb-[4px] text-[11px] font-medium tracking-[-0.005em] text-ink-2">
                      {senderLabel}
                    </span>
                    <div
                      className={`text-balance whitespace-pre-wrap px-4 py-3 text-[14.5px] leading-[1.5] ${
                        message.direction === "OUT"
                          ? "rounded-2xl rounded-br-[6px] bg-ink text-paper"
                          : "rounded-2xl rounded-bl-[6px] bg-paper-2 text-ink"
                      }`}
                    >
                      {message.text}
                    </div>
                    <span className="mt-[6px] flex items-center gap-2 text-[11px] text-ink-3">
                      <span>{formatClock(message.timestamp)}</span>
                      {/* Honest "Sent via automation ✓" — only shown when
                          the runner actually flagged this message as sent
                          via the bot, per #65. The previous always-on
                          indicator from #61 was dishonest. */}
                      {message.direction === "OUT" && message.sentVia === "automation" ? (
                        <span className="text-ink-4">· sent via automation ✓</span>
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
                  className="flex max-w-[72%] flex-col items-end self-end"
                >
                  {isEditing ? (
                    <textarea
                      value={editingScheduledDraft}
                      onChange={(event) => setEditingScheduledDraft(event.target.value)}
                      autoFocus
                      rows={Math.max(2, Math.min(8, editingScheduledDraft.split("\n").length))}
                      className="w-full resize-y rounded-2xl rounded-br-[6px] border border-hairline-strong bg-paper px-4 py-3 text-[14.5px] leading-[1.5] text-ink outline-none focus:border-ink-2"
                      onKeyDown={(event) => {
                        // Cmd/Ctrl-Enter saves, Escape cancels — same shortcuts the
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
                className="flex max-w-[72%] flex-col items-end self-end"
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

        <div className="flex-shrink-0 border-t border-hairline bg-paper">
          <div className="mx-auto w-full max-w-[820px] px-12 pb-5 pt-4">
            {error ? (
              <p className="mb-2 font-mono text-[11px] text-risk-overdue">{error}</p>
            ) : null}
            {thread.relationshipMemory && thread.relationshipMemory.otherThreadCount > 0 ? (
              <div data-testid="memory-chip" className="relative mb-2">
                <button
                  type="button"
                  onClick={() => setMemoryOpen((prev) => !prev)}
                  className="inline-flex items-center gap-2 rounded-full border border-hairline bg-paper-2 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 hover:bg-paper"
                  aria-expanded={memoryOpen}
                >
                  <Sparkles className="h-[11px] w-[11px]" />
                  Memory · {thread.relationshipMemory.otherThreadCount} prior conversation
                  {thread.relationshipMemory.otherThreadCount === 1 ? "" : "s"}
                  {thread.relationshipMemory.tags.length > 0
                    ? ` · ${thread.relationshipMemory.tags.length} tag${thread.relationshipMemory.tags.length === 1 ? "" : "s"}`
                    : ""}
                </button>
                {memoryOpen ? (
                  <div className="absolute bottom-full left-0 mb-2 w-[480px] max-w-[80vw] rounded-card border border-hairline bg-paper p-3 text-[12px] leading-snug shadow-card">
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
            <div className="rounded-card border border-hairline bg-paper px-[18px] pb-[14px] pt-[16px] shadow-card">
              {composerSource === "predraft" ? (
                <div
                  data-testid="ai-predraft-badge"
                  className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em] text-accent-ink"
                >
                  <Sparkles className="h-[12px] w-[12px]" />
                  AI predraft — review before sending
                  <button
                    type="button"
                    onClick={() => {
                      setComposer("");
                      setComposerSource("empty");
                    }}
                    className="ml-1 text-ink-3 hover:text-ink"
                  >
                    clear
                  </button>
                </div>
              ) : null}
              <textarea
                placeholder={`Reply to ${firstName}…`}
                value={composer}
                onChange={(event) => {
                  setComposer(event.target.value);
                  if (composerSource === "predraft" || composerSource === "empty") {
                    setComposerSource("user");
                  }
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    // #65: stop the native window-level keydown listener
                    // (still in scope for global shortcuts) so onSend
                    // doesn't fire twice when the composer has focus.
                    event.nativeEvent.stopImmediatePropagation();
                    void onSend();
                  }
                }}
                rows={3}
                className="w-full resize-none border-0 bg-transparent text-[15px] leading-[1.55] text-ink outline-none placeholder:text-ink-4"
              />
              {composer.trim().length >= 20 && voiceCorpus.sampleCount >= 2 ? (
                <div
                  data-testid="voice-meter"
                  className="mt-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.06em]"
                  title={voiceScore.signals[0]?.signal}
                >
                  <span
                    className={`inline-block h-[6px] w-[6px] rounded-full ${
                      voiceScore.band === "green"
                        ? "bg-risk-fresh"
                        : voiceScore.band === "amber"
                          ? "bg-risk-waiting"
                          : "bg-risk-overdue"
                    }`}
                  />
                  <span
                    className={
                      voiceScore.band === "red"
                        ? "text-risk-overdue"
                        : voiceScore.band === "amber"
                          ? "text-risk-waiting"
                          : "text-ink-3"
                    }
                  >
                    Voice match {voiceScore.score}/100
                  </span>
                  {voiceScore.signals[0] ? (
                    <span className="normal-case tracking-normal text-ink-3">
                      · {voiceScore.signals[0].signal.toLowerCase()}
                    </span>
                  ) : null}
                  {voiceScore.band !== "green" ? (
                    <button
                      type="button"
                      disabled={voiceRewritePending}
                      onClick={() => {
                        setVoiceRewritePending(true);
                        apiPost<{ text: string }>(`/runner/control/thread/${thread.id}/voice-rewrite`, {
                          draft: composer
                        })
                          .then((r) => {
                            if (r.text) setComposer(r.text);
                          })
                          .catch((rewriteErr: unknown) => {
                            const message =
                              rewriteErr instanceof Error ? rewriteErr.message : "Rewrite failed";
                            setError(message);
                          })
                          .finally(() => setVoiceRewritePending(false));
                      }}
                      className="ml-1 underline-offset-2 hover:underline disabled:opacity-50"
                    >
                      {voiceRewritePending ? "rewriting…" : "rewrite in my voice"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-[12px] flex flex-wrap items-center gap-3 border-t border-hairline pt-[12px]">
                {/* Suggested-replies dropdown. Replaces the row of chips that
                    used to wrap onto multiple lines on narrower viewports;
                    keeps the composer compact and previews each suggestion's
                    text before the operator commits to it. */}
                <div className="relative" ref={chipsMenuRef}>
                  <button
                    type="button"
                    onClick={() => setChipsMenuOpen((v) => !v)}
                    disabled={repliesGenerating}
                    className="inline-flex items-center gap-2 rounded-pill border border-hairline px-3 py-[7px] text-[12px] text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:opacity-50"
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
                    <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-[360px] overflow-hidden rounded-row border border-hairline bg-paper p-[6px] shadow-pop">
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
                <div className="flex flex-1 items-center justify-end gap-3">
                  <button
                    type="button"
                    disabled={!composer.trim() || transforming !== null}
                    onClick={() => void transform("SHORTEN")}
                    className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink disabled:opacity-40"
                  >
                    {transforming === "SHORTEN" ? "shortening…" : "shorten"}
                  </button>
                  <button
                    type="button"
                    disabled={!composer.trim() || transforming !== null}
                    onClick={() => void transform("MAKE_WARMER")}
                    className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink disabled:opacity-40"
                  >
                    {transforming === "MAKE_WARMER" ? "warming…" : "make warmer"}
                  </button>
                  <div className="relative" ref={scheduleMenuRef}>
                    <button
                      type="button"
                      onClick={() => setScheduleMenuOpen((v) => !v)}
                      disabled={!composer.trim() || sending || scheduling}
                      title="Schedule send"
                      aria-label="Schedule send"
                      className="inline-flex h-[36px] w-[36px] items-center justify-center rounded-full border border-hairline text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Clock className="h-[14px] w-[14px]" strokeWidth={1.8} />
                    </button>
                    {scheduleMenuOpen ? (
                      <div className="absolute bottom-[calc(100%+8px)] right-0 z-20 w-[300px] overflow-hidden rounded-row border border-hairline bg-paper p-[6px] shadow-pop">
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
                  <Button variant="primary" onClick={() => void onSend()} disabled={sending || !composer.trim()}>
                    {sending ? <Loader2 className="h-[14px] w-[14px] animate-spin" /> : <Send className="h-[14px] w-[14px]" strokeWidth={1.8} />}
                    Send
                  </Button>
                </div>
              </div>
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
      <aside className={`${aiOpen ? "hidden lg:block" : "hidden"} h-full min-h-0 overflow-y-auto bg-paper-2/40`}>
        <div className="flex flex-col gap-7 px-7 py-10">
          {trimmedSummary || trimmedAsk ? (
            <section>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                What they want
              </p>
              <p className="m-0 text-balance text-[14px] leading-[1.55] text-ink">
                {trimmedSummary || trimmedAsk}
              </p>
              {showAsk && trimmedSummary ? (
                <p className="mt-3 border-t border-hairline pt-3 text-[13px] leading-[1.55] text-ink-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                    the ask ·{" "}
                  </span>
                  {trimmedAsk}
                </p>
              ) : null}
            </section>
          ) : null}

          {/* Open loops — active rows render with an unchecked box; ticking
              dismisses the loop (#62). Dismissed loops still render below
              in a muted, struck-through form so the operator can restore
              one by un-ticking. */}
          {thread.openLoops.length || thread.dismissedOpenLoops.length ? (
            <section>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                Open loops
              </p>
              <ul className="m-0 list-none space-y-[6px] p-0">
                {thread.openLoops.map((item) => (
                  <li key={`open:${item}`} className="flex items-baseline gap-2 text-[13px] leading-[1.5] text-ink-2">
                    <input
                      type="checkbox"
                      checked={false}
                      onChange={() => void toggleOpenLoop(item, true)}
                      className="mt-[2px] h-[12px] w-[12px] cursor-pointer accent-ink"
                      aria-label={`Mark "${item}" as resolved`}
                    />
                    {item}
                  </li>
                ))}
                {thread.dismissedOpenLoops.map((item) => (
                  <li
                    key={`dismissed:${item}`}
                    className="flex items-baseline gap-2 text-[13px] leading-[1.5] text-ink-4 line-through"
                  >
                    <input
                      type="checkbox"
                      checked={true}
                      onChange={() => void toggleOpenLoop(item, false)}
                      className="mt-[2px] h-[12px] w-[12px] cursor-pointer accent-ink-3"
                      aria-label={`Restore "${item}" as an open loop`}
                    />
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
              Write in my voice
            </p>
            <p className="mb-3 text-[12.5px] leading-[1.55] text-ink-3">
              Tell the AI what you want to say. It rewrites in your voice for this thread.
            </p>
            <textarea
              value={composeIntent}
              onChange={(event) => setComposeIntent(event.target.value)}
              placeholder="e.g. ask if free for a quick coffee next week"
              rows={3}
              className="w-full resize-none rounded-row border border-hairline bg-paper px-3 py-2 text-[13.5px] leading-[1.55] text-ink outline-none transition-[border-color] duration-calm placeholder:text-ink-4 focus:border-hairline-strong"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="primary"
                disabled={composing || !composeIntent.trim()}
                onClick={() => void composeFromIntent()}
              >
                {composing ? (
                  <Loader2 className="h-[14px] w-[14px] animate-spin" />
                ) : (
                  <Sparkles className="h-[14px] w-[14px]" strokeWidth={1.8} />
                )}
                {composing ? "Writing…" : "Write"}
              </Button>
              {composeError ? (
                <span className="font-mono text-[11px] text-risk-overdue">{composeError}</span>
              ) : null}
            </div>
            {composeDraft ? (
              <div className="mt-3 rounded-row border border-hairline bg-paper p-3 text-[13.5px] leading-[1.55] text-ink">
                <p className="m-0 whitespace-pre-wrap">{composeDraft}</p>
                <div className="mt-3 flex items-center gap-3">
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
                </div>
              </div>
            ) : null}
          </section>
        </div>
      </aside>

      <ReceiptsDrawer
        open={receiptsOpen}
        onClose={() => setReceiptsOpen(false)}
        rows={thread.receipts}
        title="Thread receipts"
      />

      <ProfileDrawer
        open={profileDrawerOpen}
        personId={thread.personId ?? null}
        onClose={() => setProfileDrawerOpen(false)}
      />
    </div>
  );
}
