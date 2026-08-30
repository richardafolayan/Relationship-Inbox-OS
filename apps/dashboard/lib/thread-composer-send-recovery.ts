import {
  normalizeThreadComposerIntent,
  sameThreadComposerIntent,
  type ThreadComposerIntentDraft,
  type ThreadComposerSession
} from "./thread-composer-session";
import { v5 as uuidv5 } from "uuid";

const COMPOSER_SEND_ID_NAMESPACE = "74c50680-8d7a-4ef3-a470-1dbd2730ff63";

export type ThreadComposerSendAttemptKind = "immediate" | "scheduled";

export interface ThreadComposerDraftRevision {
  text: string;
  updatedAt: string;
}

export interface ThreadComposerSendAttemptIntent {
  composerIntent: ThreadComposerIntentDraft;
  draftRevision: ThreadComposerDraftRevision | null;
  kind: ThreadComposerSendAttemptKind;
  recoveryPredecessorClientSendId?: string;
  scheduledFor: string | null;
  sessionRevisionId?: string;
  threadId: string;
}

export interface ThreadComposerSendAttemptValue {
  attachmentNamespace?: string;
  attemptKind?: ThreadComposerSendAttemptKind;
  clientSendId: string;
  notFoundRecovery?: "blocked" | "replay" | "restore";
  replayClaimId?: string;
  resolution?: "restored" | "sent";
  requestedAt: string;
  restoredSessionRevisionId?: string;
  scheduledFor?: string | null;
  sessionRevision: number;
  sessionRevisionId?: string;
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

export type ComposerReplayPreflight =
  | { ok: true }
  | { ok: false; message: string };

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
    !(
      rawIntent.recoveryPredecessorClientSendId === undefined ||
      (typeof rawIntent.recoveryPredecessorClientSendId === "string" &&
        rawIntent.recoveryPredecessorClientSendId)
    ) ||
    !(
      rawIntent.sessionRevisionId === undefined ||
      (typeof rawIntent.sessionRevisionId === "string" && rawIntent.sessionRevisionId)
    ) ||
    normalizedDraftRevision === undefined ||
    !(
      rawValue.attachmentNamespace === undefined ||
      (typeof rawValue.attachmentNamespace === "string" && rawValue.attachmentNamespace)
    ) ||
    !(
      rawValue.attemptKind === undefined ||
      rawValue.attemptKind === "immediate" ||
      rawValue.attemptKind === "scheduled"
    ) ||
    !(
      rawValue.notFoundRecovery === undefined ||
      rawValue.notFoundRecovery === "blocked" ||
      rawValue.notFoundRecovery === "replay" ||
      rawValue.notFoundRecovery === "restore"
    ) ||
    !(
      rawValue.resolution === undefined ||
      rawValue.resolution === "restored" ||
      rawValue.resolution === "sent"
    ) ||
    !(
      rawValue.replayClaimId === undefined ||
      (typeof rawValue.replayClaimId === "string" && rawValue.replayClaimId)
    ) ||
    typeof rawValue.clientSendId !== "string" ||
    !rawValue.clientSendId ||
    !validIsoDate(rawValue.requestedAt) ||
    !(
      rawValue.restoredSessionRevisionId === undefined ||
      (typeof rawValue.restoredSessionRevisionId === "string" &&
        rawValue.restoredSessionRevisionId)
    ) ||
    !(
      rawValue.scheduledFor === undefined ||
      rawValue.scheduledFor === null ||
      validIsoDate(rawValue.scheduledFor)
    ) ||
    !Number.isInteger(rawValue.sessionRevision) ||
    (rawValue.sessionRevision as number) < 1 ||
    !(
      rawValue.sessionRevisionId === undefined ||
      (typeof rawValue.sessionRevisionId === "string" && rawValue.sessionRevisionId)
    )
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
      ...(typeof rawIntent.recoveryPredecessorClientSendId === "string"
        ? {
            recoveryPredecessorClientSendId:
              rawIntent.recoveryPredecessorClientSendId
          }
        : {}),
      scheduledFor: rawIntent.scheduledFor,
      ...(typeof rawIntent.sessionRevisionId === "string"
        ? { sessionRevisionId: rawIntent.sessionRevisionId }
        : {}),
      threadId: rawIntent.threadId
    },
    value: {
      ...(typeof rawValue.attachmentNamespace === "string"
        ? { attachmentNamespace: rawValue.attachmentNamespace }
        : {}),
      ...(rawValue.attemptKind === "immediate" || rawValue.attemptKind === "scheduled"
        ? { attemptKind: rawValue.attemptKind }
        : {}),
      clientSendId: rawValue.clientSendId,
      ...(rawValue.notFoundRecovery === "blocked" ||
      rawValue.notFoundRecovery === "replay" ||
      rawValue.notFoundRecovery === "restore"
        ? { notFoundRecovery: rawValue.notFoundRecovery }
        : {}),
      ...(rawValue.resolution === "restored" || rawValue.resolution === "sent"
        ? { resolution: rawValue.resolution }
        : {}),
      ...(typeof rawValue.replayClaimId === "string"
        ? { replayClaimId: rawValue.replayClaimId }
        : {}),
      requestedAt: rawValue.requestedAt,
      ...(typeof rawValue.restoredSessionRevisionId === "string"
        ? { restoredSessionRevisionId: rawValue.restoredSessionRevisionId }
        : {}),
      ...(rawValue.scheduledFor === null || validIsoDate(rawValue.scheduledFor)
        ? { scheduledFor: rawValue.scheduledFor }
        : {}),
      sessionRevision: rawValue.sessionRevision as number,
      ...(typeof rawValue.sessionRevisionId === "string"
        ? { sessionRevisionId: rawValue.sessionRevisionId }
        : {})
    }
  };
}

