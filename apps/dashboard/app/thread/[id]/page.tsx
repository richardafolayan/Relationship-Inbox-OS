"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { v4 as uuid } from "uuid";
import { ExternalLink, RefreshCcw, CheckCircle2, Loader2 } from "lucide-react";
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

  if (loading || !thread) {
    // Layout-shaped skeleton so the page doesn't visually jump when the
    // real content arrives. Three columns (threads / conversation / context)
    // matching the live layout's grid below.
    return (
      <div className="flex h-[calc(100vh-3rem)] flex-col gap-3 overflow-hidden">
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

  const threadList = inboxRows.slice(0, 20);

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col gap-3 overflow-hidden">
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
            {threadList.map((row) => (
              <button
                key={row.id}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${row.id === thread.id ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                onClick={() => router.push(`/thread/${row.id}`)}
              >
                <p className="font-medium text-slate-900">{row.personName}</p>
                <p className="truncate text-xs text-slate-500">{row.preview}</p>
              </button>
            ))}
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
          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Summary</h3>
            <p className="mt-2 text-sm text-slate-700">{thread.summary || "No summary yet."}</p>
          </Card>

          <Card className="bg-slate-50">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">What they want</h3>
              <Badge tone="blue">Confidence: Med</Badge>
            </div>
            <p className="mt-2 text-sm text-slate-700">{thread.whatTheyWant || "No clear ask yet."}</p>
          </Card>

          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Open loops</h3>
            <div className="mt-2 space-y-2">
              {thread.openLoops.length ? (
                thread.openLoops.map((item) => (
                  <label key={item} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" className="rounded" />
                    {item}
                  </label>
                ))
              ) : (
                <p className="text-sm text-slate-500">No open loops detected.</p>
              )}
            </div>
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

          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Notes + tags</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {["Warm lead", "Partner", "Client", "Friend"].map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
            <Textarea className="mt-2" rows={4} placeholder="Internal notes..." />
            <p className="mt-2 text-xs text-slate-500">Context last updated {formatRelative(thread.contextUpdatedAt)}</p>
          </Card>

          <Card>
            <div className="flex items-center justify-between">
              <Badge tone={riskTone(thread.riskLevel)}>{thread.riskLevel}</Badge>
              <p className="text-xs text-slate-500">{thread.riskReason}</p>
            </div>
          </Card>
        </Card>
      </div>

      <ReceiptsDrawer open={receiptsOpen} onClose={() => setReceiptsOpen(false)} rows={thread.receipts} title="Thread receipts" />
    </div>
  );
}
