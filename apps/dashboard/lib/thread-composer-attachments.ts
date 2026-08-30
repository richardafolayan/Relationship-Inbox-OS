import {
  shouldRefreshThreadComposerAttachmentOwnership,
  type ThreadComposerAttachmentDescriptor,
  type ThreadComposerSession,
  type ThreadComposerSessionInspection
} from "./thread-composer-session";

export interface RecoveredThreadComposerAttachment {
  descriptor: ThreadComposerAttachmentDescriptor;
  file: File;
}

export interface ThreadComposerAttachmentStore {
  readonly durable: boolean;
  readonly namespace: string;
  claimOwnership(
    threadId: string,
    attachmentIds: string[],
    ownerId: string,
    namespace?: string
  ): Promise<void>;
  put(
    threadId: string,
    descriptor: ThreadComposerAttachmentDescriptor,
    file: File,
    namespace?: string
  ): Promise<void>;
  read(
    threadId: string,
    descriptors: ThreadComposerAttachmentDescriptor[],
    namespace?: string
  ): Promise<RecoveredThreadComposerAttachment[]>;
  purgeStale(
    ownerIsLive?: (threadId: string, ownerId: string) => boolean | null
  ): Promise<void>;
  remove(threadId: string, attachmentIds: string[], namespace?: string): Promise<void>;
  removeUnowned(threadId: string, attachmentIds: string[], namespace?: string): Promise<void>;
  releaseOwnership(threadId: string, ownerId: string, namespace?: string): Promise<void>;
}

export interface ThreadComposerAttachmentOwnership {
  attachmentIds: string[];
  namespace: string;
  ownerId: string;
  revisionId: string;
}

