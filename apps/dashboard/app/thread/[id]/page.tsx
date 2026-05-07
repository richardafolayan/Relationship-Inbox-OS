"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { v4 as uuid } from "uuid";
import { ChevronDown, ChevronLeft, Loader2, Send, Sparkles } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard, ThreadMessage, ThreadResponse } from "@/lib/types";
import { formatClock, formatRelative } from "@/lib/time";
import { initials, PLATFORM_LABEL, toDisplayRisk } from "@/lib/risk";
import { Button } from "@/components/ui/button";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { DegradedBanner } from "@/components/common/degraded-banner";

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

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const threadId = params.id;

  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [siblings, setSiblings] = useState<InboxRow[]>([]);
  const [focusQueue, setFocusQueue] = useState<string[]>([]);
  const [openLoopChecks, setOpenLoopChecks] = useState<Record<string, boolean>>({});
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
  const [error, setError] = useState<string | null>(null);
  const [chipsMenuOpen, setChipsMenuOpen] = useState(false);
  const chipsMenuRef = useRef<HTMLDivElement>(null);

  const [pendingSends, setPendingSends] = useState<
    Array<{
      clientSendId: string;
      text: string;
      sentAt: string;
      failed?: boolean;
      errorMessage?: string;
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
    const [threadResult, platformsResult, logsResult, inboxResult] = await Promise.allSettled([
      apiGet<ThreadResponse>(`/runner/data/thread/${threadId}`),
      apiGet<PlatformCard[]>("/runner/data/platforms"),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=150"),
      apiGet<InboxResponse>("/runner/data/inbox")
    ]);
    if (threadResult.status === "fulfilled") {
      setThread(threadResult.value);
      setComposer((prev) => prev || threadResult.value.draft || "");
      setError(null);
    } else {
      const message =
        threadResult.reason instanceof Error
          ? threadResult.reason.message
          : "Failed to load thread";
      setError(message);
    }
    if (platformsResult.status === "fulfilled") setPlatforms(platformsResult.value);
    if (logsResult.status === "fulfilled") setLogs(logsResult.value);
    if (inboxResult.status === "fulfilled") setSiblings(inboxResult.value.rows);
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    refresh().catch((err) => {
      const message = err instanceof Error ? err.message : "Failed to load thread";
      setError(message);
      setLoading(false);
    });
  }, [refresh]);

  // Reply Focus Mode handoff. /at-risk primes inbox_focus_queue with
  // thread ids; we read it once per mount so the queue can survive a
  // navigation but we keep state local.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("inbox_focus_queue");
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        setFocusQueue(parsed as string[]);
      }
    } catch {
      // bad JSON — ignore.
    }
  }, []);

  // Per-thread Open Loops checked-state, persisted in localStorage so a
  // user can tick boxes off without the runner needing schema changes.
  useEffect(() => {
    if (!threadId) return;
    try {
      const raw = window.localStorage.getItem(`inbox_open_loops_${threadId}`);
      if (!raw) {
        setOpenLoopChecks({});
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        setOpenLoopChecks(parsed as Record<string, boolean>);
      }
    } catch {
      setOpenLoopChecks({});
    }
  }, [threadId]);

  const toggleOpenLoop = (loop: string) => {
    setOpenLoopChecks((prev) => {
      const next = { ...prev, [loop]: !prev[loop] };
      try {
        window.localStorage.setItem(`inbox_open_loops_${threadId}`, JSON.stringify(next));
      } catch {
        // localStorage full or disabled — checked state just won't persist.
      }
      return next;
    });
  };

  const focusIndex = focusQueue.indexOf(threadId);
  const focusNext = focusQueue[focusIndex + 1] ?? null;
  const focusRemaining = focusIndex >= 0 ? focusQueue.length - focusIndex - 1 : 0;
  const exitFocus = () => {
    window.localStorage.removeItem("inbox_focus_queue");
    setFocusQueue([]);
  };

  // SSE reconciliation for sends.
  useEffect(() => {
    const onRunnerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        type?: string;
        threadId?: string;
        clientSendId?: string;
        errorMessage?: string;
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
              ? { ...p, failed: true, errorMessage: message }
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
    setPendingSends((prev) => prev.filter((p) => p.clientSendId !== clientSendId));
    setComposer(target.text);
    setTimeout(() => void onSend(), 0);
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
        if (!current || current.id !== olderPage.id) {
          return olderPage;
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

  // Pagination is now driven by the runner: `thread.messages` is whatever
  // the latest fetch returned (initial slice or initial + lazily-pulled
  // older pages). `messagePage.hasOlder` tells us whether more history
  // exists on the server.
  const visibleMessages: ThreadMessage[] = thread?.messages ?? [];
  const hasOlder = thread?.messagePage.hasOlder ?? false;

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
  const lastMessage = thread.messages[thread.messages.length - 1];
  const replied = !thread.needsReply && lastMessage?.direction === "OUT";
  const riskLabel =
    risk === "overdue"
      ? `overdue · last reply ${formatRelative(lastInboundAt)}`
      : risk === "waiting"
        ? `waiting · last reply ${formatRelative(lastInboundAt)}`
        : `fresh · last reply ${formatRelative(lastTimestamp)}`;
  const statusBadgeClass =
    risk === "overdue"
      ? "bg-risk-overdue/10 text-risk-overdue"
      : risk === "waiting"
        ? "bg-risk-waiting/15 text-risk-waiting"
        : "bg-risk-fresh/15 text-risk-fresh";
  const statusBadgeLabel =
    (risk === "overdue" ? "RED" : risk === "waiting" ? "AMBER" : "GREEN") +
    (replied ? " · Replied" : thread.needsReply ? " · Needs reply" : "");

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
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_360px]">
      {/* ───── Threads list column ───── */}
      <aside className="hidden h-full min-h-0 overflow-y-auto border-r border-hairline bg-paper-2/30 lg:block">
        <div className="px-3 py-4">
          <p className="mb-2 px-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            Threads
          </p>
          <ul className="m-0 list-none p-0">
            {siblings.slice(0, 50).map((row) => {
              const active = row.id === threadId;
              const dotClass =
                row.riskLevel === "RED"
                  ? "bg-risk-overdue"
                  : row.riskLevel === "AMBER"
                    ? "bg-risk-waiting"
                    : "bg-risk-fresh";
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => router.push(`/thread/${row.id}`)}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors duration-calm ${
                      active ? "bg-paper" : "hover:bg-paper"
                    }`}
                  >
                    <span className={`mt-[6px] h-[6px] w-[6px] flex-shrink-0 rounded-full ${dotClass}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium tracking-[-0.005em] text-ink">
                        {row.personName}
                      </span>
                      <span className="block truncate text-[11.5px] text-ink-3">
                        {row.lastMessageDirection === "OUT" ? "You: " : ""}
                        {row.preview}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
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
            <div className="mb-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => router.push(focusIndex >= 0 ? "/at-risk" : "/today")}
                className="inline-flex items-center gap-2 font-mono text-[12px] text-ink-3 hover:text-ink"
              >
                <ChevronLeft className="h-[14px] w-[14px]" strokeWidth={1.6} />
                {focusIndex >= 0 ? "Back to at-risk" : "Back to today"}
              </button>
              {focusIndex >= 0 ? (
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                    Focus · {focusRemaining} left
                  </span>
                  {focusNext ? (
                    <Button
                      variant="quiet"
                      onClick={() => router.push(`/thread/${focusNext}`)}
                    >
                      Next →
                    </Button>
                  ) : (
                    <Button variant="quiet" onClick={exitFocus}>
                      Done
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
            <header className="flex items-center gap-4">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-gradient-to-br from-[oklch(72%_0.10_35)] to-[oklch(60%_0.13_22)] font-display text-[16px] font-semibold text-white">
                {initials(thread.personName)}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="m-0 font-display text-[26px] font-semibold tracking-[-0.02em]">
                  {thread.personName}
                </h2>
                <p className="mt-1 font-mono text-[12px] tracking-[0.02em] text-ink-3">
                  {platformLabel} · {riskLabel}
                </p>
              </div>
              <span
                className={`whitespace-nowrap rounded-pill px-3 py-1 font-mono text-[11px] uppercase tracking-[0.06em] ${statusBadgeClass}`}
              >
                {statusBadgeLabel}
              </span>
              <button
                type="button"
                disabled={reassessing}
                onClick={() => void reassessThread()}
                className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink disabled:opacity-50"
                title="Re-summarise, reclassify, and regenerate suggested replies"
              >
                {reassessing ? "reassessing…" : "reassess"}
              </button>
            </header>
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
            {visibleMessages.map((message) => {
              if (message.text.trim() === "[system event]") {
                return (
                  <div
                    key={message.id}
                    className="self-center font-mono text-[11px] tracking-[0.02em] text-ink-3"
                  >
                    · automated reply at {formatClock(message.timestamp)} ·
                  </div>
                );
              }
              return (
                <div
                  key={message.id}
                  className={`flex max-w-[72%] flex-col ${
                    message.direction === "OUT" ? "self-end items-end" : "self-start items-start"
                  }`}
                >
                  <div
                    className={`text-balance whitespace-pre-wrap px-4 py-3 text-[14.5px] leading-[1.5] ${
                      message.direction === "OUT"
                        ? "rounded-2xl rounded-br-[6px] bg-ink text-paper"
                        : "rounded-2xl rounded-bl-[6px] bg-paper-2 text-ink"
                    }`}
                  >
                    {message.text}
                  </div>
                  <span className="mt-[6px] font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    {formatClock(message.timestamp)}
                  </span>
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
                      <span className="text-risk-overdue">· failed</span>
                      <button
                        type="button"
                        onClick={() => retryPendingSend(pending.clientSendId)}
                        className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
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
              </div>
            ))}
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-hairline bg-paper">
          <div className="mx-auto w-full max-w-[820px] px-12 pb-5 pt-4">
            {error ? (
              <p className="mb-2 font-mono text-[11px] text-risk-overdue">{error}</p>
            ) : null}
            <div className="rounded-card border border-hairline bg-paper px-[18px] pb-[14px] pt-[16px] shadow-card">
              <textarea
                placeholder={`Reply to ${firstName}…`}
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                rows={3}
                className="w-full resize-none border-0 bg-transparent text-[15px] leading-[1.55] text-ink outline-none placeholder:text-ink-4"
              />
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
                  <Button variant="primary" onClick={() => void onSend()} disabled={sending || !composer.trim()}>
                    {sending ? <Loader2 className="h-[14px] w-[14px] animate-spin" /> : <Send className="h-[14px] w-[14px]" strokeWidth={1.8} />}
                    Send
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
              <button
                type="button"
                onClick={() =>
                  runAction(
                    apiPost(`/runner/control/thread/${thread.id}/draft`, { text: composer }),
                    setError
                  )
                }
                className="hover:text-ink"
              >
                save draft
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction(
                    apiPost(`/runner/control/thread/${thread.id}/snooze`, { hours: 6 }),
                    setError,
                    refresh
                  )
                }
                className="hover:text-ink"
              >
                snooze 6h
              </button>
              <button
                type="button"
                onClick={() =>
                  runAction(
                    apiPost(`/runner/control/thread/${thread.id}/mark-done`, {}),
                    setError,
                    refresh
                  )
                }
                className="hover:text-ink"
              >
                mark as handled
              </button>
              <button
                type="button"
                onClick={() => runAction(apiPost(`/runner/control/thread/${thread.id}/open`, {}), setError)}
                className="hover:text-ink"
              >
                open in {platformLabel}
              </button>
              <button
                type="button"
                onClick={() => runAction(apiPost(`/runner/control/thread/${thread.id}/rescan`, {}), setError, refresh)}
                className="hover:text-ink"
              >
                rescan
              </button>
              <button type="button" onClick={() => setReceiptsOpen(true)} className="hover:text-ink">
                receipts
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ───── Context rail ───── */}
      <aside className="hidden h-full min-h-0 overflow-y-auto bg-paper-2/40 lg:block">
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

          {thread.openLoops.length ? (
            <section>
              <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                Open loops
              </p>
              <ul className="m-0 list-none space-y-[6px] p-0">
                {thread.openLoops.map((item) => {
                  const checked = !!openLoopChecks[item];
                  return (
                    <li key={item}>
                      <label
                        className={`flex cursor-pointer items-baseline gap-2 text-[13px] leading-[1.5] transition-colors duration-calm ${
                          checked ? "text-ink-3 line-through" : "text-ink-2"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOpenLoop(item)}
                          className="mt-[3px] h-[14px] w-[14px] flex-shrink-0 cursor-pointer accent-ink"
                        />
                        <span>{item}</span>
                      </label>
                    </li>
                  );
                })}
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
    </div>
  );
}
