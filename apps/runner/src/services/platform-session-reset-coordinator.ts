import type { PlatformName } from "@inbox-os/core";
import {
  planPlatformSessionReset,
  type PlatformSessionResetPlan
} from "./platform-session-reset";

interface PlatformSessionResetCoordinatorDeps {
  platforms: readonly PlatformName[];
  requestAbort(reason: string): void;
  clearAbort(): void;
  clearInFlight(): void;
  withGlobalResetLock<T>(work: () => Promise<T>): Promise<T>;
  withExternalActionLock<T>(
    platform: PlatformName,
    work: () => Promise<T>
  ): Promise<T>;
  withPlatformLock<T>(platform: PlatformName, work: () => Promise<T>): Promise<T>;
  resetSharedSession(): Promise<void>;
  resetInstagramSession(): Promise<void>;
  persistStatus(platform: PlatformName): Promise<void>;
  auditLog(input: {
    platform?: PlatformName;
    stage: "Connect";
    action: "RESET_SESSION";
    status: "OK";
    details: {
      resetScope: PlatformSessionResetPlan["resetScope"];
      resetSharedSession: boolean;
      resetInstagramSession: boolean;
      affectedPlatformCount: number;
    };
  }): Promise<unknown>;
}

async function withPlatformLocks<T>(
  platforms: readonly PlatformName[],
  acquire: <R>(platform: PlatformName, work: () => Promise<R>) => Promise<R>,
  work: () => Promise<T>,
  index = 0
): Promise<T> {
  const platform = platforms[index];
  if (!platform) return work();
  return acquire(platform, () => withPlatformLocks(platforms, acquire, work, index + 1));
}

export function createPlatformSessionResetCoordinator(
  deps: PlatformSessionResetCoordinatorDeps
) {
  async function reset(requestedPlatform?: PlatformName): Promise<PlatformSessionResetPlan> {
    const plan = planPlatformSessionReset([...deps.platforms], requestedPlatform);
    const affectedPlatforms = Array.from(new Set(plan.statusPlatforms)).sort();

    return deps.withGlobalResetLock(async () => {
      deps.requestAbort("session_reset:manual");
      deps.clearInFlight();
      try {
        return await withPlatformLocks(
          affectedPlatforms,
          deps.withExternalActionLock,
          () =>
            withPlatformLocks(affectedPlatforms, deps.withPlatformLock, async () => {
              if (plan.resetSharedSession) await deps.resetSharedSession();
              if (plan.resetInstagramSession) await deps.resetInstagramSession();
              for (const platform of plan.statusPlatforms) {
                await deps.persistStatus(platform);
              }
              await deps.auditLog({
                platform: requestedPlatform,
                stage: "Connect",
                action: "RESET_SESSION",
                status: "OK",
                details: {
                  resetScope: plan.resetScope,
                  resetSharedSession: plan.resetSharedSession,
                  resetInstagramSession: plan.resetInstagramSession,
                  affectedPlatformCount: plan.statusPlatforms.length
                }
              });
              return plan;
            })
        );
      } finally {
        deps.clearAbort();
      }
    });
  }

  return { reset };
}
