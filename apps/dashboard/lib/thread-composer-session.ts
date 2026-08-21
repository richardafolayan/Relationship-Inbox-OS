export type ThreadComposerSource = "empty" | "draft" | "predraft" | "user";

export interface ThreadComposerSessionDraft {
  text: string;
  source: ThreadComposerSource;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = "thread:composer:";

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function keyFor(threadId: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(threadId)}`;
}

function validSource(value: unknown): value is ThreadComposerSource {
  return value === "empty" || value === "draft" || value === "predraft" || value === "user";
}

export function readThreadComposerSession(
  threadId: string,
  storage: StorageLike | null = defaultStorage()
): ThreadComposerSessionDraft | null {
  if (!storage || !threadId) return null;
  try {
    const raw = storage.getItem(keyFor(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ThreadComposerSessionDraft>;
    if (typeof parsed.text !== "string" || !parsed.text || !validSource(parsed.source)) return null;
    return { text: parsed.text, source: parsed.source };
  } catch {
    return null;
  }
}

export function writeThreadComposerSession(
  threadId: string,
  draft: ThreadComposerSessionDraft,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage || !threadId) return;
  try {
    if (!draft.text) {
      storage.removeItem(keyFor(threadId));
      return;
    }
    storage.setItem(keyFor(threadId), JSON.stringify(draft));
  } catch {
    // Private tab-scoped recovery is best effort. A blocked or full storage
    // surface must never stop the operator from writing or sending.
  }
}

export function clearThreadComposerSession(
  threadId: string,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage || !threadId) return;
  try {
    storage.removeItem(keyFor(threadId));
  } catch {
    // Best effort, matching read/write behavior.
  }
}

export const __test = { KEY_PREFIX, keyFor };
