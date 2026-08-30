const STORAGE_PREFIX = "rios.external-action-attempt.v1:";

export function externalActionCompletedStorageKey(scope: string): string {
  return `${STORAGE_PREFIX}completed:scoped:${scope}`;
}

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

function durableActionIdentity(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.clientSendId === "string" && record.clientSendId) {
    return `clientSendId:${record.clientSendId}`;
  }
  if (typeof record.clientActionId === "string" && record.clientActionId) {
    return `clientActionId:${record.clientActionId}`;
  }
  return null;
}

function completedValueDominates(active: unknown, completed: unknown[]): boolean {
  const identity = durableActionIdentity(active);
  return Boolean(
    identity && completed.some((candidate) => durableActionIdentity(candidate) === identity)
  );
}

function browserStorage(): AttemptStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function browserPinStorage(): AttemptStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.sessionStorage;
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
  lockOverride?: AttemptLockManager,
  pinStorageOverride?: AttemptStorage
) {
  const storage = storageOverride ?? browserStorage();
  const pinStorage = pinStorageOverride ?? browserPinStorage();
  const locks =
    lockOverride ??
    browserLocks() ??
    (typeof window === "undefined" && storageOverride ? testLockManager : undefined);
  const pinnedScopedOperations = new Map<string, {
    intentJson: string;
    value: unknown;
  }>();

  function valueStorageKey(scope: string): string {
    return `${STORAGE_PREFIX}value:scoped:${scope}`;
  }

  function pinStorageKey(scope: string): string {
    return `${STORAGE_PREFIX}pin:scoped:${scope}`;
  }

  function readCompletedScopedState<TValue>(scope: string): {
    prunedBefore?: number;
    values: TValue[];
  } {
    if (!storage) throw new ExternalActionAttemptStorageError();
    try {
      const persisted = storage.getItem(externalActionCompletedStorageKey(scope));
      if (!persisted) return { values: [] };
      const parsed = JSON.parse(persisted) as
        | { prunedBefore?: unknown; version?: unknown; values?: unknown }
        | null;
      if (
        !parsed ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.values) ||
        !(
          parsed.prunedBefore === undefined ||
          (typeof parsed.prunedBefore === "number" && Number.isFinite(parsed.prunedBefore))
        )
      ) {
        throw new ExternalActionAttemptStorageError();
      }
      return {
        ...(typeof parsed.prunedBefore === "number"
          ? { prunedBefore: parsed.prunedBefore }
          : {}),
        values: parsed.values as TValue[]
      };
    } catch (error) {
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }
  }

  function readCompletedScopedValues<TValue>(scope: string): TValue[] {
    return readCompletedScopedState<TValue>(scope).values;
  }

  function appendCompletedScopedValue<TValue>(scope: string, value: TValue): void {
    if (!storage) throw new ExternalActionAttemptStorageError();
    const currentState = readCompletedScopedState<TValue>(scope);
    const current = currentState.values;
    const serializedValue = canonicalJson(value);
    const nextValues = [
      ...current.filter((candidate) => canonicalJson(candidate) !== serializedValue),
      value
    ];
    const values = nextValues.slice(-100);
    const prunedBefore =
      nextValues.length > values.length ? Date.now() : currentState.prunedBefore;
    const serialized = JSON.stringify({
      ...(prunedBefore !== undefined ? { prunedBefore } : {}),
      version: 1,
      values
    });
    try {
      storage.setItem(externalActionCompletedStorageKey(scope), serialized);
      if (storage.getItem(externalActionCompletedStorageKey(scope)) !== serialized) {
        throw new ExternalActionAttemptStorageError();
      }
    } catch (error) {
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }
  }

  function readPinnedOperation(scope: string): {
    intentJson: string;
    value: unknown;
  } | undefined {
    const memoryValue = pinnedScopedOperations.get(scope);
    if (memoryValue) return memoryValue;
    if (!pinStorage) return undefined;
    try {
      const persisted = pinStorage.getItem(pinStorageKey(scope));
      if (!persisted) return undefined;
      const parsed = JSON.parse(persisted) as
        | { version?: unknown; intentJson?: unknown; value?: unknown }
        | null;
      if (
        !parsed ||
        parsed.version !== 1 ||
        typeof parsed.intentJson !== "string" ||
        !("value" in parsed)
      ) {
        throw new ExternalActionAttemptStorageError();
      }
      const operation = { intentJson: parsed.intentJson, value: parsed.value };
      pinnedScopedOperations.set(scope, operation);
      return operation;
    } catch (error) {
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }
  }

  function writePinnedOperation(
    scope: string,
    operation: { intentJson: string; value: unknown }
  ): void {
    pinnedScopedOperations.set(scope, operation);
    if (!pinStorage) return;
    const serialized = JSON.stringify({ version: 1, ...operation });
    try {
      pinStorage.setItem(pinStorageKey(scope), serialized);
      if (pinStorage.getItem(pinStorageKey(scope)) !== serialized) {
        throw new ExternalActionAttemptStorageError();
      }
    } catch (error) {
      pinnedScopedOperations.delete(scope);
      if (error instanceof ExternalActionAttemptStorageError) throw error;
      throw new ExternalActionAttemptStorageError();
    }
  }

  function removePinnedOperation(scope: string): void {
    if (pinStorage) {
      try {
        pinStorage.removeItem(pinStorageKey(scope));
        if (pinStorage.getItem(pinStorageKey(scope)) !== null) {
          throw new ExternalActionAttemptStorageError();
        }
      } catch (error) {
        if (error instanceof ExternalActionAttemptStorageError) throw error;
        throw new ExternalActionAttemptStorageError();
      }
    }
    pinnedScopedOperations.delete(scope);
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
    canReplace?: (value: TValue) => Promise<boolean>,
    reuseCompleted?: (value: TValue) => boolean
  ): Promise<TValue> {
    return withScopeLock(scope, async () => {
      const key = valueStorageKey(scope);
      let record = readRecord<TIntent, TValue>(key);
      const expectedIntent = canonicalJson(intent);
      const completedValues = readCompletedScopedValues<TValue>(scope);
      const completed = reuseCompleted
        ? completedValues.find(reuseCompleted)
        : undefined;
      if (completed) {
        writePinnedOperation(scope, {
          intentJson: expectedIntent,
          value: completed
        });
        return completed;
      }
      if (record && completedValueDominates(record.value, completedValues)) {
        removeRecord(key);
        record = undefined;
      }
      const pinned = readPinnedOperation(scope);
      if (pinned && completedValueDominates(pinned.value, completedValues)) {
        removePinnedOperation(scope);
      }
      const activePin = readPinnedOperation(scope);
      if (activePin) {
        if (activePin.intentJson === expectedIntent) {
          return activePin.value as TValue;
        }
        if (!canReplace || !(await canReplace(activePin.value as TValue))) {
          throw new ExternalActionAttemptConflictError();
        }
        removePinnedOperation(scope);
      }
      if (record && canonicalJson(record.intent) !== expectedIntent) {
        if (!canReplace || !(await canReplace(record.value))) {
          throw new ExternalActionAttemptConflictError();
        }
        removeRecord(key);
        record = undefined;
      }
      if (record?.completed) {
        removeRecord(key);
        record = undefined;
      }
      if (record) {
        writePinnedOperation(scope, {
          intentJson: expectedIntent,
          value: record.value
        });
        return record.value;
      }
      const created = { version: 1 as const, intent, value: create() };
      writeRecord(key, created);
      writePinnedOperation(scope, {
        intentJson: expectedIntent,
        value: created.value
      });
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
      if (
        record &&
        completedValueDominates(record.value, readCompletedScopedValues<TValue>(scope))
      ) {
        removeRecord(key);
        const completedPin = readPinnedOperation(scope);
        if (
          completedPin &&
          durableActionIdentity(completedPin.value) === durableActionIdentity(record.value)
        ) removePinnedOperation(scope);
        return false;
      }
      const pinned = readPinnedOperation(scope);
      if (pinned && matches(pinned.value as TValue)) {
        if (record && canonicalJson(record.value) === canonicalJson(pinned.value)) {
          writeRecord(key, { ...record, value: nextValue });
        }
        writePinnedOperation(scope, {
          intentJson: pinned.intentJson,
          value: nextValue
        });
        return true;
      }
      if (!record || !matches(record.value)) return false;
      writeRecord(key, { ...record, value: nextValue });
      writePinnedOperation(scope, {
        intentJson: canonicalJson(record.intent),
        value: nextValue
      });
      return true;
    });
  }

  async function compareAndReplaceScopedValue<TValue>(
    scope: string,
    matches: (value: TValue) => boolean,
    nextValue: TValue
  ): Promise<boolean> {
    return withScopeLock(scope, async () => {
      const key = valueStorageKey(scope);
      const record = readRecord<unknown, TValue>(key);
      if (!record || !matches(record.value)) return false;
      if (completedValueDominates(record.value, readCompletedScopedValues<TValue>(scope))) {
        removeRecord(key);
        const completedPin = readPinnedOperation(scope);
        if (
          completedPin &&
          durableActionIdentity(completedPin.value) === durableActionIdentity(record.value)
        ) removePinnedOperation(scope);
        return false;
      }
      writeRecord(key, { ...record, value: nextValue });
      const pinned = readPinnedOperation(scope);
      if (pinned && canonicalJson(pinned.value) === canonicalJson(record.value)) {
        writePinnedOperation(scope, {
          intentJson: pinned.intentJson,
          value: nextValue
        });
      }
      return true;
    });
  }

  async function completeScopedValue<TValue>(
    scope: string,
    matches: (value: TValue) => boolean,
    retainCompletedValue = false,
    completedValue?: TValue
  ): Promise<boolean> {
    return withScopeLock(scope, async () => {
      const key = valueStorageKey(scope);
      const record = readRecord<unknown, TValue>(key);
      const pinned = readPinnedOperation(scope);
      if (pinned && matches(pinned.value as TValue)) {
        if (retainCompletedValue) {
          appendCompletedScopedValue(scope, completedValue ?? pinned.value as TValue);
        }
        if (record && canonicalJson(record.value) === canonicalJson(pinned.value)) {
          removeRecord(key);
        }
        removePinnedOperation(scope);
        return true;
      }
      if (!record || !matches(record.value)) return false;
      if (retainCompletedValue) {
        appendCompletedScopedValue(scope, completedValue ?? record.value);
      }
      removeRecord(key);
      return true;
    });
  }

  async function compareAndCompleteScopedValue<TValue>(
    scope: string,
    matches: (value: TValue) => boolean,
    retainCompletedValue = false,
    completedValue?: TValue
  ): Promise<boolean> {
    return withScopeLock(scope, async () => {
      const key = valueStorageKey(scope);
      const record = readRecord<unknown, TValue>(key);
      if (!record || !matches(record.value)) return false;
      if (retainCompletedValue) {
        appendCompletedScopedValue(scope, completedValue ?? record.value);
      }
      removeRecord(key);
      const pinned = readPinnedOperation(scope);
      if (pinned && canonicalJson(pinned.value) === canonicalJson(record.value)) {
        removePinnedOperation(scope);
      }
      return true;
    });
  }

  function readScopedAttempt<TIntent, TValue>(scope: string):
    | { intent: TIntent; value: TValue }
    | undefined {
    if (!storage) throw new ExternalActionAttemptStorageError();
    const record = readRecord<TIntent, TValue>(valueStorageKey(scope));
    if (!record || record.completed) return undefined;
    if (completedValueDominates(record.value, readCompletedScopedValues<TValue>(scope))) {
      return undefined;
    }
    return { intent: record.intent, value: record.value };
  }

  return {
    compareAndCompleteScopedValue,
    compareAndReplaceScopedValue,
    getOrCreateScopedValue,
    replaceScopedValue,
    completeScopedValue,
    readScopedAttempt,
    readCompletedScopedState,
    readCompletedScopedValues
  };
}