function toLocalScheduleValue(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function composerIntentForRecovery(
  intent: ThreadComposerIntentDraft,
  kind: ThreadComposerSendAttemptKind,
  scheduledFor: string | null | undefined,
  now = Date.now()
): ThreadComposerIntentDraft {
  if (
    kind !== "scheduled" ||
    !scheduledFor ||
    !validIsoDate(scheduledFor) ||
    Date.parse(scheduledFor) <= now
  ) {
    return intent;
  }
  return {
    ...intent,
    customScheduleValue: toLocalScheduleValue(scheduledFor),
    recoveredScheduledFor: scheduledFor
  };
}

export function resolvedComposerScheduleInstant(
  customScheduleValue: string,
  recoveredScheduledFor?: string
): Date {
  if (recoveredScheduledFor && validIsoDate(recoveredScheduledFor)) {
    return new Date(recoveredScheduledFor);
  }
  return new Date(customScheduleValue);
}

export function composerRecoveryResolution(
  pending: Pick<ThreadComposerSendAttemptValue, "clientSendId">,
  completed: ThreadComposerSendAttemptValue[]
):
  | { kind: "restore"; sessionRevisionId: string }
  | { kind: "sent"; sessionRevisionId?: string }
  | null {
  let candidates = completed.filter(
    (value) => value.clientSendId === pending.clientSendId
  );
  const visited = new Set<string>();
  while (candidates.length > 0) {
    const sent = candidates.filter((value) => value.resolution !== "restored");
    const restored = candidates.filter((value) => value.resolution === "restored");
    if (sent.length > 1 || restored.length > 1) {
      return null;
    }
    const sentValue = sent[0];
    if (sentValue) {
      return {
        kind: "sent",
        ...(sentValue.sessionRevisionId
          ? { sessionRevisionId: sentValue.sessionRevisionId }
          : {})
      };
    }
    const edge = restored[0];
    if (!edge?.restoredSessionRevisionId) return null;
    const successorSessionId = edge.restoredSessionRevisionId;
    if (visited.has(successorSessionId)) return null;
    visited.add(successorSessionId);
    const successor = completed.filter(
      (value) => value.sessionRevisionId === successorSessionId
    );
    if (successor.length === 0) {
      return { kind: "restore", sessionRevisionId: successorSessionId };
    }
    candidates = successor;
  }
  return null;
}

export function recoveredComposerSessionDisposition(
  session: ThreadComposerSession,
  completed: ThreadComposerSendAttemptValue[],
  prunedBefore?: number,
  locallyTerminalClientSendIds?: ReadonlySet<string>
): "active" | "blocked" | "sent" | "superseded" {
  if (
    session.recoveryClientSendId &&
    locallyTerminalClientSendIds?.has(session.recoveryClientSendId)
  ) {
    return "sent";
  }
  const terminal = completed.find(
    (value) =>
      value.resolution !== "restored" &&
      value.sessionRevisionId === session.revisionId
  );
  if (terminal) return "sent";
  const predecessor = session.recoveryClientSendId
    ? { clientSendId: session.recoveryClientSendId }
    : completed.find(
        (value) =>
          value.resolution === "restored" &&
          value.sessionRevisionId === session.revisionId
      );
  if (!predecessor) {
    if (
      prunedBefore !== undefined &&
      (session.createdAt === undefined || session.createdAt <= prunedBefore)
    ) {
      return "blocked";
    }
    return "active";
  }
  const resolution = composerRecoveryResolution(
    predecessor,
    completed
  );
  if (!resolution) return "blocked";
  if (resolution.kind === "sent") return "sent";
  return resolution.sessionRevisionId === session.revisionId
    ? "active"
    : "superseded";
}

export function composerClientSendId(
  sessionRevisionId: string,
  kind: ThreadComposerSendAttemptKind = "immediate",
  scheduledFor: string | null = null
): string {
  return uuidv5(
    `${sessionRevisionId}:${kind}:${scheduledFor ?? ""}`,
    COMPOSER_SEND_ID_NAMESPACE
  );
}

export function shouldHideComposerSessionForAttempt(
  session: ThreadComposerSession | null,
  attempt: ThreadComposerSendAttempt | null
): boolean {
  return Boolean(
    session &&
      attempt &&
      session.revision === attempt.value.sessionRevision &&
      Boolean(attempt.value.sessionRevisionId) &&
      session.revisionId === attempt.value.sessionRevisionId &&
      attempt.intent.threadId.length > 0 &&
      sameThreadComposerIntent(session, attempt.intent.composerIntent)
  );
}

export function missingThreadComposerAttachments(
  intent: ThreadComposerIntentDraft,
  recoveredAttachmentIds: Iterable<string>
) {
  const recovered = new Set(recoveredAttachmentIds);
  return intent.attachments.filter((attachment) => !recovered.has(attachment.id));
}

export function terminalThreadComposerSendAttemptValue(
  value: ThreadComposerSendAttemptValue
): ThreadComposerSendAttemptValue {
  const successorRevisionId =
    value.resolution === "restored" ? value.restoredSessionRevisionId : undefined;
  return {
    ...value,
    resolution: "sent",
    ...(successorRevisionId ? { sessionRevisionId: successorRevisionId } : {})
  };
}

export function composerReplayPreflight(
  attempt: ThreadComposerSendAttemptIntent,
  recoveredAttachmentCount: number,
  now = Date.now()
): ComposerReplayPreflight {
  if (
    attempt.kind === "scheduled" &&
    attempt.scheduledFor &&
    Date.parse(attempt.scheduledFor) <= now
  ) {
    return {
      ok: false,
      message: "This scheduled time has passed. Your message was not queued, so choose a new time."
    };
  }
  if (recoveredAttachmentCount !== attempt.composerIntent.attachments.length) {
    return {
      ok: false,
      message: "The original attachment set is incomplete. Add the missing file again before retrying."
    };
  }
  return { ok: true };
}

export function composerDispatchFailureIsAmbiguous(
  error: unknown,
  deliveryUncertain: boolean
): boolean {
  if (deliveryUncertain) return true;
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === "number" &&
    (status === 0 || status >= 500 || (status >= 200 && status < 300))
  );
}

