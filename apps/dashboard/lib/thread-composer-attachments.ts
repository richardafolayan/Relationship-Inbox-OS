import type { ThreadComposerAttachmentDescriptor } from "./thread-composer-session";

export interface RecoveredThreadComposerAttachment {
  descriptor: ThreadComposerAttachmentDescriptor;
  file: File;
}

export interface ThreadComposerAttachmentStore {
  readonly namespace: string;
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
  remove(threadId: string, attachmentIds: string[], namespace?: string): Promise<void>;
}

export async function assertThreadComposerAttachmentsRecoverable(
  store: ThreadComposerAttachmentStore,
  threadId: string,
  descriptors: ThreadComposerAttachmentDescriptor[],
  namespace?: string
): Promise<void> {
  if (descriptors.length === 0) return;
  const recovered = await store.read(threadId, descriptors, namespace);
  if (recovered.length !== descriptors.length) {
    throw new Error(
      "This attachment could not be saved for recovery. Remove it or add it again before sending."
    );
  }
}

interface PersistedAttachmentRecord extends ThreadComposerAttachmentDescriptor {
  blob: Blob;
  key: string;
  tabId: string;
  threadId: string;
  updatedAt: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DATABASE_NAME = "tovi-composer-recovery";
const DATABASE_VERSION = 1;
const ATTACHMENTS_STORE = "attachments";
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
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ATTACHMENTS_STORE)) {
        database.createObjectStore(ATTACHMENTS_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not open."));
  });
}

function attachmentKey(tabId: string, threadId: string, attachmentId: string): string {
  return `${tabId}:${encodeURIComponent(threadId)}:${attachmentId}`;
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
  now: () => number = Date.now
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

  const purgeStale = async () => {
    const db = await database();
    const transaction = db.transaction(ATTACHMENTS_STORE, "readwrite");
    const store = transaction.objectStore(ATTACHMENTS_STORE);
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      const record = cursor.value as PersistedAttachmentRecord;
      if (record.updatedAt < now() - STALE_AFTER_MS) cursor.delete();
      cursor.continue();
    };
    await transactionComplete(transaction);
  };
  void purgeStale().catch(() => undefined);

  return {
    namespace: tabId,
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
    }
  };
}

export function createMemoryThreadComposerAttachmentStore(
  namespace = "memory"
): ThreadComposerAttachmentStore {
  const records = new Map<string, PersistedAttachmentRecord>();
  return {
    namespace,
    async put(threadId, descriptor, file, targetNamespace = namespace) {
      records.set(attachmentKey(targetNamespace, threadId, descriptor.id), {
        ...descriptor,
        blob: file,
        key: attachmentKey(targetNamespace, threadId, descriptor.id),
        tabId: targetNamespace,
        threadId,
        updatedAt: Date.now()
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
        records.delete(attachmentKey(targetNamespace, threadId, attachmentId));
      }
    }
  };
}

let defaultStore: ThreadComposerAttachmentStore | null = null;

export function defaultThreadComposerAttachmentStore(): ThreadComposerAttachmentStore {
  if (defaultStore) return defaultStore;
  if (typeof indexedDB === "undefined" || typeof window === "undefined") {
    defaultStore = createMemoryThreadComposerAttachmentStore();
    return defaultStore;
  }
  try {
    const tabId = getOrCreateThreadComposerTabId(window.sessionStorage);
    defaultStore = createIndexedDbThreadComposerAttachmentStore(indexedDB, tabId);
  } catch {
    defaultStore = createMemoryThreadComposerAttachmentStore();
  }
  return defaultStore;
}

export const __test = {
  ATTACHMENTS_STORE,
  DATABASE_NAME,
  STALE_AFTER_MS,
  TAB_ID_KEY,
  attachmentKey
};
