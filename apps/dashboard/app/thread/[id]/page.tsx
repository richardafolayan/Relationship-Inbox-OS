"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { v4 as uuid } from "uuid";
import { ExternalLink, RefreshCcw, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, PlatformCard, ThreadResponse } from "@/lib/types";
import { formatClock, formatRelative } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { DegradedBanner } from "@/components/common/degraded-banner";

function riskTone(level: string): "green" | "amber" | "red" {
  if (level === "RED") {
    return "red";
  }
  if (level === "AMBER") {
    return "amber";
  }
  return "green";
}

export default function ThreadPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const threadId = params.id;

  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [inboxRows, setInboxRows] = useState<InboxResponse["rows"]>([]);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [composer, setComposer] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Compose-in-voice helper state. Replaces the old Notes+tags card so
  // the operator can describe what they want to say in plain words and
  // get back a draft calibrated to past outbound messages on this
  // thread. Persists nothing — the only action that escapes this card
  // is "Use this", which writes into the main composer.
  const [composeIntent, setComposeIntent] = useState("");
  const [composeDraft, setComposeDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  // Reassess: one click regenerates summary + what-they-want + open
  // loops + classification, and burns the suggested-replies cache so
  // the next refresh pulls fresh ones too.
  const [reassessing, setReassessing] = useState(false);
  // Optimistic-UI bubbles: when the user clicks Send, we immediately push
  // a temporary OUT message into the timeline so they see feedback even
  // when the runner's send is queued behind a scan (which can take 30s+).
  // Once the runner persists the real message, refresh() pulls it into
  // `thread.messages` and we drop the matching pending bubble.
  const [pendingSends, setPendingSends] = useState<
    Array<{
      clientSendId: string;
      text: string;
      sentAt: string;
      failed?: boolean;
      errorMessage?: string;
    }>
  >([]);
  // Mirror of pendingSends accessible from the polling effect without
  // re-creating its interval each time a bubble is added/removed. The
  // poll only needs to read the current list; subscribing via the
  // useEffect deps would tear down + re-arm the timer per send.
  const pendingSendsRef = useRef(pendingSends);
  useEffect(() => {
    pendingSendsRef.current = pendingSends;
  }, [pendingSends]);

  const refresh = useCallback(async () => {
    const [threadData, inbox, platformRows, logRows] = await Promise.all([
      apiGet<ThreadResponse>(`/runner/data/thread/${threadId}`),
      apiGet<InboxResponse>("/runner/data/inbox"),
      apiGet<PlatformCard[]>("/runner/data/platforms"),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=150")
    ]);

    setThread(threadData);
    setInboxRows(inbox.rows);
    setPlatforms(platformRows);
    setLogs(logRows);
    setComposer((prev) => prev || threadData.draft || "");
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Optimistic-UI reconciliation: when the runner finishes processing a
  // SendRequest in the background, it emits MESSAGE_SENT or
  // MESSAGE_SEND_FAILED with the same clientSendId we used for the
  // optimistic bubble. Match by clientSendId so the right bubble flips —
  // important when the user fires multiple sends in a row.
  useEffect(() => {
    const onRunnerEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        type?: string;
        threadId?: string;
        clientSendId?: string;
        errorMessage?: string;
      }>).detail;
      if (!detail || !threadId) return;
      if (detail.threadId !== threadId) return;
      if (detail.type === "MESSAGE_SENT" && detail.clientSendId) {
        // Refresh first so the persisted OUT message is in thread.messages
        // before we drop the optimistic stand-in (no flash).
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
      }
    };
    window.addEventListener("runner-event", onRunnerEvent as EventListener);
    return () => window.removeEventListener("runner-event", onRunnerEvent as EventListener);
  }, [threadId, refresh]);

  // Polling fallback for the optimistic-UI reconciliation above. SSE on
  // /events is the primary path, but Next.js's HTTP rewrite proxy has
  // historically buffered or timed out long-lived streams in dev — when
  // that breaks, MESSAGE_SENT never arrives in the browser and the
  // bubble sticks on "Sending…" even though the runner long since
  // persisted the OUT message. The system status bar already polls
  // /data/send-queue every 3s for its own banner; we ride the same
  // endpoint and reconcile pendingSends ourselves so the thread page
  // doesn't depend on SSE staying healthy.
  useEffect(() => {
    if (!threadId) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      // Bail out cheaply when there's nothing to reconcile — keeps the
      // poll free in the common case (no in-flight sends on this thread).
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
          // Refresh first so the persisted OUT message is in thread.messages
          // before we drop the optimistic bubble (mirrors the SSE handler so
          // the user never sees a flash of empty timeline).
          await refresh();
          if (cancelled) return;
          setPendingSends((prev) => prev.filter((p) => !sentIds.has(p.clientSendId)));
        } else if (next.some((p, i) => p !== pendingSendsRef.current[i])) {
          setPendingSends(next);
        }
      } catch {
        // Network blip — try again on the next tick.
      }
    };
    const timer = setInterval(() => void tick(), 3000);
    // Run once immediately so a freshly-loaded page reconciles without
    // waiting 3s.
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [threadId, refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void onSend();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const timeline = useMemo(() => {
    if (!thread) {
      return [];
    }

    let lastDate = "";
    return thread.messages.map((message) => {
      const dateKey = new Date(message.timestamp).toDateString();
      const showDivider = dateKey !== lastDate;
      lastDate = dateKey;
      return {
        ...message,
        showDivider,
        dividerLabel: new Intl.DateTimeFormat("en-GB", {
          weekday: "long",
          month: "short",
          day: "numeric"
        }).format(new Date(message.timestamp))
      };
    });
  }, [thread]);

  const degradedPlatform = useMemo(() => {
    if (!thread) {
      return undefined;
    }
    return platforms.find((platform) => platform.platform === thread.platform && platform.status === "DEGRADED");
  }, [platforms, thread]);

  const degradedDomDump = useMemo(() => {
    if (!thread) {
      return undefined;
    }

    return (
      logs.find((log) => log.platform === thread.platform && log.domDumpFile)?.domDumpFile ??
      thread.receipts.find((row) => row.domDumpFile)?.domDumpFile
    );
  }, [logs, thread]);

  const onSend = async () => {
    if (!thread || !composer.trim() || sending) {
      return;
    }

    const clientSendId = uuid();
    const text = composer;
    const sentAt = new Date().toISOString();

    // Push optimistic bubble before awaiting the runner so the user sees
    // immediate feedback. The runner now returns within ~50ms (just inserts
    // a SendRequest PENDING row); the actual adapter call happens
    // asynchronously and notifies us via MESSAGE_SENT / MESSAGE_SEND_FAILED
    // events keyed by clientSendId.
    setPendingSends((prev) => [...prev, { clientSendId, text, sentAt }]);
    setComposer("");
    setSending(true);
    setError(null);
    try {
      await apiPost(`/runner/control/thread/${thread.id}/send`, {
        text,
        clientSendId
      });
      // The POST has returned with the queued state. The optimistic bubble
      // stays on screen with its "Sending…" badge. The /events SSE listener
      // (effect below) will replace it with the persisted OUT message when
      // MESSAGE_SENT for this clientSendId arrives, or flip it to a failed
      // state if MESSAGE_SEND_FAILED arrives.
    } catch (sendError) {
      // Enqueue itself failed — usually a validation error or runner offline.
      // The send never made it to the queue, so we surface it inline.
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
  };

  const retryPendingSend = async (clientSendId: string) => {
    const target = pendingSends.find((p) => p.clientSendId === clientSendId);
    if (!target || !thread) return;
    // Fire a NEW clientSendId — the previous one is permanently linked to
    // the FAILED SendRequest row in the runner. Drop the failed bubble so
    // the new attempt's optimistic bubble takes its place.
    setPendingSends((prev) => prev.filter((p) => p.clientSendId !== clientSendId));
    setComposer(target.text);
    // Defer to next tick so React applies the composer update before onSend
    // reads it.
    setTimeout(() => void onSend(), 0);
  };

  const transform = async (mode: "SHORTEN" | "MAKE_WARMER") => {
    if (!composer.trim() || !thread) {
      return;
    }

    try {
      const output = await apiPost<{ text: string }>(`/runner/control/thread/${thread.id}/transform`, {
        mode,
        text: composer
      });
      setComposer(output.text);
      setError(null);
    } catch (transformError) {
      const message = transformError instanceof Error ? transformError.message : "Transform failed";
      console.warn("[action]", message);
      setError(message);
    }
  };

  const composeIntentToVoice = async () => {
    const intent = composeIntent.trim();
    if (!intent || !thread || composing) return;
    setComposing(true);
    setComposeError(null);
    try {
      const output = await apiPost<{ text: string }>(
        `/runner/control/thread/${thread.id}/compose`,
        { intent }
      );
      setComposeDraft(output.text);
    } catch (composeErr) {
      const message = composeErr instanceof Error ? composeErr.message : "Compose failed";
      setComposeError(message);
    } finally {
      setComposing(false);
    }
  };

  const reassessThread = async () => {
    if (!thread || reassessing) return;
    setReassessing(true);
    setError(null);
    try {
      await apiPost(`/runner/control/thread/${thread.id}/reassess`, {});
      // Refresh pulls the new summary + what-they-want + open-loops +
      // category, and the now-empty suggestedReplies cache will be
      // regenerated by the /data/thread handler on the same fetch.
      await refresh();
    } catch (reassessError) {
      const message = reassessError instanceof Error ? reassessError.message : "Reassess failed";
      setError(message);
    } finally {
      setReassessing(false);
    }
  };

  if (loading || !thread) {
    // Layout-shaped skeleton so the page doesn't visually jump when the
    // real content arrives. Three columns (threads / conversation / context)
    // matching the live layout's grid below.
    return (
      <div className="flex h-full flex-col gap-3 overflow-hidden">
        <div className="grid min-h-0 flex-1 grid-cols-12 gap-4">
          <Card className="col-span-12 flex min-h-0 flex-col overflow-hidden lg:col-span-3">
            <Skeleton className="mb-3 h-4 w-20" />
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          </Card>
          <Card className="col-span-12 flex min-h-0 flex-col overflow-hidden lg:col-span-6">
            <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-3">
              <Skeleton className="h-6 w-48" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-28" />
                <Skeleton className="h-8 w-28" />
              </div>
            </div>
            <div className="flex-1 space-y-3">
              <Skeleton className="ml-0 h-16 w-3/4" />
              <Skeleton className="ml-auto h-16 w-2/3" />
              <Skeleton className="ml-0 h-12 w-1/2" />
            </div>
          </Card>
          <Card className="col-span-12 flex min-h-0 flex-col space-y-3 overflow-y-auto lg:col-span-3">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-24 w-full" />
          </Card>
        </div>
      </div>
    );
  }

  // Show every thread, not the first 20. The previous slice was a perf
  // hedge but with virtualisation off it just hid threads from the user.
  // A long list is fine — the pane is overflow-y-auto. If we see >500
  // threads in practice we'll add virtualisation; until then keep it simple.
  const threadList = inboxRows;

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden">
      {degradedPlatform ? (
        <DegradedBanner
          platform={degradedPlatform.platform}
          onOpenReceipts={() => setReceiptsOpen(true)}
          onRunSelectorTests={() =>
            runAction(
              apiPost("/runner/control/platform/test-selectors", { platform: degradedPlatform.platform }),
              setError,
              refresh
            )
          }
          domDumpFile={degradedDomDump}
        />
      ) : null}
      {error ? <p className="text-sm text-rose-600">{error}</p> : null}

      <div className="grid min-h-0 flex-1 grid-cols-12 gap-4">
        <Card className="col-span-12 flex min-h-0 flex-col overflow-hidden lg:col-span-3">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Threads</h3>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {threadList.map((row) => {
              // Same indicator semantics as the inbox row:
              //   emerald = operator replied last
              //   rose    = other party awaiting reply
              //   slate   = neither (closed / no recent activity)
              const indicatorColor =
                row.lastMessageDirection === "OUT"
                  ? "bg-emerald-500"
                  : row.needsReply
                    ? "bg-rose-500"
                    : "bg-slate-300";
              const previewBody =
                row.lastMessageDirection === "OUT" ? `You: ${row.preview}` : row.preview;
              return (
                <button
                  key={row.id}
                  className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm ${row.id === thread.id ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                  onClick={() => router.push(`/thread/${row.id}`)}
                >
                  <span
                    className={`mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${indicatorColor}`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-900">{row.personName}</span>
                    <span className="block truncate text-xs text-slate-500">{previewBody}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="col-span-12 flex min-h-0 flex-col overflow-hidden lg:col-span-6">
          <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-xl font-semibold">{thread.personName}</h2>
              <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
                <Badge tone="blue">{thread.platform}</Badge>
                <span>Last seen {formatRelative(thread.messages[thread.messages.length - 1]?.timestamp)}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => runAction(apiPost(`/runner/control/thread/${thread.id}/open`, {}), setError)}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open in platform
              </Button>
              <Button
                variant="secondary"
                onClick={() => runAction(apiPost(`/runner/control/thread/${thread.id}/rescan`, {}), setError, refresh)}
              >
                <RefreshCcw className="mr-2 h-4 w-4" />
                Rescan thread
              </Button>
              <Button variant="ghost" onClick={() => setReceiptsOpen(true)}>
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Receipts
              </Button>
            </div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto pb-4">
            {timeline.map((message) => (
              <div key={message.id}>
                {message.showDivider ? (
                  <div className="my-3 text-center text-xs uppercase tracking-wide text-slate-400">{message.dividerLabel}</div>
                ) : null}
                <div className={`flex ${message.direction === "OUT" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${
                      message.direction === "OUT"
                        ? "border border-blue-200 bg-blue-50 text-blue-900"
                        : "border border-slate-200 bg-slate-50 text-slate-800"
                    }`}
                  >
                    {message.senderName ? (
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">{message.senderName}</p>
                    ) : null}
                    <p>{message.text}</p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                      <span>{formatClock(message.timestamp)}</span>
                      {message.direction === "OUT" ? <span>Sent via automation ✓</span> : null}
                    </div>
                    {message.attachments?.length ? (
                      <div className="mt-2">
                        <Badge tone="amber">Attachment: image (manual review)</Badge>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
            {/* Optimistic-UI bubbles: bubbles that exist client-side only,
                rendered after all persisted messages so they appear at the
                bottom (== "most recent"). They flip to a Failed state with a
                retry button if the runner reported a send failure. */}
            {pendingSends.map((pending) => (
              <div key={`pending-${pending.clientSendId}`}>
                <div className="flex justify-end">
                  <div
                    className={`max-w-[78%] rounded-2xl px-3 py-2 text-sm ${
                      pending.failed
                        ? "border border-rose-200 bg-rose-50 text-rose-900"
                        : "border border-blue-200 bg-blue-50 text-blue-900 opacity-80"
                    }`}
                  >
                    <p>{pending.text}</p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                      <span className="text-slate-500">{formatClock(pending.sentAt)}</span>
                      {pending.failed ? (
                        <span className="flex items-center gap-2 text-rose-600">
                          <span>Failed: {pending.errorMessage ?? "send error"}</span>
                          <button
                            type="button"
                            onClick={() => void retryPendingSend(pending.clientSendId)}
                            className="font-medium underline hover:no-underline"
                          >
                            Retry
                          </button>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-slate-500">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Sending…
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="sticky bottom-0 mt-2 rounded-xl border border-slate-200 bg-white p-3">
            <Textarea
              rows={5}
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Write a reply..."
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => void transform("SHORTEN")}>Shorten</Button>
                <Button variant="ghost" onClick={() => void transform("MAKE_WARMER")}>Make warmer</Button>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
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
                  variant="secondary"
                  onClick={() =>
                    runAction(
                      apiPost(`/runner/control/thread/${thread.id}/snooze`, { hours: 6 }),
                      setError,
                      refresh
                    )
                  }
                >
                  Snooze
                </Button>
                <Button
                  variant="secondary"
                  onClick={() =>
                    runAction(
                      apiPost(`/runner/control/thread/${thread.id}/mark-done`, {}),
                      setError,
                      refresh
                    )
                  }
                >
                  Mark done
                </Button>
                <Button variant="primary" onClick={() => void onSend()} disabled={sending || !composer.trim()}>
                  {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Send
                </Button>
              </div>
            </div>
          </div>
        </Card>

        <Card className="col-span-12 flex min-h-0 flex-col space-y-3 overflow-y-auto lg:col-span-3">
          {/* Header: risk badge + reassess button. Replaces a separate
              Risk card at the bottom + a missing reassess affordance.
              One row at the top of the right pane is enough. */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge tone={riskTone(thread.riskLevel)}>{thread.riskLevel}</Badge>
              {thread.riskReason ? (
                <span className="text-xs text-slate-500">{thread.riskReason}</span>
              ) : null}
            </div>
            <Button
              variant="ghost"
              disabled={reassessing}
              onClick={() => void reassessThread()}
              title="Re-summarise, reclassify, and regenerate suggested replies for this thread"
            >
              {reassessing ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  Reassessing…
                </>
              ) : (
                <>
                  <RotateCcw className="mr-1 h-4 w-4" />
                  Reassess
                </>
              )}
            </Button>
          </div>

          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Summary</h3>
            <p className="mt-2 text-sm text-slate-700">{thread.summary || "No summary yet."}</p>
          </Card>

          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">What they want</h3>
            <p className="mt-2 text-sm text-slate-700">{thread.whatTheyWant || "No clear ask yet."}</p>
          </Card>

          {/* Open loops only when there are any — empty card was just
              noise on threads where no loops were detected. */}
          {thread.openLoops.length ? (
            <Card className="bg-slate-50">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Open loops</h3>
              <div className="mt-2 space-y-2">
                {thread.openLoops.map((item) => (
                  <label key={item} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" className="rounded" />
                    {item}
                  </label>
                ))}
              </div>
            </Card>
          ) : null}

          {/* Compose helper — replaces the unused Notes + tags card.
              Type a brief intent ("ask about availability next week"),
              click Write in my voice, and the AI rewrites it calibrated
              to past outbound messages on this thread. Use this drops
              the result into the composer. */}
          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Compose in my voice</h3>
            <p className="mt-1 text-xs text-slate-500">
              Type what you want to say briefly. The AI rewrites it the way you'd write it on this thread.
            </p>
            <Textarea
              className="mt-2"
              rows={3}
              value={composeIntent}
              onChange={(event) => setComposeIntent(event.target.value)}
              placeholder="e.g. ask if free for a quick coffee next week"
            />
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="secondary"
                disabled={composing || !composeIntent.trim()}
                onClick={() => void composeIntentToVoice()}
              >
                {composing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Writing…
                  </>
                ) : (
                  "Write in my voice"
                )}
              </Button>
              {composeError ? (
                <span className="text-xs text-rose-600">{composeError}</span>
              ) : null}
            </div>
            {composeDraft ? (
              <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2">
                <p className="text-sm text-slate-700">{composeDraft}</p>
                <div className="mt-2 flex gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setComposer(composeDraft);
                      setComposeDraft("");
                      setComposeIntent("");
                    }}
                  >
                    Use this
                  </Button>
                  <Button variant="ghost" onClick={() => void composeIntentToVoice()}>
                    Try again
                  </Button>
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Suggested replies</h3>
            <div className="mt-2 space-y-2">
              {thread.suggestedReplies.replies.map((reply) => (
                <div key={reply.label} className="rounded-lg border border-slate-200 bg-white p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <Badge tone="blue">{reply.label}</Badge>
                    <span className="text-xs text-slate-500">{reply.intent}</span>
                  </div>
                  <p className="text-sm text-slate-700">{reply.text}</p>
                  <div className="mt-2">
                    <Button variant="ghost" onClick={() => setComposer(reply.text)}>
                      Use this
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {thread.suggestedReplies.needs_user_input.length ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-warningSoft p-2 text-sm text-amber-900">
                <p className="font-medium">Before replying, we need:</p>
                <ul className="mt-1 list-disc pl-4">
                  {thread.suggestedReplies.needs_user_input.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          <p className="text-xs text-slate-500">Context last updated {formatRelative(thread.contextUpdatedAt)}</p>
        </Card>
      </div>

      <ReceiptsDrawer open={receiptsOpen} onClose={() => setReceiptsOpen(false)} rows={thread.receipts} title="Thread receipts" />
    </div>
  );
}
