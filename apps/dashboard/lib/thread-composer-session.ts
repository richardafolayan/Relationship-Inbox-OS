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
  recoveredScheduledFor?: string;
  replyToMessageId: string | null;
  source: ThreadComposerSource;
  text: string;
}

export interface ThreadComposerDraftRevision {
  text: string;
  updatedAt: string;
}

export interface ThreadComposerSession extends ThreadComposerIntentDraft {
  createdAt?: number;
  draftRevision?: ThreadComposerDraftRevision | null;
  recoveryClientSendId?: string;
  revision: number;
  revisionId: string;
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

function createRevisionId(): string | null {
  try {
    return globalThis.crypto?.randomUUID?.() ?? null;
  } catch {
    return null;
  }
}

function validSource(value: unknown): value is ThreadComposerSource {
  return value === "empty" || value === "draft" || value === "predraft" || value === "user";
}

function normalizeDraftRevision(value: unknown): ThreadComposerDraftRevision | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.text !== "string" ||
    typeof raw.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.updatedAt))
  ) {
    return undefined;
  }
  return { text: raw.text, updatedAt: raw.updatedAt };
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
    !(
      raw.recoveredScheduledFor === undefined ||
      (typeof raw.recoveredScheduledFor === "string" &&
        Number.isFinite(Date.parse(raw.recoveredScheduledFor)))
    ) ||
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
    ...(typeof raw.recoveredScheduledFor === "string"
      ? { recoveredScheduledFor: raw.recoveredScheduledFor }
      : {}),
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
    const revisionId =
      typeof parsed.revisionId === "string" && parsed.revisionId
        ? parsed.revisionId
        : createRevisionId();
    if (!revisionId) return null;
    const draftRevision = normalizeDraftRevision(parsed.draftRevision);
    if (parsed.draftRevision !== undefined && draftRevision === undefined) return null;
    if (
      parsed.recoveryClientSendId !== undefined &&
      (typeof parsed.recoveryClientSendId !== "string" || !parsed.recoveryClientSendId)
    ) return null;
    if (
      parsed.createdAt !== undefined &&
      (typeof parsed.createdAt !== "number" || !Number.isFinite(parsed.createdAt))
    ) return null;
    const session: ThreadComposerSession = {
      ...intent,
      ...(parsed.draftRevision !== undefined ? { draftRevision: draftRevision ?? null } : {}),
      ...(typeof parsed.recoveryClientSendId === "string"
        ? { recoveryClientSendId: parsed.recoveryClientSendId }
        : {}),
      ...(typeof parsed.createdAt === "number" ? { createdAt: parsed.createdAt } : {}),
      revision: parsed.revision as number,
      revisionId
    };
    if (parsed.revisionId !== revisionId) {
      storage.setItem(keyFor(threadId), JSON.stringify(session));
    }
    return session;
  } catch {
    return null;
  }
}