export interface PreparedThreadComposerAttachmentOwnershipHandoff {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function prepareThreadComposerAttachmentNamespaceHandoff(
  store: ThreadComposerAttachmentStore,
  threadId: string,
  attachmentIds: string[],
  ownerId: string,
  predecessorNamespace: string,
  successorNamespace: string
): Promise<PreparedThreadComposerAttachmentOwnershipHandoff> {
  await store.claimOwnership(threadId, attachmentIds, ownerId, successorNamespace);
  let settled: "committed" | "rolled_back" | null = null;
  return {
    async commit() {
      if (settled) return;
      await store.releaseOwnership(threadId, ownerId, predecessorNamespace);
      await store.removeUnowned(threadId, attachmentIds, predecessorNamespace);
      settled = "committed";
    },
    async rollback() {
      if (settled) return;
      await store.releaseOwnership(threadId, ownerId, successorNamespace);
      await store.removeUnowned(threadId, attachmentIds, successorNamespace);
      settled = "rolled_back";
    }
  };
}

export async function prepareThreadComposerAttachmentOwnershipHandoff(
  store: ThreadComposerAttachmentStore,
  threadId: string,
  attachmentIds: string[],
  predecessorOwnerId: string,
  successorOwnerId: string,
  namespace: string
): Promise<PreparedThreadComposerAttachmentOwnershipHandoff> {
  await store.claimOwnership(threadId, attachmentIds, successorOwnerId, namespace);
  let settled: "committed" | "rolled_back" | null = null;
  return {
    async commit() {
      if (settled) return;
      await store.releaseOwnership(threadId, predecessorOwnerId, namespace);
      settled = "committed";
    },
    async rollback() {
      if (settled) return;
      await store.releaseOwnership(threadId, successorOwnerId, namespace);
      settled = "rolled_back";
    }
  };
}

type ThreadComposerSessionDisposition = "active" | "blocked" | "sent" | "superseded";

export async function reconcileThreadComposerAttachmentOwnership(
  store: ThreadComposerAttachmentStore,
  threadId: string,
  ownership: ThreadComposerAttachmentOwnership,
  inspectSession: () => ThreadComposerSessionInspection,
  sessionDisposition: (session: ThreadComposerSession) => ThreadComposerSessionDisposition,
  ownershipIsCurrent: () => boolean = () => true
): Promise<"retained" | "released"> {
  const shouldRetain = (): boolean | null => {
    if (!ownershipIsCurrent()) return false;
    const sessionRead = inspectSession();
    if (!sessionRead.readable) return null;
    if (!sessionRead.session) return false;
    try {
      return shouldRefreshThreadComposerAttachmentOwnership(
        sessionRead.session,
        ownership.revisionId,
        sessionDisposition(sessionRead.session)
      );
    } catch {
      return null;
    }
  };

  let retain = shouldRetain();
  if (retain === false) retain = shouldRetain();
  if (retain !== false) {
    await store.claimOwnership(
      threadId,
      ownership.attachmentIds,
      ownership.ownerId,
      ownership.namespace
    );
    retain = shouldRetain();
  }
  if (retain !== false) return "retained";
  await store.releaseOwnership(threadId, ownership.ownerId, ownership.namespace);
  return "released";
}

export async function assertThreadComposerAttachmentsRecoverable(
  store: ThreadComposerAttachmentStore,
  threadId: string,
  descriptors: ThreadComposerAttachmentDescriptor[],
  namespace?: string
): Promise<void> {
  if (descriptors.length === 0) return;
  if (!store.durable) {
    throw new Error(
      "This attachment could not be saved durably for recovery. Reload before trying again."
    );
  }
  const recovered = await store.read(threadId, descriptors, namespace);
  if (recovered.length !== descriptors.length) {
    throw new Error(
      "This attachment could not be saved for recovery. Remove it or add it again before sending."
    );
  }
}

export function removableThreadComposerAttachmentIds(
  completed: ThreadComposerAttachmentDescriptor[],
  preserved: ThreadComposerAttachmentDescriptor[]
): string[] {
  const preservedIds = new Set(preserved.map((attachment) => attachment.id));
  return completed
    .map((attachment) => attachment.id)
    .filter((attachmentId) => !preservedIds.has(attachmentId));
}

interface PersistedAttachmentRecord extends ThreadComposerAttachmentDescriptor {
  blob: Blob;
  key: string;
  tabId: string;
  threadId: string;
  updatedAt: number;
}

interface PersistedAttachmentOwner {
  attachmentKey: string;
  key: string;
  namespace: string;
  holderId?: string;
  ownerId: string;
  ownerKey: string;
  threadId: string;
  updatedAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DATABASE_NAME = "tovi-composer-recovery";
const DATABASE_VERSION = 2;
const ATTACHMENTS_STORE = "attachments";
const OWNERS_STORE = "owners";
const TAB_ID_KEY = "thread:composer-attachment-tab:v1";
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

function openDatabase(indexedDb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ATTACHMENTS_STORE)) {
        database.createObjectStore(ATTACHMENTS_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(OWNERS_STORE)) {
        const owners = database.createObjectStore(OWNERS_STORE, { keyPath: "key" });
        owners.createIndex("attachmentKey", "attachmentKey", { unique: false });
        owners.createIndex("ownerKey", "ownerKey", { unique: false });
      }
    };
    request.onblocked = () => {
      settled = true;
      reject(
        new Error(
          "Tovi could not update attachment recovery while another window is open. Close other Tovi windows, then reload."
        )
      );
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("IndexedDB could not open."));
    };
  });
}

function attachmentKey(tabId: string, threadId: string, attachmentId: string): string {
  return `${tabId}:${encodeURIComponent(threadId)}:${attachmentId}`;
}

function attachmentOwnerKey(namespace: string, threadId: string, ownerId: string): string {
  return `${namespace}:${encodeURIComponent(threadId)}:${encodeURIComponent(ownerId)}`;
}

function attachmentHolderKey(
  namespace: string,
  threadId: string,
  ownerId: string,
  holderId: string
): string {
  return `${attachmentOwnerKey(namespace, threadId, ownerId)}:${encodeURIComponent(holderId)}`;
}

function attachmentOwnershipKey(
  namespace: string,
  threadId: string,
  attachmentId: string,
  ownerId: string,
  holderId: string
): string {
  return `${attachmentKey(namespace, threadId, attachmentId)}:${encodeURIComponent(ownerId)}:${encodeURIComponent(holderId)}`;
}

