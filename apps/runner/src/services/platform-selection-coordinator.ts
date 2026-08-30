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
}

export function createPlatformSelectionCoordinator(
  deps: PlatformSelectionCoordinatorDeps
) {
  const orderedPlatforms = [...new Set(deps.platforms)].sort();
  let latestMutationVersion = 0;

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
    _selectedPlatforms: readonly PlatformName[]
  ): ReservedPlatformSelectionMutation {
    const version = ++latestMutationVersion;
    deps.requestAbort("platform_selection_changed");
    return {
      run<T>(work: () => Promise<T>): Promise<T> {
        return withAllPlatformLocks(async () => {
          if (version !== latestMutationVersion) {
            throw new PlatformSelectionSupersededError();
          }
          return work();
        });
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
    return deps.withPlatformLocks(platform, async () => {
      const current = await deps.getEnabledPlatforms();
      if (!current.includes(platform)) {
        throw new PlatformNotSelectedError(platform);
      }
      return work();
    });
  }

  return { reserveMutation, mutate, withSelectedPlatform };
}