export function snapshotThreadComposerSession(
  threadId: string,
  draft: ThreadComposerIntentDraft,
  storage: StorageLike | null = defaultStorage(),
  draftRevision?: ThreadComposerDraftRevision | null
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
    const unchanged = current && sameThreadComposerIntent(current, intent);
    const revisionId = unchanged ? current.revisionId : createRevisionId();
    if (!revisionId) return null;
    const next: ThreadComposerSession = {
      ...intent,
      ...(draftRevision !== undefined
        ? { draftRevision }
        : current && "draftRevision" in current
          ? { draftRevision: current.draftRevision ?? null }
          : {}),
      ...(unchanged && current.recoveryClientSendId
        ? { recoveryClientSendId: current.recoveryClientSendId }
        : {}),
      ...(unchanged && current.createdAt === undefined
        ? {}
        : { createdAt: unchanged ? current.createdAt : Date.now() }),
      revision: unchanged ? current.revision : (current?.revision ?? 0) + 1,
      revisionId
    };
    storage.setItem(keyFor(threadId), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function rotateThreadComposerSession(
  threadId: string,
  draft: ThreadComposerIntentDraft,
  storage: StorageLike | null = defaultStorage(),
  draftRevision?: ThreadComposerDraftRevision | null
): ThreadComposerSession | null {
  if (!storage || !threadId) return null;
  const intent = normalizeThreadComposerIntent(draft);
  if (!intent || isEmptyIntent(intent)) return null;
  try {
    const current = readThreadComposerSession(threadId, storage);
    const revisionId = createRevisionId();
    if (!revisionId) return null;
    const next: ThreadComposerSession = {
      ...intent,
      ...(draftRevision !== undefined
        ? { draftRevision }
        : current && "draftRevision" in current
          ? { draftRevision: current.draftRevision ?? null }
          : {}),
      createdAt: Date.now(),
      revision: (current?.revision ?? 0) + 1,
      revisionId
    };
    storage.setItem(keyFor(threadId), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function restoreThreadComposerSession(
  threadId: string,
  draft: ThreadComposerIntentDraft,
  revisionId: string,
  storage: StorageLike | null = defaultStorage(),
  draftRevision?: ThreadComposerDraftRevision | null,
  recoveryClientSendId?: string
): ThreadComposerSession | null {
  if (!storage || !threadId || !revisionId) return null;
  const intent = normalizeThreadComposerIntent(draft);
  if (!intent || isEmptyIntent(intent)) return null;
  try {
    const current = readThreadComposerSession(threadId, storage);
    const unchangedRecovery = current?.revisionId === revisionId;
    const retainedRecoveryClientSendId =
      recoveryClientSendId ??
      (unchangedRecovery ? current?.recoveryClientSendId : undefined);
    const next: ThreadComposerSession = {
      ...intent,
      ...(draftRevision !== undefined
        ? { draftRevision }
        : current && "draftRevision" in current
          ? { draftRevision: current.draftRevision ?? null }
          : {}),
      ...(retainedRecoveryClientSendId
        ? { recoveryClientSendId: retainedRecoveryClientSendId }
        : {}),
      createdAt: unchangedRecovery ? current?.createdAt ?? Date.now() : Date.now(),
      revision: unchangedRecovery ? current!.revision : (current?.revision ?? 0) + 1,
      revisionId
    };
    storage.setItem(keyFor(threadId), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function snapshotThreadComposerSessionAfterAcceptedAction(
  threadId: string,
  draft: ThreadComposerIntentDraft,
  acceptedRevisionId: string | null | undefined,
  storage: StorageLike | null = defaultStorage(),
  draftRevision?: ThreadComposerDraftRevision | null
): ThreadComposerSession | null {
  if (!acceptedRevisionId) {
    return snapshotThreadComposerSession(threadId, draft, storage, draftRevision);
  }
  const current = readThreadComposerSession(threadId, storage);
  return current?.revisionId === acceptedRevisionId
    ? rotateThreadComposerSession(threadId, draft, storage, draftRevision)
    : snapshotThreadComposerSession(threadId, draft, storage, draftRevision);
}

export function attachDraftRevisionToThreadComposerSession(
  threadId: string,
  expectedRevision: number,
  expectedRevisionId: string,
  draftRevision: ThreadComposerDraftRevision,
  storage: StorageLike | null = defaultStorage()
): ThreadComposerSession | null {
  if (
    !storage ||
    !threadId ||
    !Number.isInteger(expectedRevision) ||
    !expectedRevisionId
  ) return null;
  try {
    const current = readThreadComposerSession(threadId, storage);
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.revisionId !== expectedRevisionId
    ) return null;
    const next: ThreadComposerSession = { ...current, draftRevision };
    storage.setItem(keyFor(threadId), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function consumeThreadComposerSession(
  threadId: string,
  expectedRevision: number,
  expectedRevisionId: string,
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (
    !storage ||
    !threadId ||
    !Number.isInteger(expectedRevision) ||
    !expectedRevisionId
  ) return false;
  try {
    const current = readThreadComposerSession(threadId, storage);
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.revisionId !== expectedRevisionId
    ) return false;
    storage.removeItem(keyFor(threadId));
    return true;
  } catch {
    return false;
  }
}

export const __test = { KEY_PREFIX, keyFor };
