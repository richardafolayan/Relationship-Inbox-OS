import type { PlatformName } from "@inbox-os/core";
import { prisma } from "../db";
import type { KeyedMutex } from "./keyed-mutex";
import type { SessionManager } from "./session-manager";
import { extractProfile, type ExtractedProfile, type ProfileExtractionResult } from "../platforms/linkedin-profile-adapter";

/**
 * Trigger source for an enqueue request. Diagnostic only — the picker
 * orders by createdAt regardless. Logged so the operator can tell at a
 * glance whether the queue is being driven by scans, manual refreshes,
 * or the periodic background tick.
 */
export type EnrichmentTrigger = "first_seen" | "manual" | "periodic";

interface EnrichmentQueueDeps {
  sessionManager: SessionManager;
  /**
   * The shared operation mutex used by scan/send. The worker tries
   * (non-blocking) to acquire scan/send keys before a profile visit and
   * defers the job if either is currently held — this avoids
   * contention with the live messaging session.
   */
  operationMutex: KeyedMutex;
  /** Person key to scope the browser session — defaults to "default". */
  personKey?: string;
  /** Min ms between profile visits. Default 30s, env override at config layer. */
  paceMs: number;
  /** Max jobs processed in a single drain pass (defensive). Default 30. */
  batchMax: number;
  /** Stale threshold in days for periodic refresh (default 30). */
  refreshDays: number;
  /**
   * Callback to compute the lock keys this person uses for scan / send.
   * Mirrors the runner's `platformLockKey(platform)` so both modules
   * agree on what to acquire / yield to.
   */
  scanLockKey: (platform: PlatformName) => string;
  sendLockKey: (platform: PlatformName) => string;
  /** Lock key used by the worker itself to serialise drain passes. */
  enrichLockKey: string;
}

export interface EnrichmentQueueService {
  enqueue(personId: string, trigger: EnrichmentTrigger): Promise<void>;
  /**
   * Run a single enrichment for a specific person, awaiting the result.
   * Used by the manual refresh endpoint for a synchronous reply when
   * the queue is otherwise idle. Falls back to enqueueing + returning
   * `{ deferred: true }` if scan/send are holding the lock.
   */
  runOnce(personId: string): Promise<{ ok: true; profile: ExtractedProfile } | { deferred: true } | { failed: true; reason: string }>;
  start(): void;
  stop(): void;
  /** Force the picker to wake up (e.g. after enqueueing). */
  kick(): void;
}

