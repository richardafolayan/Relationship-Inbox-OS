import type { PlatformName } from "@inbox-os/core";

type ExternalActionOutcome<T> =
  | { status: "completed"; value: T }
  | { status: "missing" };

interface ThreadExternalActionFenceDeps<TTarget extends { platform: PlatformName }> {
  discoverPlatform(threadId: string): Promise<PlatformName | null>;
  loadTarget(threadId: string): Promise<TTarget | null>;
  withExternalActionLock<T>(
    platform: PlatformName,
    work: () => Promise<T>
  ): Promise<T>;
  withPlatformLock<T>(platform: PlatformName, work: () => Promise<T>): Promise<T>;
}

export function createThreadExternalActionFence<
  TTarget extends { platform: PlatformName }
>(deps: ThreadExternalActionFenceDeps<TTarget>) {
  async function run<T>(
    threadId: string,
    work: (target: TTarget) => Promise<T>
  ): Promise<ExternalActionOutcome<T>> {
    const discoveredPlatform = await deps.discoverPlatform(threadId);
    if (!discoveredPlatform) return { status: "missing" };

    return deps.withExternalActionLock(discoveredPlatform, async () => {
      const target = await deps.loadTarget(threadId);
      if (!target || target.platform !== discoveredPlatform) {
        return { status: "missing" };
      }

      return deps.withPlatformLock(discoveredPlatform, async () => ({
        status: "completed",
        value: await work(target)
      }));
    });
  }

  return { run };
}
