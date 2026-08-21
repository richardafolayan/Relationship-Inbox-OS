export type DictationInterruptionReason =
  | "audio-interruption"
  | "backgrounded"
  | "frozen"
  | "muted"
  | "pagehide"
  | "recorder-error"
  | "stalled"
  | "track-ended";

export interface PersistedDictationSession {
  endedAt?: number;
  id: string;
  interruptionReason?: DictationInterruptionReason;
  mimeType: string;
  startedAt: number;
  status: "interrupted" | "recording";
}

export interface RecoveredDictationCapture extends PersistedDictationSession {
  blob: Blob;
}

export interface DictationChunkStore {
  append: (sessionId: string, sequence: number, blob: Blob) => Promise<void>;
  begin: (session: PersistedDictationSession) => Promise<void>;
  interrupt: (
    sessionId: string,
    reason: DictationInterruptionReason,
    endedAt: number
  ) => Promise<void>;
  latestRecoverable: () => Promise<RecoveredDictationCapture | null>;
  read: (sessionId: string) => Promise<RecoveredDictationCapture | null>;
  remove: (sessionId: string) => Promise<void>;
}

export function dictationInterruptionMessage(
  reason: DictationInterruptionReason | undefined
): string {
  let cause = "the recorder stopped unexpectedly";
  if (reason === "audio-interruption") cause = "iOS interrupted microphone access";
  else if (reason === "backgrounded" || reason === "pagehide" || reason === "frozen") {
    cause = "Tovi left the screen";
  } else if (reason === "muted") cause = "the microphone stopped delivering audio";
  else if (reason === "stalled") cause = "no new audio arrived";
  else if (reason === "track-ended") cause = "iOS ended microphone access";
  return `Recording stopped when ${cause}. Audio captured before that point is safe. Speech after the interruption may be missing.`;
}

interface DictationChunkRecord {
  blob: Blob;
  key: string;
  sequence: number;
  sessionId: string;
}

const DATABASE_NAME = "tovi-dictation-capture";
const DATABASE_VERSION = 1;
const SESSIONS_STORE = "sessions";
const CHUNKS_STORE = "chunks";
const CHUNKS_SESSION_INDEX = "sessionId";

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
      if (!database.objectStoreNames.contains(SESSIONS_STORE)) {
        database.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(CHUNKS_STORE)) {
        const chunks = database.createObjectStore(CHUNKS_STORE, { keyPath: "key" });
        chunks.createIndex(CHUNKS_SESSION_INDEX, CHUNKS_SESSION_INDEX, { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not open."));
  });
}

