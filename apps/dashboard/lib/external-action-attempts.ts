const STORAGE_PREFIX = "rios.external-action-attempt.v1:";

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const fallbackAttempts = new Map<string, string>();

function browserStorage(): AttemptStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function createExternalActionAttemptStore(
  storage: AttemptStorage | undefined = browserStorage()
) {
  function storageKey(attemptKey: string): string {
    return `${STORAGE_PREFIX}${attemptKey}`;
  }

  function getOrCreate(attemptKey: string, createId: () => string): string {
    const key = storageKey(attemptKey);
    try {
      const persisted = storage?.getItem(key);
      if (persisted) {
        fallbackAttempts.set(key, persisted);
        return persisted;
      }
    } catch {
      // The in-memory fallback still protects retries in this renderer.
    }

    const existing = fallbackAttempts.get(key);
    if (existing) return existing;

    const created = createId();
    fallbackAttempts.set(key, created);
    try {
      storage?.setItem(key, created);
    } catch {
      // Persistence is best effort when browser storage is unavailable.
    }
    return created;
  }

  function complete(attemptKey: string): void {
    const key = storageKey(attemptKey);
    fallbackAttempts.delete(key);
    try {
      storage?.removeItem(key);
    } catch {
      // Completion remains valid even when browser storage is unavailable.
    }
  }

  function completeIfReconciled(
    attemptKey: string,
    reconciliationPending?: boolean
  ): void {
    if (!reconciliationPending) complete(attemptKey);
  }

  return { getOrCreate, complete, completeIfReconciled };
}
