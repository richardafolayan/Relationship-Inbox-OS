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
  /**
   * Inter-visit pacing, randomised uniformly in [paceMinMs, paceMaxMs].
   * Random jitter avoids the regular-cadence pattern that LinkedIn flags
   * as automated activity (see 2026-05-08 incident in README).
   */
  paceMinMs: number;
  paceMaxMs: number;
  /** Max jobs processed in a single drain pass (defensive). Default 6. */
  batchMax: number;
  /**
   * Soft cap on profile visits per rolling 24h window. Tracked in
   * memory; resets on runner restart. When the cap is reached the
   * worker defers all further jobs by 1h.
   */
  dailyCap: number;
  /**
   * Every N visits, take an extended idle pause uniformly in
   * [longIdleMinMs, longIdleMaxMs] before the next visit. Breaks up
   * sustained activity into shorter sessions.
   */
  longIdleEvery: number;
  longIdleMinMs: number;
  longIdleMaxMs: number;
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
  /**
   * Optional adapter hook to verify the platform session before each visit.
   * The LinkedIn adapter's ensureConnected runs throwIfAuthRequired, which
   * triggers the password auto-login fallback when the persistent session
   * has expired. Without this, a logged-out runner would just see every
   * extractProfile call return auth_required and never recover the session.
   */
  ensureConnected?: () => Promise<void>;
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

/**
 * Retry backoff tiers: 1h, 6h, 24h. `attempts` is the attempt count
 * BEFORE the failed run, so the first failure passes `attempts=0` and
 * waits 1h. Exported (and module-level) so the tier mapping is unit-
 * testable without standing up the queue.
 */
