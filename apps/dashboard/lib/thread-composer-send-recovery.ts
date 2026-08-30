import {
  normalizeThreadComposerIntent,
  type ThreadComposerIntentDraft,
  type ThreadComposerSession
} from "./thread-composer-session";

export type ThreadComposerSendAttemptKind = "immediate" | "scheduled";

export interface ThreadComposerDraftRevision {
  text: string;
  updatedAt: string;
}

export interface ThreadComposerSendAttemptIntent {
  composerIntent: ThreadComposerIntentDraft;
  draftRevision: ThreadComposerDraftRevision | null;
  kind: ThreadComposerSendAttemptKind;
  scheduledFor: string | null;
  threadId: string;
}

export interface ThreadComposerSendAttemptValue {
  clientSendId: string;
  requestedAt: string;
  sessionRevision: number;
}

export interface ThreadComposerSendAttempt {
  intent: ThreadComposerSendAttemptIntent;
  value: ThreadComposerSendAttemptValue;
}

export type ComposerSendRecoveryDisposition =
  | "cleanup"
  | "replay_same_id"
  | "restore"
  | "retain"
  | "retain_uncertain"
  | "scheduled";

export function threadComposerSendScope(threadId: string): string {
  return `composer-send:${threadId}`;
}

function validIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function normalizeThreadComposerSendAttempt(
  value: unknown
): ThreadComposerSendAttempt | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!raw.intent || typeof raw.intent !== "object" || !raw.value || typeof raw.value !== "object") {
    return null;
  }
  const rawIntent = raw.intent as Record<string, unknown>;
  const rawValue = raw.value as Record<string, unknown>;
  const composerIntent = normalizeThreadComposerIntent(rawIntent.composerIntent);
  const draftRevision = rawIntent.draftRevision;
  const normalizedDraftRevision =
    draftRevision === null
      ? null
      : draftRevision &&
          typeof draftRevision === "object" &&
          typeof (draftRevision as Record<string, unknown>).text === "string" &&
          validIsoDate((draftRevision as Record<string, unknown>).updatedAt)
        ? {
            text: (draftRevision as Record<string, unknown>).text as string,
            updatedAt: (draftRevision as Record<string, unknown>).updatedAt as string
          }
        : undefined;
  if (
    !composerIntent ||
    (rawIntent.kind !== "immediate" && rawIntent.kind !== "scheduled") ||
    typeof rawIntent.threadId !== "string" ||
    !rawIntent.threadId ||
    !(rawIntent.scheduledFor === null || validIsoDate(rawIntent.scheduledFor)) ||
    normalizedDraftRevision === undefined ||
    typeof rawValue.clientSendId !== "string" ||
    !rawValue.clientSendId ||
    !validIsoDate(rawValue.requestedAt) ||
    !Number.isInteger(rawValue.sessionRevision) ||
    (rawValue.sessionRevision as number) < 1
  ) {
    return null;
  }
  if (rawIntent.kind === "scheduled" && rawIntent.scheduledFor === null) return null;
  if (rawIntent.kind === "immediate" && rawIntent.scheduledFor !== null) return null;
  return {
    intent: {
      composerIntent,
      draftRevision: normalizedDraftRevision,
      kind: rawIntent.kind,
      scheduledFor: rawIntent.scheduledFor,
      threadId: rawIntent.threadId
    },
    value: {
      clientSendId: rawValue.clientSendId,
      requestedAt: rawValue.requestedAt,
      sessionRevision: rawValue.sessionRevision as number
    }
  };
}

export function shouldHideComposerSessionForAttempt(
  session: ThreadComposerSession | null,
  attempt: ThreadComposerSendAttempt | null
): boolean {
  return Boolean(
    session &&
      attempt &&
      session.revision === attempt.value.sessionRevision &&
      attempt.intent.threadId.length > 0
  );
}

export function missingThreadComposerAttachments(
  intent: ThreadComposerIntentDraft,
  recoveredAttachmentIds: Iterable<string>
) {
  const recovered = new Set(recoveredAttachmentIds);
  return intent.attachments.filter((attachment) => !recovered.has(attachment.id));
}

export function composerSendRecoveryDisposition(status: {
  status: "NOT_FOUND" | "PENDING" | "SCHEDULED" | "SENT" | "FAILED" | "CANCELLED";
  deliveryUncertain?: boolean;
  errorKind?: string;
}): ComposerSendRecoveryDisposition {
  if (status.status === "SENT") return "cleanup";
  if (status.status === "SCHEDULED") return "scheduled";
  if (status.status === "PENDING") return "retain";
  if (status.status === "NOT_FOUND") return "replay_same_id";
  if (
    status.status === "FAILED" &&
    (status.deliveryUncertain || status.errorKind === "DELIVERY_UNCERTAIN")
  ) {
    return "retain_uncertain";
  }
  return "restore";
}
