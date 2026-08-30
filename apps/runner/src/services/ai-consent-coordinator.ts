interface AiConsentCoordinatorDeps {
  getEnabled(): Promise<boolean>;
}

export class AiConsentMutationSupersededError extends Error {
  constructor() {
    super("A newer AI consent choice replaced this request.");
    this.name = "AiConsentMutationSupersededError";
  }
}

export interface ReservedAiConsentMutation {
  run<T>(work: () => Promise<T>): Promise<T>;
  cancel(): Promise<void>;
}

export function createAiConsentCoordinator(deps: AiConsentCoordinatorDeps) {
  let latestMutationVersion = 0;
  let desiredEnabled: boolean | null = null;
  let mutationTail: Promise<void> = Promise.resolve();

  async function withMutationLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
    }
  }

  function isEnabledForNewWork(): boolean {
    return desiredEnabled ?? true;
  }

  function reserveMutation(enabled: boolean): ReservedAiConsentMutation {
    const version = ++latestMutationVersion;
    let state: "reserved" | "running" | "settled" = "reserved";
    desiredEnabled = enabled;

    async function restoreDurableConsent(): Promise<void> {
      if (version !== latestMutationVersion) return;
      const durableEnabled = await deps.getEnabled().catch(() => false);
      if (version === latestMutationVersion) desiredEnabled = durableEnabled;
    }

    return {
      async run<T>(work: () => Promise<T>): Promise<T> {
        if (state !== "reserved" || version !== latestMutationVersion) {
          throw new AiConsentMutationSupersededError();
        }
        state = "running";
        try {
          return await withMutationLock(async () => {
            if (version !== latestMutationVersion) {
              throw new AiConsentMutationSupersededError();
            }
            try {
              return await work();
            } catch (error) {
              await restoreDurableConsent();
              throw error;
            }
          });
        } finally {
          state = "settled";
        }
      },
      async cancel(): Promise<void> {
        if (state !== "reserved") return;
        state = "settled";
        await withMutationLock(restoreDurableConsent);
      }
    };
  }

  function mutate<T>(enabled: boolean, work: () => Promise<T>): Promise<T> {
    return reserveMutation(enabled).run(work);
  }

  return { isEnabledForNewWork, reserveMutation, mutate };
}