export function exponentialDelayMs(attempts: number): number {
  if (attempts <= 0) return 60 * 60 * 1000;
  if (attempts === 1) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

export function createEnrichmentQueue(deps: EnrichmentQueueDeps): EnrichmentQueueService {
  const personKey = deps.personKey ?? "default";
  let running = false;
  let stopped = false;
  let pendingKick: NodeJS.Timeout | null = null;
  let periodicTimer: NodeJS.Timeout | null = null;
  let lastVisitAt = 0;
  // In-memory ring of visit timestamps used to enforce the daily cap.
  // Pruned of entries older than 24h on every read. Resets on restart —
  // the LinkedIn-side rate limit is the authoritative one; this is a
  // belt-and-suspenders safeguard against the queue running unattended.
  const recentVisits: number[] = [];
  // Counter feeding the long-idle pause cadence. Increments on every
  // completed visit (success or failure that hit the network).
  let visitsSinceLongIdle = 0;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function randomInRange(min: number, max: number): number {
    if (max <= min) return min;
    return Math.floor(min + Math.random() * (max - min));
  }

  function pruneOldVisits(): void {
    const cutoff = Date.now() - DAY_MS;
    while (recentVisits.length > 0 && recentVisits[0]! < cutoff) {
      recentVisits.shift();
    }
  }

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
    if (deps.ensureConnected) {
      try {
        await deps.ensureConnected();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { failed: true, reason: "auth_required", detail };
      }
    }
    return extractProfile(page, person.profileUrl);
  }

  async function persistSuccess(personId: string, profile: ExtractedProfile): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const fields = {
        headline: profile.headline,
        about: profile.about,
        location: profile.location,
        currentCompany: profile.currentCompany,
        currentRole: profile.currentRole,
        mutualCount: profile.mutualCount,
        followersCount: profile.followersCount,
        experienceJson: JSON.stringify(profile.experience ?? []),
        educationJson: JSON.stringify(profile.education ?? []),
        skillsJson: JSON.stringify(profile.skills ?? []),
        servicesJson: JSON.stringify(profile.services ?? []),
        licensesJson: JSON.stringify(profile.licenses ?? []),
        recentPostsJson: JSON.stringify(profile.recentPosts ?? []),
        recentCommentsJson: JSON.stringify(profile.recentComments ?? []),
        recentReactionsJson: JSON.stringify(profile.recentReactions ?? []),
        mutualNamesJson: JSON.stringify(profile.mutualNames ?? [])
      };
      await tx.personEnrichment.upsert({
        where: { personId },
        update: fields,
        create: { personId, ...fields }
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

  // Reasons that won't resolve by retrying: the person row is missing /
  // has no profileUrl, LinkedIn returned a not-found page, or the profile
  // is private. Without this, jobs against profile-less people sit in
  // PENDING with nextAttemptAt in the past and keep the "Enriching N
  // profiles" banner glued on between attempts.
  function isPermanentFailure(reason: string): boolean {
    return reason === "not_found" || reason === "private";
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

    // Daily cap — defer all further work for an hour once the rolling
    // 24h visit count hits the cap. The next attempt will recheck and
    // either proceed (entries have aged out) or defer again.
    pruneOldVisits();
    if (recentVisits.length >= deps.dailyCap) {
      await prisma.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000),
          lastError: `deferred: daily cap reached (${deps.dailyCap}/24h)`
        }
      });
      console.warn(
        `[enrichment-queue] daily cap reached (${recentVisits.length}/${deps.dailyCap}) — deferring 1h`
      );
      return { visited: false };
    }

    // Mark the row RUNNING BEFORE the pacing sleep. If the runner crashes
    // mid-sleep, recoverInflightOnStart will transition the row back to
    // PENDING on next boot. The previous order (sleep, then mark RUNNING)
    // let a crash-during-pace drop the in-memory recentVisits ring, so the
    // very next boot could fire a visit immediately and bypass the
    // automation-detection guard the pacing is supposed to provide.
    // Mark RUNNING for crash recovery, but do NOT bump attempts yet — the job
    // may still defer on a busy enrich-lock below without ever visiting a
    // profile. Burning an attempt there let repeated lock contention push a
    // job to permanent FAILED with zero real visits. attempts is incremented
    // only on the failure path, where a visit was actually attempted.
    await prisma.enrichmentJob.update({
      where: { id: job.id },
      data: { status: "RUNNING" }
    });

    // Pacing — randomised gap in [paceMinMs, paceMaxMs] since the last
    // visit. After every `longIdleEvery` visits, an additional extended
    // pause in [longIdleMinMs, longIdleMaxMs] is layered on top.
    const baseGap = randomInRange(deps.paceMinMs, deps.paceMaxMs);
    const longIdleGap =
      deps.longIdleEvery > 0 && visitsSinceLongIdle >= deps.longIdleEvery
        ? randomInRange(deps.longIdleMinMs, deps.longIdleMaxMs)
        : 0;
    const requiredGap = baseGap + longIdleGap;
    const elapsed = Date.now() - lastVisitAt;
    if (lastVisitAt > 0 && elapsed < requiredGap) {
      await new Promise((resolve) => setTimeout(resolve, requiredGap - elapsed));
    }
    if (longIdleGap > 0) {
      visitsSinceLongIdle = 0;
    }

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
    recentVisits.push(lastVisitAt);
    visitsSinceLongIdle += 1;

    if ("failed" in result && result.failed) {
      await persistFailure(job.personId, result.reason);
      const attempts = job.attempts + 1;
      const permanent = isPermanentFailure(result.reason);
      const giveUp = permanent || attempts >= 3;
      await prisma.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: giveUp ? "FAILED" : "PENDING",
          // Persist the real attempt count here (no longer bumped at the
          // RUNNING step) so the next run's give-up check sees an accurate
          // number that only counts attempts where a visit actually ran.
          attempts,
          lastError: `${result.reason}${result.detail ? `: ${result.detail}` : ""}`,
          // Pass the PRE-increment count (job.attempts) — exponentialDelayMs
          // is contracted on "attempts before the failed run", so the first
          // failure (job.attempts=0) hits the 1h tier instead of jumping to
          // 6h. The persisted `attempts` above (post-increment) still drives
          // the give-up check.
          nextAttemptAt: giveUp ? null : new Date(Date.now() + exponentialDelayMs(job.attempts))
        }
      });
      console.warn(
        `[enrichment-queue] job=${job.id} person=${job.personId} failed reason=${result.reason} attempts=${attempts} giveUp=${giveUp}${permanent ? " (permanent)" : ""}`
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
    pruneOldVisits();
    if (recentVisits.length >= deps.dailyCap) {
      return { deferred: true };
    }
    // Acquire the enrich lock so a concurrent drain pass can't collide on
    // the same managed page. Defer if the lock is held — the caller will
    // fall back to enqueue and the worker drains it normally.
    let result: ProfileExtractionResult;
    try {
      const acquired = await deps.operationMutex.tryAcquire(deps.enrichLockKey, () =>
        visitProfile(personId)
      );
      if (!acquired.acquired) {
        return { deferred: true };
      }
      result = acquired.value;
    } catch (error) {
      // A thrown visit (e.g. getManagedPage threw, or a step escaped
      // extractProfile) must not skip the rate-limit accounting and
      // persistFailure below — mirror processJob and treat it as an
      // unknown failure so the visit is still recorded.
      const detail = error instanceof Error ? error.message : String(error);
      result = { failed: true, reason: "unknown", detail };
    }
    lastVisitAt = Date.now();
    recentVisits.push(lastVisitAt);
    visitsSinceLongIdle += 1;
    if ("failed" in result && result.failed) {
      await persistFailure(personId, result.reason);
      return { failed: true, reason: result.reason };
    }
    await persistSuccess(personId, result as ExtractedProfile);
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
    // Always kick — even if recovery throws — so any pre-existing PENDING
    // rows are picked up on next boot. Otherwise a flaky DB read at start
    // could leave the queue idle for up to a full periodicTimer interval
    // (1h) before the next chance to drain.
    void recoverInflightOnStart()
      .catch((error) => {
        console.warn(
          `[enrichment-queue] recover failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        if (!stopped) kick();
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
