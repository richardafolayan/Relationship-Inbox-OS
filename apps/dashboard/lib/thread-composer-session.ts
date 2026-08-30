export type ThreadComposerSource = "empty" | "draft" | "predraft" | "user";

export type ThreadComposerAttachmentKind =
  | "photo"
  | "voice_note"
  | "video"
  | "audio"
  | "pdf"
  | "sticker"
  | "gif"
  | "unknown";

export interface ThreadComposerAttachmentDescriptor {
  id: string;
  kind: ThreadComposerAttachmentKind;
  lastModified: number;
  name: string;
  size: number;
  type: string;
}

export interface ThreadComposerIntentDraft {
  attachments: ThreadComposerAttachmentDescriptor[];
  customScheduleValue: string;
  replyToMessageId: string | null;
  source: ThreadComposerSource;
  text: string;
}

export interface ThreadComposerSession extends ThreadComposerIntentDraft {
  revision: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY_PREFIX = "thread:composer-intent:v2:";
const ATTACHMENT_KINDS = new Set<ThreadComposerAttachmentKind>([
  "photo",
  "voice_note",
  "video",
  "audio",
  "pdf",
  "sticker",
  "gif",
  "unknown"
]);

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

function normalizeAttachment(value: unknown): ThreadComposerAttachmentDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.name !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.size !== "number" ||
    !Number.isFinite(raw.size) ||
    raw.size < 0 ||
    typeof raw.lastModified !== "number" ||
    !Number.isFinite(raw.lastModified) ||
    typeof raw.kind !== "string" ||
    !ATTACHMENT_KINDS.has(raw.kind as ThreadComposerAttachmentKind)
  ) {
    return null;
  }
  return {
    id: raw.id,
    kind: raw.kind as ThreadComposerAttachmentKind,
    lastModified: raw.lastModified,
    name: raw.name,
    size: raw.size,
    type: raw.type
  };
}

export function normalizeThreadComposerIntent(value: unknown): ThreadComposerIntentDraft | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.text !== "string" ||
    !validSource(raw.source) ||
    typeof raw.customScheduleValue !== "string" ||
    !(raw.replyToMessageId === null || typeof raw.replyToMessageId === "string") ||
    !Array.isArray(raw.attachments)
  ) {
    return null;
  }
  const attachments = raw.attachments.map(normalizeAttachment);
  if (attachments.some((attachment) => attachment === null)) return null;
  return {
    attachments: attachments as ThreadComposerAttachmentDescriptor[],
    customScheduleValue: raw.customScheduleValue,
    replyToMessageId: raw.replyToMessageId,
    source: raw.source,
    text: raw.text
  };
}

function isEmptyIntent(intent: ThreadComposerIntentDraft): boolean {
  return (
    !intent.text &&
    intent.attachments.length === 0 &&
    !intent.replyToMessageId &&
    !intent.customScheduleValue
  );
}

export function sameThreadComposerIntent(
  left: ThreadComposerIntentDraft,
  right: ThreadComposerIntentDraft
): boolean {
  return JSON.stringify(normalizeThreadComposerIntent(left)) === JSON.stringify(normalizeThreadComposerIntent(right));
}

export type SafeSendFailureDisposition =
  | "restore_captured"
  | "keep_failed_attempt"
  | "leave_route_session";

export function safeSendFailureDisposition(
  sendThreadId: string,
  activeThreadId: string,
  currentIntent: ThreadComposerIntentDraft,
  clearedIntent: ThreadComposerIntentDraft
): SafeSendFailureDisposition {
  if (activeThreadId !== sendThreadId) return "leave_route_session";
  return sameThreadComposerIntent(currentIntent, clearedIntent)
    ? "restore_captured"
    : "keep_failed_attempt";
}

export function readThreadComposerSession(
  threadId: string,
  storage: StorageLike | null = defaultStorage()
): ThreadComposerSession | null {
  if (!storage || !threadId) return null;
  try {
    const raw = storage.getItem(keyFor(threadId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const intent = normalizeThreadComposerIntent(parsed);
    if (!intent || !Number.isInteger(parsed.revision) || (parsed.revision as number) < 1) {
      return null;
    }
    return { ...intent, revision: parsed.revision as number };
  } catch {
    return null;
  }
}

export function snapshotThreadComposerSession(
  threadId: string,
  draft: ThreadComposerIntentDraft,
  storage: StorageLike | null = defaultStorage()
): ThreadComposerSession | null {
  if (!storage || !threadId) return null;
  const intent = normalizeThreadComposerIntent(draft);
  if (!intent) return null;
  try {
    if (isEmptyIntent(intent)) {
      storage.removeItem(keyFor(threadId));
      return null;
    }
    const current = readThreadComposerSession(threadId, storage);
    const next: ThreadComposerSession = {
      ...intent,
      revision:
        current && sameThreadComposerIntent(current, intent)
          ? current.revision
          : (current?.revision ?? 0) + 1
    };
    storage.setItem(keyFor(threadId), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function consumeThreadComposerSession(
  threadId: string,
  expectedRevision: number,
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!storage || !threadId || !Number.isInteger(expectedRevision)) return false;
  try {
    const current = readThreadComposerSession(threadId, storage);
    if (!current || current.revision !== expectedRevision) return false;
    storage.removeItem(keyFor(threadId));
    return true;
  } catch {
    return false;
  }
}

export const __test = { KEY_PREFIX, keyFor };
