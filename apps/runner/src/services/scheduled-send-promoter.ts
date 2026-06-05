import { prisma as defaultPrisma } from "../db";
import type { EventBus } from "../types/runtime";
import type { SendQueueService } from "./send-queue";

/**
 * Subset of the Prisma client surface the promoter actually uses, narrowed
 * so tests can swap in an in-memory fake without pulling in @prisma/client.
 */
export interface ScheduledSendPromoterPrisma {
  sendRequest: {
    findMany(args: {
      where: { status: "SCHEDULED"; scheduledFor: { lte: Date } };
      orderBy: { scheduledFor: "asc" };
      select: { id: true; clientSendId: true };
    }): Promise<Array<{ id: string; clientSendId: string }>>;
    updateMany(args: {
      where: { id: { in: string[] }; status: "SCHEDULED"; scheduledFor: { lte: Date } };
      data: { status: "PENDING" };
    }): Promise<{ count: number }>;
    count(args: { where: { status: "PENDING" } }): Promise<number>;
  };
}

interface ScheduledSendPromoterDeps {
  sendQueue: SendQueueService;
  eventBus: EventBus;
  /** Polling cadence in ms. Defaults to 30s; tests override to make ticks observable. */
  intervalMs?: number;
  /** Override the prisma client. Defaults to the runner's singleton; tests inject a fake. */
  prisma?: ScheduledSendPromoterPrisma;
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
  const prisma: ScheduledSendPromoterPrisma = deps.prisma ?? defaultPrisma;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick(): Promise<{ promoted: number }> {
    if (running) return { promoted: 0 };
    running = true;
    try {
      const now = new Date();
      const due = await prisma.sendRequest.findMany({
        where: {
          status: "SCHEDULED",
          scheduledFor: { lte: now }
        },
        orderBy: { scheduledFor: "asc" },
        select: { id: true, clientSendId: true }
      });
      if (due.length === 0) return { promoted: 0 };

      // Status- AND time-guarded promotion. Between the findMany above and this
      // write, the operator may have cancelled a row (SCHEDULED -> CANCELLED)
      // or rescheduled it to the future. Re-checking `status` and `scheduledFor`
      // in the WHERE means we never resurrect a cancelled row or fire a
      // rescheduled one at its old time — without this guard, the id-only
      // updateMany would flip a just-cancelled row back to PENDING. `count` is
      // the number actually promoted, which can be fewer than `due.length`.
      const ids = due.map((r) => r.id);
      const { count: promoted } = await prisma.sendRequest.updateMany({
        where: { id: { in: ids }, status: "SCHEDULED", scheduledFor: { lte: now } },
        data: { status: "PENDING" }
      });
      if (promoted === 0) return { promoted: 0 };

      // Tell the dashboard right away that the queue moved — the SystemStatusBar
      // shouldn't have to wait for its 3-second poll to notice the promotion.
      const remaining = await prisma.sendRequest.count({ where: { status: "PENDING" } });
      deps.eventBus.emit({
        type: "SEND_QUEUE_UPDATED",
        jobId: "scheduled-send-promoter",
        activeCount: remaining
      });

      // Kick AFTER the event emit so a downstream emit failure doesn't
      // skip the kick. Wrap in its own try/catch so kick failures don't
      // mask the real promotion result.
      try {
        deps.sendQueue.kick();
      } catch (error) {
        console.warn(
          `[scheduled-send-promoter] sendQueue.kick() failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      return { promoted };
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
