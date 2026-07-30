import { prisma } from "../db";
import type { EventBus } from "../types/runtime";
import type { SendService } from "./send";

interface SendQueueDeps {
  sendService: SendService;
  eventBus: EventBus;
}

/**
 * Drains pending SendRequest rows serially in createdAt order. The /send
 * endpoint inserts a PENDING row and calls `kick()`; the worker loop
 * (`tick`) processes rows one at a time through the existing
 * sendService.processSendRequest, then loops to the next pending row.
 *
 * Architecture note: this MUST run async from the API request — the
 * adapter call can take 30s+ when an auto-login is needed first, and
 * Next.js's rewrite proxy times out at 30s. With the queue, the dashboard
 * gets a sub-100ms response (just inserting the row), and watches
 * MESSAGE_SENT / MESSAGE_SEND_FAILED events to update the optimistic UI.
 *
 * Persistence: the queue lives in the SendRequest table. Closing the
 * dashboard tab does not lose pending sends — the row is in the DB and
 * will be picked up on the next `kick()` (or by `resume()` on runner
 * startup).
 *
 * Concurrency: a single in-process `running` guard prevents two worker
 * loops from starting simultaneously. Multiple `kick()` calls during an
 * active loop are no-ops; the loop checks `findFirst` again on each
 * iteration so newly-enqueued rows are picked up without an explicit
 * second kick.
 */
export interface SendQueueService {
  enqueueAndKick(input: {
    threadId: string;
    text: string;
    clientSendId: string;
    source?: "manual" | "focus_auto_ack";
    attachments?: Array<{ absolutePath: string; displayName: string; mimeType?: string; kind?: string }>;
    /**
     * App-level threading. Forwarded to sendService.enqueueSend → persisted
     * on the SendRequest, then copied onto the resulting Message row so the
     * dashboard renders the new bubble inline under its parent.
     */
    replyToMessageId?: string;
  }): Promise<{
    clientSendId: string;
    status: "PENDING" | "SENT" | "FAILED";
    replayed: boolean;
    queuePosition: number;
    activeCount: number;
    errorMessage?: string;
  }>;
  kick(): void;
  /** Drain any PENDING rows left over from a previous runner process. */
  resume(): void;
  getActiveCount(): Promise<number>;
}

export function createSendQueue(deps: SendQueueDeps): SendQueueService {
  let running = false;

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (true) {
        const next = await prisma.sendRequest.findFirst({
          // `receiptJson: null` excludes in-doubt rows — a PENDING row that a
          // previous (crashed) process already claimed carries the claim marker
          // in receiptJson. Those must not be re-dispatched (the adapter send is
          // not idempotent); resume() reconciles them to FAILED separately.
          where: { status: "PENDING", receiptJson: null },
          orderBy: { createdAt: "asc" }
        });
        if (!next) break;
        try {
          await deps.sendService.processSendRequest(next.id);
        } catch (error) {
          // processSendRequest is supposed to record FAILED status on the row
          // before throwing only for programmer-error cases (missing thread,
          // etc.). Defensively mark the row failed here so the worker doesn't
          // get stuck looping on the same PENDING row forever.
          console.warn(
            `[send-queue] processSendRequest crashed for ${next.id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          await prisma.sendRequest
            .update({
              where: { id: next.id },
              data: {
                status: "FAILED",
                errorJson: JSON.stringify({
                  message: error instanceof Error ? error.message : String(error)
                })
              }
            })
            .catch(() => undefined);
        }

        // Emit a queue-state update after each row so the dashboard's status
        // bar can update without waiting for its 3-second poll tick.
        const remaining = await prisma.sendRequest.count({ where: { status: "PENDING" } });
        deps.eventBus.emit({
          type: "SEND_QUEUE_UPDATED",
          jobId: "send-queue",
          activeCount: remaining
        });
      }
    } finally {
      running = false;
    }
  }

  function kick(): void {
    // Fire-and-forget. If the loop is already running, this is a no-op
    // (the running flag inside tick() returns immediately). If not, the
    // loop starts and drains pending rows until the table is empty.
    void tick();
  }

  function resume(): void {
    // First reconcile any in-doubt rows: a PENDING row claimed by the previous
    // process but never terminalised (it crashed between the physical send and
    // the SENT write). Re-dispatching those would re-message the recipient, so
    // they are flipped to FAILED (INTERRUPTED) for the operator to verify. THEN
    // drain the genuinely-unclaimed PENDING rows. Reconcile is fire-and-forget
    // before the kick — the drain's findFirst already filters claimed rows out,
    // so ordering between the two is not load-bearing for safety.
    void deps.sendService
      .reconcileInterruptedSends()
      .then((reconciled) => {
        if (reconciled > 0) {
          console.warn(
            `[send-queue] reconciled ${reconciled} interrupted send(s) to FAILED after restart`
          );
        }
      })
      .catch((error) => {
        console.warn(
          `[send-queue] reconcileInterruptedSends failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    // Same as kick — the loop will find any leftover (unclaimed) PENDING rows
    // from before the last process exited. Separate name for clarity at the
    // call site (createPlatformFactory at runner boot).
    kick();
  }

  async function enqueueAndKick(input: {
    threadId: string;
    text: string;
    clientSendId: string;
    source?: "manual" | "focus_auto_ack";
    // attachments must mirror the public interface above so iMessage
    // voice notes / photos survive the type contract — without this the
    // field is silently dropped by any future refactor that relies on
    // the inferred parameter type.
    attachments?: Array<{ absolutePath: string; displayName: string; mimeType?: string; kind?: string }>;
    /**
     * App-level threading. Forwarded to sendService.enqueueSend → persisted
     * on the SendRequest, then copied onto the resulting Message row so the
     * dashboard renders the new bubble inline under its parent.
     */
    replyToMessageId?: string;
  }): Promise<{
    clientSendId: string;
    status: "PENDING" | "SENT" | "FAILED";
    replayed: boolean;
    queuePosition: number;
    activeCount: number;
    errorMessage?: string;
  }> {
    const result = await deps.sendService.enqueueSend(input);
    const activeRows = await prisma.sendRequest.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: { id: true, clientSendId: true }
    });
    const queuePosition = activeRows.findIndex((row) => row.clientSendId === input.clientSendId);
    deps.eventBus.emit({
      type: "SEND_QUEUE_UPDATED",
      jobId: "send-queue",
      activeCount: activeRows.length
    });
    if (result.status === "PENDING") {
      kick();
    }
    return {
      clientSendId: result.clientSendId,
      status: result.status,
      replayed: result.replayed,
      // -1 if the row is already SENT/FAILED; the dashboard treats that as
      // "no longer in queue" and shows the recent-completed banner.
      queuePosition,
      activeCount: activeRows.length,
      errorMessage: result.errorMessage
    };
  }

  async function getActiveCount(): Promise<number> {
    return prisma.sendRequest.count({ where: { status: "PENDING" } });
  }

  return { enqueueAndKick, kick, resume, getActiveCount };
}