export function composerNotFoundRecoveryAfterDispatchFailure(
  error: unknown
): "replay" | "restore" {
  if (!error || typeof error !== "object" || !("status" in error)) return "replay";
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500
    ? "restore"
    : "replay";
}

export function composerNotFoundRecoveryOnResume(
  recovery: ThreadComposerSendAttemptValue["notFoundRecovery"]
): "replay" | "restore" {
  return recovery === "restore" ? "restore" : "replay";
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
    status.status === "CANCELLED" &&
    status.errorKind === "POLICY_BLOCKED"
  ) {
    return "retain_uncertain";
  }
  if (
    status.status === "FAILED" &&
    (status.deliveryUncertain || status.errorKind === "DELIVERY_UNCERTAIN")
  ) {
    return "retain_uncertain";
  }
  return "restore";
}

export function recoveredComposerAuthoritativeDisposition(status: {
  status: "NOT_FOUND" | "PENDING" | "SCHEDULED" | "SENT" | "FAILED" | "CANCELLED";
  deliveryUncertain?: boolean;
  errorKind?: string;
}): "blocked" | "retryable" | "sent" {
  const disposition = composerSendRecoveryDisposition(status);
  if (disposition === "cleanup" || disposition === "scheduled") return "sent";
  if (disposition === "restore") return "retryable";
  return "blocked";
}

