import type { PlatformName } from "@inbox-os/core";

export interface PlatformSelectionReconcilerDeps {
  getEnabledPlatforms(): Promise<readonly PlatformName[]>;
  getCurrentScanPlatform(): PlatformName | null | undefined;
  requestAbort(reason: string): void;
  managedPlatforms: readonly PlatformName[];
  withPlatformLocks<T>(platform: PlatformName, work: () => Promise<T>): Promise<T>;
  closeSession(platform: PlatformName): Promise<void>;
}

export async function reconcileSelectedPlatformLifecycle(
  deps: PlatformSelectionReconcilerDeps
): Promise<void> {
  const selected = new Set(await deps.getEnabledPlatforms());
  const activePlatform = deps.getCurrentScanPlatform();
  if (activePlatform && !selected.has(activePlatform)) {
    deps.requestAbort("platform_deselected");
  }

  await Promise.all(
    deps.managedPlatforms
      .filter((platform) => !selected.has(platform))
      .map((platform) =>
        deps.withPlatformLocks(platform, async () => {
          const authoritative = await deps.getEnabledPlatforms();
          if (authoritative.includes(platform)) return;
          await deps.closeSession(platform);
        })
      )
  );
}

export function shouldStartLinkedInRealtimeWatcher(input: {
  available: boolean;
  selected: boolean;
  connectedAt: Date | null | undefined;
}): boolean {
  return input.available && input.selected && Boolean(input.connectedAt);
}