function createHolderId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `holder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function liveOwnerDisposition(
  ownerIsLive: ((threadId: string, ownerId: string) => boolean | null) | undefined,
  threadId: string,
  ownerId: string
): boolean {
  if (!ownerIsLive) return false;
  try {
    return ownerIsLive(threadId, ownerId) !== false;
  } catch {
    return true;
  }
}

function descriptorMatches(
  record: PersistedAttachmentRecord,
  descriptor: ThreadComposerAttachmentDescriptor
): boolean {
  return (
    record.id === descriptor.id &&
    record.kind === descriptor.kind &&
    record.lastModified === descriptor.lastModified &&
    record.name === descriptor.name &&
    record.size === descriptor.size &&
    record.type === descriptor.type
  );
}

function recoveredAttachment(
  record: PersistedAttachmentRecord,
  descriptor: ThreadComposerAttachmentDescriptor
): RecoveredThreadComposerAttachment {
  return {
    descriptor,
    file: new File([record.blob], descriptor.name, {
      lastModified: descriptor.lastModified,
      type: descriptor.type
    })
  };
}

export function getOrCreateThreadComposerTabId(
  storage: StorageLike,
  createId: () => string = () => crypto.randomUUID()
): string {
  const current = storage.getItem(TAB_ID_KEY);
  if (current) return current;
  const next = createId();
  storage.setItem(TAB_ID_KEY, next);
  return next;
}

export function createIndexedDbThreadComposerAttachmentStore(
  indexedDb: IDBFactory,
  tabId: string,
  now: () => number = Date.now,
  holderId = createHolderId()
): ThreadComposerAttachmentStore {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const pending = new Map<string, Promise<void>>();
  const database = () => {
    databasePromise ??= openDatabase(indexedDb);
    return databasePromise;
  };

  const runPending = (key: string, operation: () => Promise<void>): Promise<void> => {
    const previous = pending.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    pending.set(key, next);
    const clear = () => {
      if (pending.get(key) === next) pending.delete(key);
    };
    void next.then(clear, clear);
    return next;
  };

  const purgeStale = async (
    ownerIsLive?: (threadId: string, ownerId: string) => boolean | null
  ) => {
    const db = await database();
    const staleBefore = now() - STALE_AFTER_MS;
    const ownerTransaction = db.transaction([ATTACHMENTS_STORE, OWNERS_STORE], "readwrite");
    const owners = ownerTransaction.objectStore(OWNERS_STORE);
    const attachments = ownerTransaction.objectStore(ATTACHMENTS_STORE);
    const ownerCursor = owners.openCursor();
    ownerCursor.onsuccess = () => {
      const cursor = ownerCursor.result;
      if (!cursor) return;
      const record = cursor.value as PersistedAttachmentOwner;
      if (record.updatedAt < staleBefore) {
        if (liveOwnerDisposition(ownerIsLive, record.threadId, record.ownerId)) {
          cursor.update({ ...record, updatedAt: now() });
          cursor.continue();
          return;
        }
        const attachment = attachments.get(record.attachmentKey);
        attachment.onsuccess = () => {
          const value = attachment.result as PersistedAttachmentRecord | undefined;
          if (value) attachments.put({ ...value, updatedAt: now() });
          cursor.delete();
          cursor.continue();
        };
        attachment.onerror = () => cursor.continue();
        return;
      }
      cursor.continue();
    };
    await transactionComplete(ownerTransaction);

    const transaction = db.transaction([ATTACHMENTS_STORE, OWNERS_STORE], "readwrite");
    const retainedOwners = transaction.objectStore(OWNERS_STORE);
    const store = transaction.objectStore(ATTACHMENTS_STORE);
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const record = cursor.value as PersistedAttachmentRecord;
      if (record.updatedAt >= staleBefore) {
        cursor.continue();
        return;
      }
      const count = retainedOwners.index("attachmentKey").count(record.key);
      count.onsuccess = () => {
        if (count.result === 0) cursor.delete();
        cursor.continue();
      };
      count.onerror = () => cursor.continue();
    };
    await transactionComplete(transaction);
  };
  return {
    durable: true,
    namespace: tabId,
    purgeStale,
    async claimOwnership(threadId, attachmentIds, ownerId, namespace = tabId) {
      if (attachmentIds.length === 0) return;
      const db = await database();
      const transaction = db.transaction(OWNERS_STORE, "readwrite");
      const store = transaction.objectStore(OWNERS_STORE);
      const ownerKey = attachmentHolderKey(namespace, threadId, ownerId, holderId);
      for (const attachmentId of attachmentIds) {
        const key = attachmentKey(namespace, threadId, attachmentId);
        store.put({
          attachmentKey: key,
          holderId,
          key: attachmentOwnershipKey(
            namespace,
            threadId,
            attachmentId,
            ownerId,
            holderId
          ),
          namespace,
          ownerId,
          ownerKey,
          threadId,
          updatedAt: now()
        } satisfies PersistedAttachmentOwner);
      }
      await transactionComplete(transaction);
    },
    async put(threadId, descriptor, file, namespace = tabId) {
      const key = attachmentKey(namespace, threadId, descriptor.id);
      await runPending(key, async () => {
        const db = await database();
        const transaction = db.transaction(ATTACHMENTS_STORE, "readwrite");
        transaction.objectStore(ATTACHMENTS_STORE).put({
          ...descriptor,
          blob: file,
          key,
          tabId: namespace,
          threadId,
          updatedAt: now()
        } satisfies PersistedAttachmentRecord);
        await transactionComplete(transaction);
      });
    },
    async read(threadId, descriptors, namespace = tabId) {
      const keys = descriptors.map((descriptor) =>
        attachmentKey(namespace, threadId, descriptor.id)
      );
      await Promise.all(keys.map((key) => pending.get(key)?.catch(() => undefined)));
      const db = await database();
      const transaction = db.transaction(ATTACHMENTS_STORE, "readonly");
      const store = transaction.objectStore(ATTACHMENTS_STORE);
      const records = await Promise.all(
        keys.map((key) =>
          requestResult(store.get(key)) as Promise<PersistedAttachmentRecord | undefined>
        )
      );
      await transactionComplete(transaction);
      return descriptors.flatMap((descriptor, index) => {
        const record = records[index];
        return record && descriptorMatches(record, descriptor)
          ? [recoveredAttachment(record, descriptor)]
          : [];
      });
    },
    async remove(threadId, attachmentIds, namespace = tabId) {
      const keys = attachmentIds.map((id) => attachmentKey(namespace, threadId, id));
      await Promise.all(
        keys.map((key) =>
          runPending(key, async () => {
            const db = await database();
            const transaction = db.transaction(ATTACHMENTS_STORE, "readwrite");
            transaction.objectStore(ATTACHMENTS_STORE).delete(key);
            await transactionComplete(transaction);
          })
        )
      );
    },
    async removeUnowned(threadId, attachmentIds, namespace = tabId) {
      const db = await database();
      const transaction = db.transaction([ATTACHMENTS_STORE, OWNERS_STORE], "readwrite");
      const attachments = transaction.objectStore(ATTACHMENTS_STORE);
      const owners = transaction.objectStore(OWNERS_STORE).index("attachmentKey");
      for (const attachmentId of attachmentIds) {
        const key = attachmentKey(namespace, threadId, attachmentId);
        const count = owners.count(key);
        count.onsuccess = () => {
          if (count.result !== 0) return;
          const record = attachments.get(key);
          record.onsuccess = () => {
            const value = record.result as PersistedAttachmentRecord | undefined;
            if (value && value.updatedAt < now() - STALE_AFTER_MS) {
              attachments.delete(key);
            }
          };
        };
      }
      await transactionComplete(transaction);
    },
    async releaseOwnership(threadId, ownerId, namespace = tabId) {
      const db = await database();
      const transaction = db.transaction(OWNERS_STORE, "readwrite");
      const cursorRequest = transaction
        .objectStore(OWNERS_STORE)
        .index("ownerKey")
        .openKeyCursor(
          IDBKeyRange.only(attachmentHolderKey(namespace, threadId, ownerId, holderId))
        );
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        transaction.objectStore(OWNERS_STORE).delete(cursor.primaryKey);
        cursor.continue();
      };
      await transactionComplete(transaction);
    }
  };
}

interface MemoryThreadComposerAttachmentOwner {
  ownerId: string;
  updatedAt: number;
}

interface MemoryThreadComposerAttachmentState {
  owners: Map<string, Map<string, MemoryThreadComposerAttachmentOwner>>;
  records: Map<string, PersistedAttachmentRecord>;
}

function createMemoryThreadComposerAttachmentState(): MemoryThreadComposerAttachmentState {
  return { owners: new Map(), records: new Map() };
}

export function createMemoryThreadComposerAttachmentStore(
  namespace = "memory",
  now: () => number = Date.now,
  durable = false,
  holderId = createHolderId(),
  state = createMemoryThreadComposerAttachmentState()
): ThreadComposerAttachmentStore {
  const { owners, records } = state;
  const purgeStale = async (
    ownerIsLive?: (threadId: string, ownerId: string) => boolean | null
  ) => {
    const staleBefore = now() - STALE_AFTER_MS;
    for (const [key, current] of owners) {
      let ownerExpired = false;
      for (const [ownerKey, owner] of current) {
        if (owner.updatedAt < staleBefore) {
          const record = records.get(key);
          if (
            record &&
            liveOwnerDisposition(ownerIsLive, record.threadId, owner.ownerId)
          ) {
            current.set(ownerKey, { ...owner, updatedAt: now() });
            continue;
          }
          current.delete(ownerKey);
          ownerExpired = true;
        }
      }
      if (ownerExpired) {
        const record = records.get(key);
        if (record) records.set(key, { ...record, updatedAt: now() });
      }
      if (current.size === 0) owners.delete(key);
    }
    for (const [key, record] of records) {
      if (record.updatedAt < staleBefore && (owners.get(key)?.size ?? 0) === 0) {
        records.delete(key);
      }
    }
  };
  return {
    durable,
    namespace,
    purgeStale,
    async claimOwnership(threadId, attachmentIds, ownerId, targetNamespace = namespace) {
      for (const attachmentId of attachmentIds) {
        const key = attachmentKey(targetNamespace, threadId, attachmentId);
        const current = owners.get(key) ??
          new Map<string, MemoryThreadComposerAttachmentOwner>();
        current.set(
          attachmentHolderKey(targetNamespace, threadId, ownerId, holderId),
          { ownerId, updatedAt: now() }
        );
        owners.set(key, current);
      }
    },
    async put(threadId, descriptor, file, targetNamespace = namespace) {
      records.set(attachmentKey(targetNamespace, threadId, descriptor.id), {
        ...descriptor,
        blob: file,
        key: attachmentKey(targetNamespace, threadId, descriptor.id),
        tabId: targetNamespace,
        threadId,
        updatedAt: now()
      });
    },
    async read(threadId, descriptors, targetNamespace = namespace) {
      return descriptors.flatMap((descriptor) => {
        const record = records.get(
          attachmentKey(targetNamespace, threadId, descriptor.id)
        );
        return record && descriptorMatches(record, descriptor)
          ? [recoveredAttachment(record, descriptor)]
          : [];
      });
    },
    async remove(threadId, attachmentIds, targetNamespace = namespace) {
      for (const attachmentId of attachmentIds) {
        const key = attachmentKey(targetNamespace, threadId, attachmentId);
        records.delete(key);
        owners.delete(key);
      }
    },
    async removeUnowned(threadId, attachmentIds, targetNamespace = namespace) {
      for (const attachmentId of attachmentIds) {
        const key = attachmentKey(targetNamespace, threadId, attachmentId);
        const record = records.get(key);
        if (
          (owners.get(key)?.size ?? 0) === 0 &&
          record &&
          record.updatedAt < now() - STALE_AFTER_MS
        ) {
          records.delete(key);
        }
      }
    },
    async releaseOwnership(threadId, ownerId, targetNamespace = namespace) {
      const targetOwner = attachmentHolderKey(
        targetNamespace,
        threadId,
        ownerId,
        holderId
      );
      for (const [key, current] of owners) {
        current.delete(targetOwner);
        if (current.size === 0) owners.delete(key);
      }
    }
  };
}

let defaultStore: ThreadComposerAttachmentStore | null = null;

export function defaultThreadComposerAttachmentStore(): ThreadComposerAttachmentStore {
  if (defaultStore) return defaultStore;
  if (typeof indexedDB === "undefined" || typeof window === "undefined") {
    defaultStore = createMemoryThreadComposerAttachmentStore("memory", Date.now, false);
    return defaultStore;
  }
  try {
    const tabId = getOrCreateThreadComposerTabId(window.sessionStorage);
    defaultStore = createIndexedDbThreadComposerAttachmentStore(indexedDB, tabId);
  } catch {
    defaultStore = createMemoryThreadComposerAttachmentStore("memory", Date.now, false);
  }
  return defaultStore;
}

export const __test = {
  ATTACHMENTS_STORE,
  DATABASE_NAME,
  OWNERS_STORE,
  STALE_AFTER_MS,
  TAB_ID_KEY,
  attachmentKey,
  createMemoryThreadComposerAttachmentState,
  openDatabase
};
