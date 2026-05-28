/**
 * Wire protocol for the opt-in iMessage private-API helper (#273).
 *
 * The runner speaks newline-delimited JSON (NDJSON) over a UNIX domain
 * socket to an external helper bundle injected into Messages.app. Each
 * request is a single JSON object terminated by "\n"; the helper replies
 * with exactly one JSON object terminated by "\n", correlated by `id`.
 *
 * This file is the single source of truth for that contract. The external
 * Swift connector (which lives OUTSIDE this repo) and the local mock helper
 * under tools/mock-imessage-helper/ both implement it.
 *
 * Design notes:
 * - One request → one response. We open a short-lived connection per
 *   request (see helper-bridge.ts), so there is no need to multiplex more
 *   than one in-flight request over a single socket. The `id` is still sent
 *   so the helper can echo it back and we can assert we got the right reply.
 * - Errors are structured with a stable `code` so the caller can branch.
 *   In particular `unsupported_kind` lets newer tapback kinds (iOS 18+
 *   expanded emoji) degrade cleanly to the fallback path instead of looking
 *   like a hard failure.
 */

/** Bumped when the request/response shape changes incompatibly. */
export const PRIVATE_API_PROTOCOL_VERSION = 1;

export type PrivateApiOp = "ping" | "sendThreadedReply" | "sendTapback";

/** The six native tapback kinds Messages.app has always supported. */
export type TapbackKind =
  | "heart"
  | "like"
  | "dislike"
  | "laugh"
  | "emphasize"
  | "question";

export type TapbackAction = "add" | "remove";

export interface PingParams {
  // Intentionally empty — ping carries no input.
  [k: string]: never;
}

export interface SendThreadedReplyParams {
  /** Apple chat GUID (our Thread.platformThreadId for iMessage). */
  chatGuid: string;
  /** Apple message GUID of the parent being replied to. */
  parentMessageGuid: string;
  text: string;
}

export interface SendTapbackParams {
  chatGuid: string;
  /** Apple message GUID of the message being reacted to. */
  targetMessageGuid: string;
  kind: TapbackKind;
  action: TapbackAction;
}

export interface OpParams {
  ping: PingParams;
  sendThreadedReply: SendThreadedReplyParams;
  sendTapback: SendTapbackParams;
}

export interface PingResult {
  /** Helper build identifier, surfaced in logs for debugging. */
  helper?: string;
  /** Protocol version the helper implements. */
  protocol?: number;
  /**
   * Optional capability hints. When the helper knows it cannot service a
   * given tapback kind on the current macOS / Messages.app build it can
   * advertise that here; callers may also just attempt the send and handle
   * `unsupported_kind`.
   */
  capabilities?: {
    tapbackKinds?: TapbackKind[];
    threadedReply?: boolean;
  };
}

export interface SendThreadedReplyResult {
  /** Apple message GUID assigned to the sent reply, when the helper knows it. */
  messageGuid?: string;
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface SendTapbackResult {
  /** No payload today; reserved for future delivery metadata. */
  messageGuid?: string;
}

export interface OpResult {
  ping: PingResult;
  sendThreadedReply: SendThreadedReplyResult;
  sendTapback: SendTapbackResult;
}

export interface PrivateApiRequest<Op extends PrivateApiOp = PrivateApiOp> {
  id: string;
  op: Op;
  params: OpParams[Op];
}

/** Stable, machine-branchable error codes the helper may return. */
export type PrivateApiErrorCode =
  | "unsupported_op"
  | "unsupported_kind"
  | "invalid_params"
  | "not_found"
  | "send_failed"
  | "internal";

export interface PrivateApiErrorPayload {
  code: PrivateApiErrorCode;
  message: string;
}

export type PrivateApiResponse<Op extends PrivateApiOp = PrivateApiOp> =
  | { id: string; ok: true; result: OpResult[Op] }
  | { id: string; ok: false; error: PrivateApiErrorPayload };

/** Serialize a request as a single NDJSON line (including the trailing "\n"). */
export function encodeRequest(req: PrivateApiRequest): string {
  return `${JSON.stringify(req)}\n`;
}

/**
 * Parse one NDJSON response line. Throws a TypeError when the payload is not
 * a shaped PrivateApiResponse so callers never act on a malformed reply.
 */
export function decodeResponse(line: string): PrivateApiResponse {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new TypeError("empty response line");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new TypeError(`response is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new TypeError("response is not an object");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    throw new TypeError("response missing string id");
  }
  if (obj.ok === true) {
    return { id: obj.id, ok: true, result: (obj.result ?? {}) as OpResult[PrivateApiOp] };
  }
  if (obj.ok === false) {
    const error = obj.error as Record<string, unknown> | undefined;
    const code = (error?.code as PrivateApiErrorCode) ?? "internal";
    const message = typeof error?.message === "string" ? error.message : "helper error";
    return { id: obj.id, ok: false, error: { code, message } };
  }
  throw new TypeError("response missing boolean ok");
}

/** A failed helper call, carrying the structured code so callers can branch. */
export class PrivateApiError extends Error {
  readonly code: PrivateApiErrorCode | "transport";
  constructor(code: PrivateApiErrorCode | "transport", message: string) {
    super(message);
    this.name = "PrivateApiError";
    this.code = code;
  }
}
