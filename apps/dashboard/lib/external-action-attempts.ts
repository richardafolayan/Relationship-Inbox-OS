const STORAGE_PREFIX = "rios.external-action-attempt.v1:";

type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type AttemptLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => T | Promise<T>
  ): Promise<T>;
};

const testLockTails = new Map<string, Promise<void>>();

const testLockManager: AttemptLockManager = {
  async request<T>(
    name: string,
    _options: { mode: "exclusive" },
    callback: () => T | Promise<T>
  ): Promise<T> {
    const previous = testLockTails.get(name) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    testLockTails.set(name, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (testLockTails.get(name) === current) testLockTails.delete(name);
    }
  }
};

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

function browserLocks(): AttemptLockManager | undefined {
  if (typeof navigator === "undefined") return undefined;
  return navigator.locks as AttemptLockManager | undefined;
}

export function createExternalActionAttemptStore(
  storageOverride?: AttemptStorage,
  lockOverride?: AttemptLockManager
) {
  const storage = storageOverride ?? browserStorage();
  const locks =
    lockOverride ??
    browserLocks() ??
    (typeof window === "undefined" && storageOverride ? testLockManager : undefined);

  function valueStorageKey(scope: string): string {
    return `${STORAGE_PREFIX}value:scoped:${scope}`;
  }

  async function withScopeLock<T>(scope: string, work: () => Promise<T>): Promise<T> {
    if (!storage || !locks) throw new ExternalActionAttemptStorageError();
    try {
      return await locks.request(`${STORAGE_PREFIX}lock:${scope}`, { mode: "exclusive" }, work);
    } catch (error) {
      if (
        error instanceof ExternalActionAttemptConflictError ||
        error instanceof ExternalActionAttemptStorageError
      ) {
        throw error;
      }
      throw new ExternalActionAttemptStorageError();
    }
  }

  function readRecord<TIntent, TValue>(key: string): {
    version: 1;
    intent: TIntent;
    value: TValue;
    completed?: boolean;
  } | undefined {
    try {
      const persisted = storage?.getItem(key);
      if (!persisted) return undefined;
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
      return parsed as {
        version: 1;
        intent: TIntent;
        value: TValue;
        completed?: boolean;
      };
    } catch (error) {
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }
  }

  function writeRecord(key: string, record: unknown): void {
    if (!storage) throw new ExternalActionAttemptStorageError();
    const serialized = JSON.stringify(record);
    try {
      storage.setItem(key, serialized);
      if (storage.getItem(key) !== serialized) throw new ExternalActionAttemptStorageError();
    } catch (error) {
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }
  }

  function removeRecord(key: string): void {
    if (!storage) throw new ExternalActionAttemptStorageError();
    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new ExternalActionAttemptStorageError();
    } catch (error) {
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }
  }

  async function getOrCreateScopedValue<TIntent, TValue>(
    scope: string,
    intent: TIntent,
    create: () => TValue,
    canReplace?: (value: TValue) => Promise<boolean>
  ): Promise<TValue> {
    return withScopeLock(scope, async () => {
      const key = valueStorageKey(scope);
      let record = readRecord<TIntent, TValue>(key);
      const expectedIntent = canonicalJson(intent);
      if (record && canonicalJson(record.intent) !== expectedIntent) {
        if (!canReplace || !(await canReplace(record.value))) {
          throw new ExternalActionAttemptConflictError();
        }
        removeRecord(key);
        record = undefined;
      }
      if (record) return record.value;
      const created = { version: 1 as const, intent, value: create() };
      writeRecord(key, created);
      return created.value;
    });
  }

  async function replaceScopedValue<TValue>(
    scope: string,
    matches: (value: TValue) => boolean,
    nextValue: TValue
  ): Promise<boolean> {
    return withScopeLock(scope, async () => {
      const key = valueStorageKey(scope);
      const record = readRecord<unknown, TValue>(key);
      if (!record || !matches(record.value)) return false;
      writeRecord(key, { ...record, value: nextValue });
      return true;
    });
  }

  async function completeScopedValue<TValue>(
    scope: string,
    matches: (value: TValue) => boolean
  ): Promise<boolean> {
    return withScopeLock(scope, async () => {
      const key = valueStorageKey(scope);
      const record = readRecord<unknown, TValue>(key);
      if (!record || !matches(record.value)) return false;
      writeRecord(key, { ...record, completed: true });
      return true;
    });
  }

  return {
    getOrCreateScopedValue,
    replaceScopedValue,
    completeScopedValue
  };
}
