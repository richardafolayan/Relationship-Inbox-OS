import type { PlatformName } from "@inbox-os/core";

interface DemoCleanupCoordinatorDeps {
  resolvePlatforms(threadIds: readonly string[]): Promise<PlatformName[]>;
  withGlobalResetLock<T>(work: () => Promise<T>): Promise<T>;
  withExternalActionLock<T>(
    platform: PlatformName,
    work: () => Promise<T>
  ): Promise<T>;
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

export function createDemoCleanupCoordinator(
  deps: DemoCleanupCoordinatorDeps
) {
  async function run<T>(
    threadIds: readonly string[],
    work: () => Promise<T>
  ): Promise<T> {
    return deps.withGlobalResetLock(async () => {
      const platforms = Array.from(
        new Set(await deps.resolvePlatforms(threadIds))
      ).sort();
      return withPlatformLocks(platforms, deps.withExternalActionLock, work);
    });
  }

  return { run };
}
