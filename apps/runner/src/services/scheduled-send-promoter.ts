import { prisma } from "../db";
import type { EventBus } from "../types/runtime";
import type { SendQueueService } from "./send-queue";

interface ScheduledSendPromoterDeps {
  sendQueue: SendQueueService;
  eventBus: EventBus;
  /** Polling cadence in ms. Defaults to 30s; tests override to make ticks observable. */
  intervalMs?: number;
}

/**
 * Promotes SCHEDULED SendRequest rows to PENDING when their `scheduledFor`
 * timestamp has elapsed, then kicks the send-queue worker so the regular
 * drain path picks them up. Runs as a single-instance interval timer at
 * runner boot — there is no per-row timer, so a 30s lag between the
 * scheduled time and the actual send is acceptable (matches user
 * expectations for "schedule send" semantics in mail clients).
 *
 * Survives runner restarts: any SCHEDULED rows whose time has passed
 * during a restart are immediately promoted on the first tick after
 * `start()`.
 */
export interface ScheduledSendPromoter {
  start(): void;
  stop(): void;
  /** Run one tick synchronously; exposed for tests + admin endpoints. */
  tick(): Promise<{ promoted: number }>;
}

export function createScheduledSendPromoter(deps: ScheduledSendPromoterDeps): ScheduledSendPromoter {
  const intervalMs = deps.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<{ promoted: number }> {
    if (running) return { promoted: 0 };
    running = true;
    try {
      const due = await prisma.sendRequest.findMany({
        where: {
          status: "SCHEDULED",
          scheduledFor: { lte: new Date() }
        },
        orderBy: { scheduledFor: "asc" },
        select: { id: true, clientSendId: true }
      });
      if (due.length === 0) return { promoted: 0 };

      const ids = due.map((r) => r.id);
      await prisma.sendRequest.updateMany({
        where: { id: { in: ids } },
        data: { status: "PENDING" }
      });

      // Tell the dashboard right away that the queue moved — the SystemStatusBar
      // shouldn't have to wait for its 3-second poll to notice the promotion.
      const remaining = await prisma.sendRequest.count({ where: { status: "PENDING" } });
      deps.eventBus.emit({
        type: "SEND_QUEUE_UPDATED",
        jobId: "scheduled-send-promoter",
        activeCount: remaining
      });

      deps.sendQueue.kick();

      return { promoted: due.length };
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    // Run once immediately on start so a runner restart drains anything
    // that came due while it was down, then settle into the interval.
    void tick().catch((error) => {
      console.warn(
        `[scheduled-send-promoter] initial tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    timer = setInterval(() => {
      void tick().catch((error) => {
        console.warn(
          `[scheduled-send-promoter] tick failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}