export function createIndexedDbDictationChunkStore(
  indexedDb: IDBFactory = indexedDB
): DictationChunkStore {
  let databasePromise: Promise<IDBDatabase> | null = null;
  const database = () => {
    databasePromise ??= openDatabase(indexedDb);
    return databasePromise;
  };

  const read = async (sessionId: string): Promise<RecoveredDictationCapture | null> => {
    const db = await database();
    const transaction = db.transaction([SESSIONS_STORE, CHUNKS_STORE], "readonly");
    const sessionRequest = transaction.objectStore(SESSIONS_STORE).get(sessionId);
    const chunksRequest = transaction
      .objectStore(CHUNKS_STORE)
      .index(CHUNKS_SESSION_INDEX)
      .getAll(IDBKeyRange.only(sessionId));
    const [session, chunks] = await Promise.all([
      requestResult(sessionRequest) as Promise<PersistedDictationSession | undefined>,
      requestResult(chunksRequest) as Promise<DictationChunkRecord[]>
    ]);
    await transactionComplete(transaction);
    if (!session || chunks.length === 0) return null;
    chunks.sort((left, right) => left.sequence - right.sequence);
    return {
      ...session,
      blob: new Blob(
        chunks.map((chunk) => chunk.blob),
        { type: session.mimeType }
      )
    };
  };

  return {
    async begin(session) {
      const db = await database();
      const transaction = db.transaction(SESSIONS_STORE, "readwrite");
      transaction.objectStore(SESSIONS_STORE).put(session);
      await transactionComplete(transaction);
    },
    async append(sessionId, sequence, blob) {
      const db = await database();
      const transaction = db.transaction(CHUNKS_STORE, "readwrite");
      transaction.objectStore(CHUNKS_STORE).put({
        blob,
        key: `${sessionId}:${String(sequence).padStart(8, "0")}`,
        sequence,
        sessionId
      } satisfies DictationChunkRecord);
      await transactionComplete(transaction);
    },
    async interrupt(sessionId, reason, endedAt) {
      const db = await database();
      const transaction = db.transaction(SESSIONS_STORE, "readwrite");
      const store = transaction.objectStore(SESSIONS_STORE);
      const session = (await requestResult(
        store.get(sessionId)
      )) as PersistedDictationSession | undefined;
      if (session) {
        store.put({
          ...session,
          endedAt,
          interruptionReason: reason,
          status: "interrupted"
        } satisfies PersistedDictationSession);
      }
      await transactionComplete(transaction);
    },
    async latestRecoverable() {
      const db = await database();
      const transaction = db.transaction(SESSIONS_STORE, "readonly");
      const sessions = (await requestResult(
        transaction.objectStore(SESSIONS_STORE).getAll()
      )) as PersistedDictationSession[];
      await transactionComplete(transaction);
      const latest = sessions
        .filter((session) => session.status === "interrupted" || session.status === "recording")
        .sort((left, right) => right.startedAt - left.startedAt);
      for (const session of latest) {
        const recovered = await read(session.id);
        if (recovered) return recovered;
      }
      return null;
    },
    read,
    async remove(sessionId) {
      const db = await database();
      const transaction = db.transaction([SESSIONS_STORE, CHUNKS_STORE], "readwrite");
      transaction.objectStore(SESSIONS_STORE).delete(sessionId);
      const chunks = transaction.objectStore(CHUNKS_STORE);
      const range = IDBKeyRange.only(sessionId);
      const cursorRequest = chunks.index(CHUNKS_SESSION_INDEX).openKeyCursor(range);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        chunks.delete(cursor.primaryKey);
        cursor.continue();
      };
      await transactionComplete(transaction);
    }
  };
}

export function createMemoryDictationChunkStore(): DictationChunkStore {
  const sessions = new Map<string, PersistedDictationSession>();
  const chunks = new Map<string, Array<{ blob: Blob; sequence: number }>>();
  const read = async (sessionId: string): Promise<RecoveredDictationCapture | null> => {
    const session = sessions.get(sessionId);
    const storedChunks = chunks.get(sessionId);
    if (!session || !storedChunks?.length) return null;
    return {
      ...session,
      blob: new Blob(
        storedChunks
          .slice()
          .sort((left, right) => left.sequence - right.sequence)
          .map((chunk) => chunk.blob),
        { type: session.mimeType }
      )
    };
  };
  return {
    async begin(session) {
      sessions.set(session.id, { ...session });
      chunks.set(session.id, []);
    },
    async append(sessionId, sequence, blob) {
      chunks.get(sessionId)?.push({ blob, sequence });
    },
    async interrupt(sessionId, reason, endedAt) {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.set(sessionId, {
        ...session,
        endedAt,
        interruptionReason: reason,
        status: "interrupted"
      });
    },
    async latestRecoverable() {
      const latest = [...sessions.values()].sort(
        (left, right) => right.startedAt - left.startedAt
      );
      for (const session of latest) {
        const recovered = await read(session.id);
        if (recovered) return recovered;
      }
      return null;
    },
    read,
    async remove(sessionId) {
      sessions.delete(sessionId);
      chunks.delete(sessionId);
    }
  };
}

let defaultStore: DictationChunkStore | null = null;

export function defaultDictationChunkStore(): DictationChunkStore {
  defaultStore ??=
    typeof indexedDB === "undefined"
      ? createMemoryDictationChunkStore()
      : createIndexedDbDictationChunkStore(indexedDB);
  return defaultStore;
}

export async function recoverInterruptedDictationCapture(
  store: DictationChunkStore = defaultDictationChunkStore()
): Promise<RecoveredDictationCapture | null> {
  try {
    return await store.latestRecoverable();
  } catch {
    return null;
  }
}

export async function removePersistedDictationCapture(
  sessionId: string,
  store: DictationChunkStore = defaultDictationChunkStore()
): Promise<void> {
  try {
    await store.remove(sessionId);
  } catch {}
}
