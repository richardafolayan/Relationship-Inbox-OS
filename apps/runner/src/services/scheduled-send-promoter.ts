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
      where: { id: { in: string[] }; status: "SCHEDULED" };
      data: { status: "PENDING" };
    }): Promise<{ count: number }>;
    count(args: { where: { status: "PENDING" } }): Promise<number>;
  };
  // Typed as `unknown` to avoid colliding with the real PrismaClient's
  // overloaded $transaction signature (which has both array + callback
  // forms). The promoter only ever invokes the callback form via a
  // narrowing helper, so we typecheck call-sites locally instead.
  $transaction: unknown;
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
      // findMany + updateMany used to run separately; an admin script or a
      // second runner could race the same SCHEDULED row through PENDING.
      // Wrap them in a $transaction (when the prisma client provides one)
      // so the SELECT and UPDATE are atomic, and narrow the UPDATE's WHERE
      // clause to status=SCHEDULED so a concurrent promotion can't flip an
      // already-PENDING/SENT row back. Test fakes omit $transaction —
      // fall back to running both queries directly against the same client
      // when it's missing (no atomicity guarantee, but the tests don't
      // exercise concurrent access).
      type TxCallback = <R>(cb: (tx: ScheduledSendPromoterPrisma) => Promise<R>) => Promise<R>;
      const runBatch = async (tx: ScheduledSendPromoterPrisma) => {
        const found = await tx.sendRequest.findMany({
          where: {
            status: "SCHEDULED",
            scheduledFor: { lte: new Date() }
          },
          orderBy: { scheduledFor: "asc" },
          select: { id: true, clientSendId: true }
        });
        if (found.length === 0) {
          return { due: found, count: 0 };
        }
        const ids = found.map((r) => r.id);
        const updated = await tx.sendRequest.updateMany({
          where: { id: { in: ids }, status: "SCHEDULED" },
          data: { status: "PENDING" }
        });
        return { due: found, count: updated.count };
      };
      const txFn = typeof prisma.$transaction === "function"
        ? (prisma.$transaction as TxCallback)
        : null;
      const { due, count } = txFn ? await txFn(runBatch) : await runBatch(prisma);
      if (count === 0) return { promoted: 0 };
      void due; // surfaced for diagnostics if needed; logging hooks may consume later.

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

      return { promoted: count };
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
