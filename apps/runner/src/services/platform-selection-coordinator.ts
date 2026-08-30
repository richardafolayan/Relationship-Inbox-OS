import type { PlatformName } from "@inbox-os/core";

interface PlatformSelectionCoordinatorDeps {
  platforms: readonly PlatformName[];
  getEnabledPlatforms(): Promise<readonly PlatformName[]>;
  requestAbort(reason: string): void;
  withPlatformLocks<T>(platform: PlatformName, work: () => Promise<T>): Promise<T>;
}

export class PlatformNotSelectedError extends Error {
  constructor(readonly platform: PlatformName) {
    super(`${platform} is not selected in Settings.`);
    this.name = "PlatformNotSelectedError";
  }
}

export class PlatformSelectionSupersededError extends Error {
  constructor() {
    super("A newer platform selection replaced this request.");
    this.name = "PlatformSelectionSupersededError";
  }
}

export interface ReservedPlatformSelectionMutation {
  run<T>(work: () => Promise<T>): Promise<T>;
  cancel(): Promise<void>;
}

export function createPlatformSelectionCoordinator(
  deps: PlatformSelectionCoordinatorDeps
) {
  const orderedPlatforms = [...new Set(deps.platforms)].sort();
  let latestMutationVersion = 0;
  let desiredSelection: Set<PlatformName> | null = null;

  function isPlatformSelectedForNewWork(platform: PlatformName): boolean {
    return desiredSelection?.has(platform) ?? true;
  }

  async function withAllPlatformLocks<T>(work: () => Promise<T>): Promise<T> {
    const enter = (index: number): Promise<T> => {
      const platform = orderedPlatforms[index];
      return platform
        ? deps.withPlatformLocks(platform, () => enter(index + 1))
        : work();
    };
    return enter(0);
  }

  function reserveMutation(
    selectedPlatforms: readonly PlatformName[]
  ): ReservedPlatformSelectionMutation {
    const version = ++latestMutationVersion;
    let state: "reserved" | "running" | "settled" = "reserved";
    desiredSelection = new Set(selectedPlatforms);
    deps.requestAbort("platform_selection_changed");
    return {
      async run<T>(work: () => Promise<T>): Promise<T> {
        if (state !== "reserved") {
          throw new PlatformSelectionSupersededError();
        }
        state = "running";
        try {
          return await withAllPlatformLocks(async () => {
            if (version !== latestMutationVersion) {
              throw new PlatformSelectionSupersededError();
            }
            return work();
          });
        } catch (error) {
          if (version === latestMutationVersion) {
            desiredSelection = new Set(await deps.getEnabledPlatforms().catch(() => []));
          }
          throw error;
        } finally {
          state = "settled";
        }
      },
      async cancel(): Promise<void> {
        if (state !== "reserved") return;
        state = "settled";
        if (version === latestMutationVersion) {
          desiredSelection = new Set(await deps.getEnabledPlatforms().catch(() => []));
        }
      }
    };
  }

  function mutate<T>(
    selectedPlatforms: readonly PlatformName[],
    work: () => Promise<T>
  ): Promise<T> {
    return reserveMutation(selectedPlatforms).run(work);
  }

  async function withSelectedPlatform<T>(
    platform: PlatformName,
    work: () => Promise<T>
  ): Promise<T> {
    if (!isPlatformSelectedForNewWork(platform)) {
      throw new PlatformNotSelectedError(platform);
    }
    return deps.withPlatformLocks(platform, async () => {
      if (!isPlatformSelectedForNewWork(platform)) {
        throw new PlatformNotSelectedError(platform);
      }
      const current = await deps.getEnabledPlatforms();
      if (!current.includes(platform)) {
        throw new PlatformNotSelectedError(platform);
      }
      return work();
    });
  }

  return {
    reserveMutation,
    mutate,
    withSelectedPlatform,
    isPlatformSelectedForNewWork
  };
}