export function createEnrichmentQueue(deps: EnrichmentQueueDeps): EnrichmentQueueService {
  const personKey = deps.personKey ?? "default";
  let running = false;
  let stopped = false;
  let pendingKick: NodeJS.Timeout | null = null;
  let periodicTimer: NodeJS.Timeout | null = null;
  let lastVisitAt = 0;

  async function recoverInflightOnStart(): Promise<void> {
    const recovered = await prisma.enrichmentJob.updateMany({
      where: { status: "RUNNING" },
      data: { status: "PENDING", lastError: "runner restarted while RUNNING" }
    });
    if (recovered.count > 0) {
      console.warn(`[enrichment-queue] recovered ${recovered.count} RUNNING jobs to PENDING after restart`);
    }
  }

  async function enqueue(personId: string, trigger: EnrichmentTrigger): Promise<void> {
    // Coalesce: if a PENDING job already exists for this person, don't
    // pile another one on. The picker will pick it up regardless of
    // trigger. Manual refreshes always create a fresh row so the user
    // sees an attempts counter when retrying.
    if (trigger !== "manual") {
      const existing = await prisma.enrichmentJob.findFirst({
        where: { personId, status: { in: ["PENDING", "RUNNING"] } }
      });
      if (existing) return;
    }
    await prisma.enrichmentJob.create({
      data: { personId, trigger, status: "PENDING" }
    });
    kick();
  }

  function kick(): void {
    if (stopped) return;
    if (pendingKick) return;
    pendingKick = setTimeout(() => {
      pendingKick = null;
      void drainPass().catch((error) => {
        console.warn(`[enrichment-queue] drainPass crashed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 0);
  }

  async function pickNextJob(): Promise<{ id: string; personId: string; attempts: number } | null> {
    const now = new Date();
    const job = await prisma.enrichmentJob.findFirst({
      where: {
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }]
      },
      orderBy: { createdAt: "asc" }
    });
    if (!job) return null;
    return { id: job.id, personId: job.personId, attempts: job.attempts };
  }

  async function visitProfile(personId: string): Promise<ProfileExtractionResult> {
    const platform: PlatformName = "LINKEDIN";
    const person = await prisma.person.findUnique({ where: { id: personId } });
    if (!person) {
      return { failed: true, reason: "not_found", detail: "person row missing" };
    }
    if (!person.profileUrl) {
      return { failed: true, reason: "not_found", detail: "person has no profileUrl" };
    }
    const page = await deps.sessionManager.getManagedPage({ platform, personKey });
    return extractProfile(page, person.profileUrl);
  }

  async function persistSuccess(personId: string, profile: ExtractedProfile): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.personEnrichment.upsert({
        where: { personId },
        update: {
          headline: profile.headline,
          about: profile.about,
          location: profile.location,
          currentCompany: profile.currentCompany,
          currentRole: profile.currentRole,
          mutualCount: profile.mutualCount,
          experienceJson: JSON.stringify(profile.experience ?? []),
          educationJson: JSON.stringify(profile.education ?? []),
          skillsJson: JSON.stringify(profile.skills ?? []),
          servicesJson: JSON.stringify(profile.services ?? []),
          recentPostsJson: JSON.stringify(profile.recentPosts ?? []),
          mutualNamesJson: JSON.stringify(profile.mutualNames ?? [])
        },
        create: {
          personId,
          headline: profile.headline,
          about: profile.about,
          location: profile.location,
          currentCompany: profile.currentCompany,
          currentRole: profile.currentRole,
          mutualCount: profile.mutualCount,
          experienceJson: JSON.stringify(profile.experience ?? []),
          educationJson: JSON.stringify(profile.education ?? []),
          skillsJson: JSON.stringify(profile.skills ?? []),
          servicesJson: JSON.stringify(profile.services ?? []),
          recentPostsJson: JSON.stringify(profile.recentPosts ?? []),
          mutualNamesJson: JSON.stringify(profile.mutualNames ?? [])
        }
      });
      await tx.person.update({
        where: { id: personId },
        data: { enrichedAt: new Date(), enrichmentFailedReason: null }
      });
    });
  }

  async function persistFailure(personId: string, reason: string): Promise<void> {
    await prisma.person.update({
      where: { id: personId },
      data: { enrichmentFailedReason: reason }
    });
  }

  function exponentialDelayMs(attempts: number): number {
    // 1h, 6h, 24h. attempts is the attempt count BEFORE the failed run,
    // so the first failure passes attempts=0 and waits 1h.
    if (attempts <= 0) return 60 * 60 * 1000;
    if (attempts === 1) return 6 * 60 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
  }

  async function processJob(job: { id: string; personId: string; attempts: number }): Promise<{ visited: boolean }> {
    const platform: PlatformName = "LINKEDIN";
    const scanLock = deps.scanLockKey(platform);
    const sendLock = deps.sendLockKey(platform);

    // Defer if scan or send is currently holding the session — avoids
    // queueing behind a long-running scan, which would skew our pacing.
    if (deps.operationMutex.isRunning(scanLock) || deps.operationMutex.isRunning(sendLock)) {
      await prisma.enrichmentJob.update({
        where: { id: job.id },
        data: { status: "PENDING", nextAttemptAt: new Date(Date.now() + 60_000), lastError: "deferred: scan/send active" }
      });
      return { visited: false };
    }

    // Pacing — wait until the configured min gap has elapsed since the
    // last visit before kicking off the next one.
    const elapsed = Date.now() - lastVisitAt;
    if (lastVisitAt > 0 && elapsed < deps.paceMs) {
      await new Promise((resolve) => setTimeout(resolve, deps.paceMs - elapsed));
    }

    await prisma.enrichmentJob.update({
      where: { id: job.id },
      data: { status: "RUNNING", attempts: job.attempts + 1 }
    });

    let result: ProfileExtractionResult;
    try {
      // Acquire the enrich lock so two drains don't fight; non-blocking
      // tryAcquire on scan/send already ran above. The enrich lock is
      // local to this worker — if it's somehow held, just defer.
      const acquired = await deps.operationMutex.tryAcquire(deps.enrichLockKey, () => visitProfile(job.personId));
      if (!acquired.acquired) {
        await prisma.enrichmentJob.update({
          where: { id: job.id },
          data: { status: "PENDING", nextAttemptAt: new Date(Date.now() + 30_000), lastError: "deferred: enrich lock busy" }
        });
        return { visited: false };
      }
      result = acquired.value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result = { failed: true, reason: "unknown", detail };
    }
    lastVisitAt = Date.now();

    if ("failed" in result && result.failed) {
      await persistFailure(job.personId, result.reason);
      const attempts = job.attempts + 1;
      const giveUp = attempts >= 3;
      await prisma.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: giveUp ? "FAILED" : "PENDING",
          lastError: `${result.reason}${result.detail ? `: ${result.detail}` : ""}`,
          nextAttemptAt: giveUp ? null : new Date(Date.now() + exponentialDelayMs(attempts))
        }
      });
      console.warn(
        `[enrichment-queue] job=${job.id} person=${job.personId} failed reason=${result.reason} attempts=${attempts} giveUp=${giveUp}`
      );
      return { visited: true };
    }

    await persistSuccess(job.personId, result as ExtractedProfile);
    await prisma.enrichmentJob.update({
      where: { id: job.id },
      data: { status: "DONE", lastError: null }
    });
    return { visited: true };
  }

  async function drainPass(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      let processed = 0;
      while (processed < deps.batchMax && !stopped) {
        const job = await pickNextJob();
        if (!job) break;
        const outcome = await processJob(job);
        if (outcome.visited) processed += 1;
        // If we deferred (scan/send active or pace not yet ready), bail
        // out of this pass to give the system a moment. We'll wake on
        // the next kick or the periodic tick.
        if (!outcome.visited) break;
      }
    } finally {
      running = false;
    }
  }

  async function runOnce(
    personId: string
  ): Promise<{ ok: true; profile: ExtractedProfile } | { deferred: true } | { failed: true; reason: string }> {
    const platform: PlatformName = "LINKEDIN";
    if (
      deps.operationMutex.isRunning(deps.scanLockKey(platform)) ||
      deps.operationMutex.isRunning(deps.sendLockKey(platform))
    ) {
      return { deferred: true };
    }
    const result = await visitProfile(personId);
    if ("failed" in result && result.failed) {
      await persistFailure(personId, result.reason);
      return { failed: true, reason: result.reason };
    }
    await persistSuccess(personId, result as ExtractedProfile);
    lastVisitAt = Date.now();
    return { ok: true, profile: result as ExtractedProfile };
  }

  async function periodicTick(): Promise<void> {
    if (stopped) return;
    const cutoff = new Date(Date.now() - deps.refreshDays * 24 * 60 * 60 * 1000);
    // Re-enrich active contacts whose enrichment is older than the
    // refresh window. "Active" = had a thread message in the last
    // refresh window. Limit to 20 per tick to avoid bursts.
    const candidates = await prisma.person.findMany({
      where: {
        OR: [{ enrichedAt: null }, { enrichedAt: { lt: cutoff } }],
        threads: {
          some: { lastMessageAt: { gt: cutoff } }
        }
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true }
    });
    for (const p of candidates) {
      await enqueue(p.id, "periodic");
    }
  }

  function start(): void {
    stopped = false;
    void recoverInflightOnStart()
      .then(() => kick())
      .catch((error) => {
        console.warn(
          `[enrichment-queue] recover failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    if (!periodicTimer) {
      periodicTimer = setInterval(() => {
        void periodicTick().catch((error) => {
          console.warn(
            `[enrichment-queue] periodicTick crashed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      }, 60 * 60 * 1000);
    }
  }

  function stop(): void {
    stopped = true;
    if (pendingKick) {
      clearTimeout(pendingKick);
      pendingKick = null;
    }
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  return { enqueue, runOnce, start, stop, kick };
}
