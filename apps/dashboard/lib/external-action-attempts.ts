const STORAGE_PREFIX = "rios.external-action-attempt.v1:";

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const fallbackValues = new Map<string, unknown>();

export class ExternalActionAttemptConflictError extends Error {
  constructor() {
    super("A previous action is still unresolved. Check its status before changing and trying again.");
    this.name = "ExternalActionAttemptConflictError";
  }
}

export class ExternalActionAttemptStorageError extends Error {
  constructor() {
    super("Tovi could not safely preserve this action. Reload before trying again.");
    this.name = "ExternalActionAttemptStorageError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

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

  function valueStorageKey(attemptKey: string): string {
    return storageKey(`value:${attemptKey}`);
  }

  function getOrCreateScopedValue<TIntent, TValue>(
    scope: string,
    intent: TIntent,
    create: () => TValue
  ): TValue {
    const key = valueStorageKey(`scoped:${scope}`);
    const expectedIntent = canonicalJson(intent);
    let record: { version: 1; intent: TIntent; value: TValue } | undefined;

    try {
      const persisted = storage?.getItem(key);
      if (persisted) {
        const parsed = JSON.parse(persisted) as
          | { version?: unknown; intent?: unknown; value?: unknown }
          | null;
        if (
          !parsed ||
          parsed.version !== 1 ||
          !("intent" in parsed) ||
          !("value" in parsed)
        ) {
          throw new ExternalActionAttemptStorageError();
        }
        record = parsed as { version: 1; intent: TIntent; value: TValue };
        fallbackValues.set(key, record);
      }
    } catch (error) {
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }

    if (!record) {
      const fallback = fallbackValues.get(key);
      if (fallback !== undefined) {
        record = fallback as { version: 1; intent: TIntent; value: TValue };
      }
    }

    if (record) {
      if (canonicalJson(record.intent) !== expectedIntent) {
        throw new ExternalActionAttemptConflictError();
      }
      return record.value;
    }

    record = { version: 1, intent, value: create() };
    fallbackValues.set(key, record);
    if (storage) {
      const serialized = JSON.stringify(record);
      try {
        storage.setItem(key, serialized);
        if (storage.getItem(key) !== serialized) {
          throw new ExternalActionAttemptStorageError();
        }
      } catch (error) {
        fallbackValues.delete(key);
        if (error instanceof ExternalActionAttemptStorageError) throw error;
        throw new ExternalActionAttemptStorageError();
      }
    }
    return record.value;
  }

  function completeScopedValue<TValue>(
    scope: string,
    matches: (value: TValue) => boolean
  ): boolean {
    const key = valueStorageKey(`scoped:${scope}`);
    let record = fallbackValues.get(key) as
      | { version: 1; intent: unknown; value: TValue }
      | undefined;
    let persistedSerialized: string | null = null;
    if (storage) {
      try {
        persistedSerialized = storage.getItem(key);
        if (!persistedSerialized) return false;
        const parsed = JSON.parse(persistedSerialized) as
          | { version?: unknown; intent?: unknown; value?: unknown }
          | null;
        if (
          !parsed ||
          parsed.version !== 1 ||
          !("intent" in parsed) ||
          !("value" in parsed)
        ) {
          throw new ExternalActionAttemptStorageError();
        }
        record = parsed as { version: 1; intent: unknown; value: TValue };
      } catch {
        throw new ExternalActionAttemptStorageError();
      }
    }
    if (!record || record.version !== 1 || !matches(record.value)) return false;
    try {
      if (storage && storage.getItem(key) !== persistedSerialized) return false;
      storage?.removeItem(key);
      if (storage && storage.getItem(key) !== null) {
        throw new ExternalActionAttemptStorageError();
      }
    } catch {
      throw new ExternalActionAttemptStorageError();
    }
    fallbackValues.delete(key);
    return true;
  }

  return {
    getOrCreateScopedValue,
    completeScopedValue
  };
}