export async function runComposerReplayRouteFence<TClaim>({
  claim,
  dispatch,
  getActiveThreadId,
  moveToReview,
  prepare,
  validateClaim,
  threadId
}: {
  claim: () => Promise<TClaim | undefined>;
  dispatch: (claimed: TClaim) => Promise<void>;
  getActiveThreadId: () => string;
  moveToReview: (claimed?: TClaim) => Promise<void>;
  prepare: (claimed: TClaim) => Promise<void>;
  validateClaim?: (claimed: TClaim) => Promise<boolean>;
  threadId: string;
}): Promise<{
  kind: "dispatched" | "not_claimed" | "off_route" | "revoked";
  claimed?: TClaim;
}> {
  if (getActiveThreadId() !== threadId) {
    await moveToReview();
    return { kind: "off_route" };
  }
  const claimed = await claim();
  if (claimed === undefined) return { kind: "not_claimed" };
  if (getActiveThreadId() !== threadId) {
    await moveToReview(claimed);
    return { kind: "off_route" };
  }
  await prepare(claimed);
  if (getActiveThreadId() !== threadId) {
    await moveToReview(claimed);
    return { kind: "off_route" };
  }
  if (validateClaim && !(await validateClaim(claimed))) {
    return { claimed, kind: "revoked" };
  }
  await dispatch(claimed);
  return { claimed, kind: "dispatched" };
}

interface SerializedComposerRecoveryQueueItem<T> {
  value: T;
  waiters: Array<{
    reject: (reason?: unknown) => void;
    resolve: (result: "queued") => void;
  }>;
}

export interface SerializedComposerRecoveryState<T> {
  active: boolean;
  queued: Map<string, SerializedComposerRecoveryQueueItem<T>>;
}

export function createSerializedComposerRecoveryState<T>(): SerializedComposerRecoveryState<T> {
  return { active: false, queued: new Map() };
}

export async function runSerializedComposerRecovery<T>({
  key,
  run,
  state,
  value
}: {
  key: string;
  run: (value: T, wasQueued: boolean) => Promise<void>;
  state: SerializedComposerRecoveryState<T>;
  value: T;
}): Promise<"processed" | "queued"> {
  if (state.active) {
    return new Promise((resolve, reject) => {
      const existing = state.queued.get(key);
      if (existing) {
        existing.value = value;
        existing.waiters.push({ reject, resolve });
      } else {
        state.queued.set(key, {
          value,
          waiters: [{ reject, resolve }]
        });
      }
    });
  }

  state.active = true;
  let activeError: unknown;
  try {
    try {
      await run(value, false);
    } catch (error) {
      activeError = error;
    }
    let next = state.queued.entries().next().value as
      | [string, SerializedComposerRecoveryQueueItem<T>]
      | undefined;
    while (next) {
      state.queued.delete(next[0]);
      const queued = next[1];
      try {
        await run(queued.value, true);
        for (const waiter of queued.waiters) waiter.resolve("queued");
      } catch (error) {
        for (const waiter of queued.waiters) waiter.reject(error);
      }
      next = state.queued.entries().next().value as typeof next;
    }
  } finally {
    state.active = false;
  }
  if (activeError) throw activeError;
  return "processed";
}

export function terminalComposerReceiptRetention(
  status: "SENT" | "SCHEDULED"
): { message: string; terminalStatus: "SENT" | "SCHEDULED" } {
  return status === "SCHEDULED"
    ? {
        message:
          "Tovi confirmed this reply is scheduled, but could not save the local safety record. Sending stays blocked while Tovi retries.",
        terminalStatus: status
      }
    : {
        message:
          "Tovi confirmed this reply was sent, but could not save the local safety record. Sending stays blocked while Tovi retries.",
        terminalStatus: status
      };
}

export async function runRecoveredSuccessorDispatchFence<T>({
  canDispatch,
  dispatch,
  release
}: {
  canDispatch: () => boolean;
  dispatch: () => Promise<T>;
  release: () => Promise<void>;
}): Promise<
  | { kind: "dispatched"; value: T }
  | { kind: "superseded" }
  | { kind: "superseded_release_failed" }
> {
  if (!canDispatch()) {
    try {
      await release();
      return { kind: "superseded" };
    } catch {
      return { kind: "superseded_release_failed" };
    }
  }
  return { kind: "dispatched", value: await dispatch() };
}
