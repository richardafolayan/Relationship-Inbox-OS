import type { PlatformName } from "@inbox-os/core";
import type { AdminResetResult } from "./admin-reset";

interface AdminResetCoordinatorDeps {
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
  resetGraph(platform: PlatformName): Promise<AdminResetResult>;
  auditLog(input: {
    platform: PlatformName;
    stage: "System";
    action: "ADMIN_RESET";
    status: "OK";
    details: {
      requestId: string;
      platform: PlatformName;
      matchedThreadCount: number;
      deleted: AdminResetResult["deleted"];
    };
  }): Promise<unknown>;
}

export function createAdminResetCoordinator(deps: AdminResetCoordinatorDeps) {
  async function reset(input: {
    platform: PlatformName;
    requestId: string;
  }): Promise<AdminResetResult> {
    return deps.withGlobalResetLock(async () => {
      deps.requestAbort(`admin_reset:${input.platform.toLowerCase()}`);
      deps.clearInFlight();
      try {
        return await deps.withExternalActionLock(input.platform, async () => {
          for (const platform of deps.platforms) {
            if (platform === input.platform) continue;
            await deps.withPlatformLock(platform, async () => undefined);
          }

          return deps.withPlatformLock(input.platform, async () => {
            const result = await deps.resetGraph(input.platform);
            await deps.auditLog({
              platform: input.platform,
              stage: "System",
              action: "ADMIN_RESET",
              status: "OK",
              details: {
                requestId: input.requestId,
                platform: input.platform,
                matchedThreadCount: result.matchedThreadCount,
                deleted: result.deleted
              }
            });
            return result;
          });
        });
      } finally {
        deps.clearAbort();
      }
    });
  }

  return { reset };
}
