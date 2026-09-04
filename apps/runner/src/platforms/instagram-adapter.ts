import type { BrowserContext, ElementHandle, JSHandle, Locator, Page } from "patchright";
import {
  stableHash,
  type NormalizedMessage,
  type OutboundAttachment,
  type PlatformCollectionBoundaryCapability,
  type SelectorRegistry,
  type SendReceipt,
  type ThreadStub
} from "@inbox-os/core";
import { BetaAdapter, type BetaAdapterDependencies } from "./beta-adapter";
import { ChromeCookieBridge } from "./chrome-cookie-bridge";
import { AdapterFailure, cleanMessageText } from "./utils";
import { humanClick, humanType, readingPause } from "./humanize";
import { sanitizePlatformDiagnosticValue } from "../services/platform-diagnostics";

const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const THREAD_PATH = /^\/direct\/t\/([^/?#]+)\/?$/i;
const INSTAGRAM_TEXT_SEND_OPERATION = "IGDirectTextSendMutation";
const INSTAGRAM_TEXT_SEND_DOC_ID = "26911679871773184";
const INSTAGRAM_TEXT_SEND_RESPONSE_FIELD =
  "xig_direct_text_send_with_slide_messaging_response";
const INSTAGRAM_ACK_TIMESTAMP_TOLERANCE_MS = 5_000;
const INSTAGRAM_RUNTIME_SHIM_SOURCE =
  "globalThis.__name=globalThis.__name||function(n){return n;};" +
  "globalThis.__defProp=globalThis.__defProp||Object.defineProperty;";

export interface InstagramAdapterDependencies extends Omit<BetaAdapterDependencies, "platform"> {
  connectTimeoutMs: number;
  sendVerificationTimeoutMs?: number;
  syncPersonalSessionCookies?: (context: BrowserContext) => Promise<boolean>;
  personalProfile?: {
    sourceUserDataDir: string;
    profileDirectory: string;
  };
}

export interface InstagramThreadSnapshot {
  href?: string;
  stableId?: string;
  displayName?: string;
  preview?: string;
  unread?: boolean;
}

export type InstagramDirectionEvidence = "IN" | "OUT" | "AMBIGUOUS";

export interface InstagramMessageSnapshot {
  nativeId?: string;
  nativeIdStable?: boolean;
  offlineThreadingId?: string;
  direction: InstagramDirectionEvidence;
  text?: string;
  senderName?: string;
  sourceTimestamp?: string;
  mediaKind?: "photo" | "video" | "voice_message" | "attachment" | "unsupported";
  deleted?: boolean;
}

interface InstagramComposerSendBinding {
  button: ElementHandle;
  owner: ElementHandle;
  conversationContainer: ElementHandle;
  composerPath: ElementHandle[];
  sendPath: ElementHandle[];
  ownerDocumentPath: ElementHandle[];
}

interface InstagramComposerOwnershipBinding {
  conversationContainer: ElementHandle;
  documentPath: ElementHandle[];
}

export class InstagramParsingError extends Error {
  constructor(readonly reason: string) {
    super(`Instagram parsing failed: ${reason}`);
    this.name = "InstagramParsingError";
  }
}

export function classifyInstagramThreadCollectionError(error: unknown): string {
  if (error instanceof InstagramParsingError) {
    return error.reason;
  }
  const message = error instanceof Error ? error.message : "";
  if (/__name is not defined/i.test(message)) {
    return "browser_runtime_shim_missing";
  }
  if (/execution context was destroyed|target page, context or browser has been closed/i.test(message)) {
    return "browser_context_changed";
  }
  if (/not a valid selector|failed to execute ['\"]querySelector/i.test(message)) {
    return "thread_selector_invalid";
  }
  if (/could not serialize|unexpected value/i.test(message)) {
    return "thread_snapshot_serialization_failed";
  }
  return "thread_collection_failed";
}

export type InstagramAuthRequirement = "login_required" | "verification_required";

export function classifyInstagramAuthRequirement(input: {
  url: string;
  fieldNames?: string[];
  bodyText?: string;
  hasRecaptcha?: boolean;
}): InstagramAuthRequirement | null {
  if (
    /\/auth_platform\/recaptcha/i.test(input.url) ||
    input.hasRecaptcha ||
    /i['’]?m not a robot|security check|recaptcha/i.test(input.bodyText ?? "")
  ) {
    return "verification_required";
  }
  if (/\/accounts\/login/i.test(input.url)) {
    return "login_required";
  }
  const fields = new Set((input.fieldNames ?? []).map((value) => value.toLowerCase()));
  if (
    fields.has("email") ||
    fields.has("pass") ||
    fields.has("username") ||
    fields.has("password")
  ) {
    return "login_required";
  }
  return /log in to instagram/i.test(input.bodyText ?? "") ? "login_required" : null;
}

export function instagramAuthRequiredFromSignals(input: {
  url: string;
  fieldNames?: string[];
  bodyText?: string;
  hasRecaptcha?: boolean;
}): boolean {
  return classifyInstagramAuthRequirement(input) !== null;
}

export function instagramThreadIdFromUrl(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  try {
    const url = new URL(value, INSTAGRAM_ORIGIN);
    if (url.hostname !== "www.instagram.com" && url.hostname !== "instagram.com") {
      return null;
    }
    const match = url.pathname.match(THREAD_PATH);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function isStableInstagramId(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9._=-]+$/.test(value));
}

export function canonicalInstagramThreadUrl(platformThreadId: string): string {
  if (!isStableInstagramId(platformThreadId)) {
    throw new InstagramParsingError("invalid_thread_id");
  }
  return `${INSTAGRAM_ORIGIN}/direct/t/${encodeURIComponent(platformThreadId)}/`;
}

export function normalizeInstagramThreadSnapshots(
  snapshots: InstagramThreadSnapshot[]
): ThreadStub[] {
  const byId = new Map<string, ThreadStub>();

  for (const snapshot of snapshots) {
    const hrefId = instagramThreadIdFromUrl(snapshot.href);
    const stableId = isStableInstagramId(snapshot.stableId) ? snapshot.stableId : null;
    if (hrefId && stableId && hrefId !== stableId) {
      throw new InstagramParsingError("thread_identity_mismatch");
    }
    const platformThreadId = hrefId ?? stableId;
    if (!platformThreadId) {
      throw new InstagramParsingError("thread_missing_stable_identity");
    }

    const existing = byId.get(platformThreadId);
    const recipientVerificationLabel = snapshot.displayName?.replace(/\s+/g, " ").trim() || undefined;
    const displayName = recipientVerificationLabel || "Instagram conversation";
    const candidate: ThreadStub = {
      platformThreadId,
      displayName,
      recipientVerificationLabel,
      unreadCount: snapshot.unread ? 1 : 0,
      lastMessagePreview: snapshot.preview?.replace(/\s+/g, " ").trim().slice(0, 220) ?? "",
      threadUrl: canonicalInstagramThreadUrl(platformThreadId)
    };

    if (!existing) {
      byId.set(platformThreadId, candidate);
      continue;
    }

    byId.set(platformThreadId, {
      ...existing,
      unreadCount: Math.max(existing.unreadCount ?? 0, candidate.unreadCount ?? 0),
      displayName:
        existing.displayName === "Instagram conversation" ? candidate.displayName : existing.displayName,
      recipientVerificationLabel:
        candidate.recipientVerificationLabel ?? existing.recipientVerificationLabel,
      lastMessagePreview: existing.lastMessagePreview || candidate.lastMessagePreview
    });
  }

  return [...byId.values()];
}

export function mergeInstagramThreadSnapshotSources(input: {
  networkSnapshots: InstagramThreadSnapshot[];
  domSnapshots: InstagramThreadSnapshot[];
  limit: number;
}): ThreadStub[] {
  const distinctThreads = normalizeInstagramThreadSnapshots([
    ...input.domSnapshots,
    ...input.networkSnapshots
  ]);
  return [
    ...distinctThreads.filter((thread) => (thread.unreadCount ?? 0) > 0),
    ...distinctThreads.filter((thread) => (thread.unreadCount ?? 0) === 0)
  ].slice(0, Math.max(0, input.limit));
}

export function resolveInstagramCollectionStopReason(input: {
  collectionCalls: number;
  observedRows: boolean;
  explicitlyEmpty: boolean;
}): "zero_threads_found" | "instagram_bounded_snapshot" {
  return input.collectionCalls > 0 && !input.observedRows && input.explicitlyEmpty
    ? "zero_threads_found"
    : "instagram_bounded_snapshot";
}

function instagramRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function instagramString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function instagramGraphQlPayloadHasErrors(payload: unknown): boolean {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.some((entry) => {
    const record = instagramRecord(entry);
    return Boolean(record && Array.isArray(record.errors) && record.errors.length > 0);
  });
}

export interface InstagramTextSendMutationRequest {
  offlineThreadingId: string;
}

export interface InstagramTextSendMutationResponse {
  messageId: string;
  timestampMs?: string;
}

export function extractInstagramTextSendMutationRequest(input: {
  url: string;
  method: string;
  postData: string | null;
  expectedThreadId: string;
  expectedText: string;
}): InstagramTextSendMutationRequest | null {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if (
    input.method.toUpperCase() !== "POST" ||
    (url.hostname !== "www.instagram.com" && url.hostname !== "instagram.com") ||
    !/\/api\/graphql\/?$|\/graphql\/query\/?$/i.test(url.pathname) ||
    !input.postData
  ) {
    return null;
  }

  const fields = new URLSearchParams(input.postData);
  if (
    fields.get("fb_api_req_friendly_name") !== INSTAGRAM_TEXT_SEND_OPERATION ||
    fields.get("doc_id") !== INSTAGRAM_TEXT_SEND_DOC_ID
  ) {
    return null;
  }

  const serializedVariables = fields.get("variables");
  if (!serializedVariables) {
    return null;
  }
  let variables: Record<string, unknown> | null;
  try {
    variables = instagramRecord(JSON.parse(serializedVariables));
  } catch {
    return null;
  }
  if (!variables) {
    return null;
  }
  const threadId = instagramString(variables, ["ig_thread_igid"]);
  const text = instagramString(instagramRecord(variables.text) ?? {}, [
    "sensitive_string_value"
  ]);
  const offlineThreadingId = instagramString(variables, ["offline_threading_id"]);
  if (
    threadId !== input.expectedThreadId ||
    cleanMessageText(text ?? "") !== cleanMessageText(input.expectedText) ||
    !offlineThreadingId
  ) {
    return null;
  }
  return { offlineThreadingId };
}

export function extractInstagramTextSendMutationResponse(
  payload: unknown
): InstagramTextSendMutationResponse | null {
  if (instagramGraphQlPayloadHasErrors(payload)) {
    return null;
  }
  const matches: InstagramTextSendMutationResponse[] = [];
  for (const entry of Array.isArray(payload) ? payload : [payload]) {
    const data = instagramRecord(instagramRecord(entry)?.data);
    const mutation = instagramRecord(data?.[INSTAGRAM_TEXT_SEND_RESPONSE_FIELD]);
    const messageId = instagramString(mutation ?? {}, ["message_id"]);
    if (!messageId) {
      continue;
    }
    const match: InstagramTextSendMutationResponse = { messageId };
    const timestampMs = instagramString(mutation ?? {}, ["timestamp_ms"]);
    if (timestampMs !== undefined) match.timestampMs = timestampMs;
    matches.push(match);
  }
  if (matches.length !== 1) {
    return null;
  }
  return matches[0]!;
}

export interface InstagramRealtimeTextSend {
  offlineThreadingId: string;
}

function embeddedJsonObjectAt(source: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character !== "}") {
      continue;
    }
    depth -= 1;
    if (depth !== 0) {
      continue;
    }
    try {
      return instagramRecord(JSON.parse(source.slice(start, index + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

export function extractInstagramRealtimeTextSend(input: {
  frame: string | Uint8Array;
  expectedThreadId: string;
  expectedText: string;
}): InstagramRealtimeTextSend | null {
  const source =
    typeof input.frame === "string"
      ? input.frame
      : Buffer.from(input.frame).toString("utf8");
  const marker = '"action":"send_item"';
  const matches: InstagramRealtimeTextSend[] = [];
  let offset = 0;
  while (offset < source.length) {
    const markerIndex = source.indexOf(marker, offset);
    if (markerIndex < 0) break;
    const objectStart = source.lastIndexOf("{", markerIndex);
    const record = objectStart >= 0 ? embeddedJsonObjectAt(source, objectStart) : null;
    const clientContext = instagramString(record ?? {}, ["client_context"]);
    const mutationToken = instagramString(record ?? {}, ["mutation_token"]);
    if (
      record?.action === "send_item" &&
      record.item_type === "text" &&
      instagramString(record, ["thread_id"]) === input.expectedThreadId &&
      cleanMessageText(instagramString(record, ["text"]) ?? "") ===
        cleanMessageText(input.expectedText) &&
      clientContext &&
      mutationToken === clientContext
    ) {
      matches.push({ offlineThreadingId: clientContext });
    }
    offset = markerIndex + marker.length;
  }
  return matches.length === 1 ? matches[0]! : null;
}

export function extractInstagramThreadSnapshotsFromPayload(
  payload: unknown
): InstagramThreadSnapshot[] {
  const snapshots: InstagramThreadSnapshot[] = [];
  const seen = new WeakSet<object>();
  let visited = 0;

  const visit = (
    value: unknown,
    context: {
      inInboxPayload: boolean;
      inThreadCollection: boolean;
      insideThreadRecord: boolean;
      path: string[];
    }
  ): void => {
    if (!value || typeof value !== "object" || seen.has(value) || visited >= 25_000) {
      return;
    }
    seen.add(value);
    visited += 1;
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, context);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const typeName = instagramString(record, ["__typename", "type", "item_type"]);
    const wrappedDirectThread =
      typeName === "SlideThread" ? instagramRecord(record.as_ig_direct_thread) : null;
    const threadRecord = wrappedDirectThread ?? record;
    const directThreadTypeName = instagramString(threadRecord, [
      "__typename",
      "type",
      "item_type"
    ]);
    const hasDirectThreadType = /direct.*thread/i.test(directThreadTypeName ?? "");
    const hasThreadStructure = [
      "thread_title",
      "usersWithoutViewer",
      "slide_messages",
      "users",
      "participants",
      "unread_count",
      "unreadCount",
      "has_unread",
      "hasUnread",
      "marked_as_unread"
    ].some((key) => key in threadRecord);
    const isWrappedSlideThread = Boolean(wrappedDirectThread) && hasThreadStructure;
    const isThreadRecord =
      context.inThreadCollection &&
      (isWrappedSlideThread || hasDirectThreadType || (!directThreadTypeName && hasThreadStructure));
    const typedThreadId = isThreadRecord
      ? instagramString(threadRecord, ["id"])
      : undefined;
    const stableId = typedThreadId;
    if (isStableInstagramId(stableId)) {
      const participants = [
        threadRecord.users,
        threadRecord.participants,
        threadRecord.usersWithoutViewer
      ]
        .flatMap((candidate) => (Array.isArray(candidate) ? candidate : []))
        .map(instagramRecord)
        .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate))
        .map((candidate) =>
          instagramString(candidate, ["username", "full_name", "fullName", "name"])
        )
        .filter((candidate): candidate is string => Boolean(candidate));
      const unreadCount = [threadRecord.unread_count, threadRecord.unreadCount].find(
        (candidate) => typeof candidate === "number" && Number.isFinite(candidate)
      ) as number | undefined;
      const explicitUnread = [
        threadRecord.unread,
        threadRecord.has_unread,
        threadRecord.hasUnread,
        threadRecord.marked_as_unread,
        threadRecord.markedAsUnread
      ].find((candidate) => typeof candidate === "boolean") as boolean | undefined;
      const readState = instagramString(threadRecord, ["read_state", "readState"]);
      const unread =
        typeof unreadCount === "number"
          ? unreadCount > 0
          : typeof explicitUnread === "boolean"
            ? explicitUnread
            : readState && /unread/i.test(readState)
              ? true
              : undefined;
      snapshots.push({
        stableId,
        displayName:
          instagramString(threadRecord, ["thread_title", "threadTitle", "title", "name"]) ??
          (participants.slice(0, 3).join(", ") || undefined),
        unread
      });
    }

    for (const [key, child] of Object.entries(record)) {
      const childPath = [...context.path, key];
      const inInboxPayload = context.inInboxPayload || /inbox/i.test(key);
      const isCanonicalSlideMailboxEdges =
        Array.isArray(child) &&
        childPath.join(".") ===
          "data.get_slide_mailbox_for_iris_subscription.threads_by_folder.edges";
      const startsThreadCollection =
        !context.inThreadCollection &&
        !context.insideThreadRecord &&
        Array.isArray(child) &&
        (isCanonicalSlideMailboxEdges ||
          (inInboxPayload && /(?:^|_)threads?(?:$|_)/i.test(key)));
      visit(child, {
        inInboxPayload,
        inThreadCollection:
          startsThreadCollection ||
          (context.inThreadCollection && /^(?:node|item|thread)$/i.test(key)),
        insideThreadRecord: context.insideThreadRecord || isThreadRecord,
        path: childPath
      });
    }
  };

  visit(payload, {
    inInboxPayload: false,
    inThreadCollection: false,
    insideThreadRecord: false,
    path: []
  });
  return snapshots;
}

export interface InstagramMessagePayloadExtraction {
  matchedThread: boolean;
  explicitlyEmpty: boolean;
  recipientVerificationLabel?: string;
  snapshots: InstagramMessageSnapshot[];
}

export function extractInstagramMessageSnapshotsFromPayload(
  payload: unknown,
  expectedThreadId: string
): InstagramMessagePayloadExtraction {
  const snapshots: InstagramMessageSnapshot[] = [];
  let matchedThread = false;
  let recipientVerificationLabel: string | undefined;

  for (const entry of Array.isArray(payload) ? payload : [payload]) {
    const data = instagramRecord(entry)?.data;
    const detail = instagramRecord(instagramRecord(data)?.get_slide_thread_nullable);
    const directThread = instagramRecord(detail?.as_ig_direct_thread);
    if (instagramString(directThread ?? {}, ["id"]) !== expectedThreadId) {
      continue;
    }
    const edges = instagramRecord(directThread?.slide_messages)?.edges;
    if (!Array.isArray(edges)) {
      continue;
    }

    matchedThread = true;
    recipientVerificationLabel ??= instagramString(directThread ?? {}, ["thread_title"]);
    const viewerId = instagramString(directThread ?? {}, ["viewer_id"]);
    for (const edge of edges) {
      const node = instagramRecord(instagramRecord(edge)?.node);
      if (instagramString(node ?? {}, ["__typename"]) !== "SlideMessage") {
        continue;
      }
      const nativeId = instagramString(node ?? {}, ["message_id"]);
      if (!nativeId) {
        throw new InstagramParsingError("message_missing_stable_identity");
      }
      const sender = instagramRecord(node?.sender);
      const senderUser = instagramRecord(sender?.user_dict);
      const senderIds = [
        instagramString(senderUser ?? {}, ["id"]),
        instagramString(sender ?? {}, ["igid"])
      ].filter((candidate): candidate is string => Boolean(candidate));
      const direction: InstagramDirectionEvidence =
        viewerId && senderIds.length > 0
          ? senderIds.includes(viewerId)
            ? "OUT"
            : "IN"
          : "AMBIGUOUS";
      const content = instagramRecord(node?.content);
      const text =
        instagramString(node ?? {}, ["text_body"]) ??
        instagramString(content ?? {}, ["text_body"]);
      const contentType = instagramString(content ?? {}, ["__typename"]) ?? "";
      const mediaKind: InstagramMessageSnapshot["mediaKind"] = text
        ? undefined
        : /voice|audio/i.test(contentType)
          ? "voice_message"
          : /video/i.test(contentType)
            ? "video"
            : /photo|image/i.test(contentType)
              ? "photo"
              : /xma/i.test(contentType)
                ? "attachment"
                : "unsupported";
      const tombstoneReason = instagramString(node ?? {}, ["tombstone_reason"]);
      const snapshot: InstagramMessageSnapshot = {
        nativeId,
        nativeIdStable: true,
        direction,
        sourceTimestamp: instagramString(node ?? {}, ["timestamp_ms"])
      };
      const offlineThreadingId = instagramString(node ?? {}, ["offline_threading_id"]);
      if (offlineThreadingId !== undefined) {
        snapshot.offlineThreadingId = offlineThreadingId;
      }
      if (text !== undefined) snapshot.text = text;
      const senderName = instagramString(sender ?? {}, ["name"]);
      if (senderName !== undefined) snapshot.senderName = senderName;
      if (mediaKind !== undefined) snapshot.mediaKind = mediaKind;
      if (tombstoneReason !== undefined) snapshot.deleted = true;
      snapshots.push(snapshot);
    }
  }

  const result: InstagramMessagePayloadExtraction = {
    matchedThread,
    explicitlyEmpty: false,
    snapshots
  };
  if (recipientVerificationLabel !== undefined) {
    result.recipientVerificationLabel = recipientVerificationLabel;
  }
  return result;
}

export function parseInstagramSourceTimestamp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const epoch = /^(?:\d{10}|\d{13})$/.test(trimmed) ? Number(trimmed) : null;
  const parsed = epoch === null
    ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)
      ? new Date(trimmed)
      : new Date(Number.NaN)
    : new Date(trimmed.length === 10 ? epoch * 1_000 : epoch);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function instagramThreadUrlMatches(url: string, expectedThreadId: string): boolean {
  return instagramThreadIdFromUrl(url) === expectedThreadId;
}

export function findNewAcknowledgedInstagramOutgoing(
  before: NormalizedMessage[],
  after: NormalizedMessage[],
  text: string,
  dispatchedAtMs: number,
  observedAtMs = Date.now(),
  clockSkewMs = 0,
  expectedPlatformMessageKey?: string,
  expectedOfflineThreadingId?: string,
  expectedAcknowledgedTimestampMs?: string
): NormalizedMessage | null {
  const normalizedText = cleanMessageText(text);
  const knownMessageKeys = new Set(
    before.map((message) => message.platformMessageKey).filter(Boolean)
  );
  const earliestAcceptedTimestamp = dispatchedAtMs - Math.max(0, clockSkewMs);
  const latestAcceptedTimestamp = observedAtMs + Math.max(0, clockSkewMs);
  const causallyBoundToCurrentDispatch = Boolean(expectedOfflineThreadingId);
  const acknowledgedTimestamp = expectedAcknowledgedTimestampMs
    ? Date.parse(parseInstagramSourceTimestamp(expectedAcknowledgedTimestampMs) ?? "")
    : null;

  return (
    after.find((message) => {
      if (
        message.direction !== "OUT" ||
        cleanMessageText(message.text) !== normalizedText ||
        !message.platformMessageKey ||
        knownMessageKeys.has(message.platformMessageKey) ||
        (expectedPlatformMessageKey !== undefined &&
          message.platformMessageKey !== expectedPlatformMessageKey) ||
        (expectedOfflineThreadingId !== undefined &&
          message.raw?.instagramOfflineThreadingId !== expectedOfflineThreadingId) ||
        !message.timestamp
      ) {
        return false;
      }
      const sourceTimestamp = Date.parse(message.timestamp);
      if (causallyBoundToCurrentDispatch) {
        // The outbound offline ID binds this readback to the captured relay or
        // realtime dispatch. Compare server timestamps to each other when the
        // relay supplies one, not to the local clock. The caller's deadline
        // bounds the readback.
        return (
          Number.isFinite(sourceTimestamp) &&
          observedAtMs >= dispatchedAtMs &&
          (acknowledgedTimestamp === null ||
            (Number.isFinite(acknowledgedTimestamp) &&
              Math.abs(sourceTimestamp - acknowledgedTimestamp) <=
                INSTAGRAM_ACK_TIMESTAMP_TOLERANCE_MS))
        );
      }
      return (
        Number.isFinite(sourceTimestamp) &&
        sourceTimestamp >= earliestAcceptedTimestamp &&
        sourceTimestamp <= latestAcceptedTimestamp
      );
    }) ?? null
  );
}

export function instagramMessageFallbackKey(
  platformThreadId: string,
  direction: "IN" | "OUT",
  text: string,
  attachmentType: string | undefined,
  occurrence: number
): string {
  const signature = [direction, cleanMessageText(text), attachmentType ?? ""].join("\u001f");
  return `instagram:${stableHash(
    [platformThreadId, signature, String(occurrence)].join("\u001e")
  )}`;
}

function instagramStableMessageKey(
  platformThreadId: string,
  evidence: "native" | "timestamp",
  identity: string
): string {
  return `instagram:${stableHash(
    [platformThreadId, evidence, identity].join("\u001e")
  )}`;
}

function placeholderForSnapshot(snapshot: InstagramMessageSnapshot): {
  text: string;
  attachmentType?: string;
} {
  if (snapshot.deleted) {
    return { text: "[Deleted Instagram message]", attachmentType: "deleted_message" };
  }
  if (snapshot.mediaKind === "photo") {
    return { text: "[Instagram photo]", attachmentType: "photo" };
  }
  if (snapshot.mediaKind === "video") {
    return { text: "[Instagram video]", attachmentType: "video" };
  }
  if (snapshot.mediaKind === "voice_message") {
    return { text: "[Instagram voice message]", attachmentType: "voice_message" };
  }
  if (snapshot.mediaKind === "attachment") {
    return { text: "[Instagram attachment]", attachmentType: "attachment" };
  }
  return { text: "[Unsupported Instagram message]", attachmentType: "unsupported" };
}

export function normalizeInstagramMessageSnapshots(
  platformThreadId: string,
  snapshots: InstagramMessageSnapshot[]
): NormalizedMessage[] {
  const prepared = snapshots.map((snapshot) => {
    if (snapshot.direction === "AMBIGUOUS") {
      throw new InstagramParsingError("ambiguous_message_direction");
    }
    const sourceTimestamp = parseInstagramSourceTimestamp(snapshot.sourceTimestamp);
    const cleanedText = cleanMessageText(snapshot.text ?? "");
    const placeholder =
      snapshot.deleted || snapshot.mediaKind || !cleanedText
        ? placeholderForSnapshot(snapshot)
        : undefined;
    const text = snapshot.deleted ? placeholder!.text : cleanedText || placeholder!.text;
    const senderName = snapshot.senderName?.replace(/\s+/g, " ").trim() || undefined;
    const signature = [snapshot.direction, text, placeholder?.attachmentType ?? ""].join("\u001f");
    return { snapshot, sourceTimestamp, text, senderName, placeholder, signature };
  });

  const unresolvedIdentityCounts = new Map<string, number>();
  const timestampIdentityCounts = new Map<string, number>();
  for (const item of prepared) {
    const nativeId = item.snapshot.nativeId?.trim();
    if (item.snapshot.nativeIdStable && nativeId) {
      continue;
    }
    if (item.sourceTimestamp) {
      const timestampIdentity = [item.sourceTimestamp, item.signature].join("\u001e");
      timestampIdentityCounts.set(
        timestampIdentity,
        (timestampIdentityCounts.get(timestampIdentity) ?? 0) + 1
      );
      continue;
    }
    unresolvedIdentityCounts.set(
      item.signature,
      (unresolvedIdentityCounts.get(item.signature) ?? 0) + 1
    );
  }
  if ([...timestampIdentityCounts.values()].some((count) => count > 1)) {
    throw new InstagramParsingError("ambiguous_message_identity");
  }
  if ([...unresolvedIdentityCounts.values()].some((count) => count > 1)) {
    throw new InstagramParsingError("ambiguous_message_identity");
  }
  if (unresolvedIdentityCounts.size > 0) {
    throw new InstagramParsingError("message_missing_stable_identity");
  }

  const seenKeys = new Set<string>();
  const seenStableNativeIds = new Set<string>();
  const legacyOccurrences = new Map<string, number>();
  const messages: NormalizedMessage[] = [];

  for (let index = 0; index < prepared.length; index += 1) {
    const item = prepared[index]!;
    const nativeId = item.snapshot.nativeId?.trim();
    if (item.snapshot.nativeIdStable && nativeId) {
      if (seenStableNativeIds.has(nativeId)) {
        continue;
      }
      seenStableNativeIds.add(nativeId);
    }
    const legacyOccurrence = legacyOccurrences.get(item.signature) ?? 0;
    legacyOccurrences.set(item.signature, legacyOccurrence + 1);
    const legacyCandidateKey = instagramMessageFallbackKey(
      platformThreadId,
      item.snapshot.direction as "IN" | "OUT",
      item.text,
      item.placeholder?.attachmentType,
      legacyOccurrence
    );
    const key =
      item.snapshot.nativeIdStable && nativeId
        ? instagramStableMessageKey(platformThreadId, "native", nativeId)
        : item.sourceTimestamp
          ? instagramStableMessageKey(
              platformThreadId,
              "timestamp",
              [item.sourceTimestamp, item.signature].join("\u001e")
            )
          : (() => {
              throw new InstagramParsingError("message_missing_stable_identity");
            })();

    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    messages.push({
      platformMessageKey: key,
      platformMessageKeyMigration: {
        scheme: "instagram_occurrence_v1",
        candidateKey: legacyCandidateKey
      },
      direction: item.snapshot.direction as "IN" | "OUT",
      timestamp: item.sourceTimestamp,
      text: item.text,
      senderName: item.senderName,
      raw: {
        timestampSource: item.sourceTimestamp ? "source" : "first_seen",
        contentKind: item.placeholder?.attachmentType ?? "text",
        messageIdentityVersion: "instagram_stable_v2",
        instagramOfflineThreadingId: item.snapshot.offlineThreadingId
      },
      attachments: item.placeholder?.attachmentType
        ? [
            {
              type: item.placeholder.attachmentType,
              kind:
                item.placeholder.attachmentType === "photo"
                  ? "photo"
                  : item.placeholder.attachmentType === "video"
                    ? "video"
                    : item.placeholder.attachmentType === "voice_message"
                      ? "voice_note"
                      : "unknown",
              manualReview: true
            }
          ]
        : []
    });
  }

  return messages;
}

function threadIdForStub(thread: ThreadStub): string {
  const fromUrl = instagramThreadIdFromUrl(thread.threadUrl);
  if (thread.threadUrl?.trim() && !fromUrl) {
    throw new InstagramParsingError("invalid_thread_url");
  }
  const fromPlatformUrl = instagramThreadIdFromUrl(thread.platformThreadId);
  const fromPlatformId = fromPlatformUrl ??
    (isStableInstagramId(thread.platformThreadId) ? thread.platformThreadId : null);
  if (!fromPlatformId) {
    throw new InstagramParsingError("invalid_thread_id");
  }
  if (fromUrl && fromPlatformId && fromUrl !== fromPlatformId) {
    throw new InstagramParsingError("thread_identity_mismatch");
  }
  return fromPlatformId;
}

interface CapturedInstagramThread {
  snapshot: InstagramThreadSnapshot;
  requestOrder: number;
  position: number;
}

export class InstagramNetworkThreadCapture {
  private generation = 0;
  private nextRequestOrder = 0;
  private pendingRequests = 0;
  private successfulResponses = 0;
  private failedRequests = 0;
  private readonly byId = new Map<string, CapturedInstagramThread>();

  begin(): number {
    this.generation += 1;
    this.nextRequestOrder = 0;
    this.pendingRequests = 0;
    this.successfulResponses = 0;
    this.failedRequests = 0;
    this.byId.clear();
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  reserveRequestOrder(generation: number): number | null {
    if (generation !== this.generation) {
      return null;
    }
    const requestOrder = this.nextRequestOrder;
    this.nextRequestOrder += 1;
    return requestOrder;
  }

  startRequest(generation: number): number | null {
    const requestOrder = this.reserveRequestOrder(generation);
    if (requestOrder !== null) {
      this.pendingRequests += 1;
    }
    return requestOrder;
  }

  finishRequest(generation: number, succeeded: boolean): void {
    if (generation !== this.generation) {
      return;
    }
    this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    if (succeeded) {
      this.successfulResponses += 1;
    } else {
      this.failedRequests += 1;
    }
  }

  status(): {
    pendingRequests: number;
    successfulResponses: number;
    failedRequests: number;
  } {
    return {
      pendingRequests: this.pendingRequests,
      successfulResponses: this.successfulResponses,
      failedRequests: this.failedRequests
    };
  }

  accept(
    generation: number,
    snapshots: InstagramThreadSnapshot[],
    reservedRequestOrder?: number
  ): void {
    if (generation !== this.generation) {
      return;
    }
    const requestOrder =
      reservedRequestOrder ?? this.reserveRequestOrder(generation);
    if (requestOrder === null) {
      return;
    }
    for (let position = 0; position < snapshots.length; position += 1) {
      const snapshot = snapshots[position]!;
      if (!snapshot.stableId) {
        continue;
      }
      const existingEntry = this.byId.get(snapshot.stableId);
      const incomingHasPriority =
        !existingEntry ||
        requestOrder < existingEntry.requestOrder ||
        (requestOrder === existingEntry.requestOrder && position < existingEntry.position);
      const preferredSnapshot = incomingHasPriority
        ? snapshot
        : existingEntry.snapshot;
      const fallbackSnapshot = incomingHasPriority
        ? existingEntry?.snapshot
        : snapshot;
      const mergedSnapshot: InstagramThreadSnapshot = {};
      const href = preferredSnapshot.href ?? fallbackSnapshot?.href;
      const stableId = preferredSnapshot.stableId ?? fallbackSnapshot?.stableId;
      const displayName =
        preferredSnapshot.displayName ?? fallbackSnapshot?.displayName;
      const preview = preferredSnapshot.preview ?? fallbackSnapshot?.preview;
      const unread =
        preferredSnapshot.unread === true || fallbackSnapshot?.unread === true
          ? true
          : (preferredSnapshot.unread ?? fallbackSnapshot?.unread);
      if (href !== undefined) mergedSnapshot.href = href;
      if (stableId !== undefined) mergedSnapshot.stableId = stableId;
      if (displayName !== undefined) mergedSnapshot.displayName = displayName;
      if (preview !== undefined) mergedSnapshot.preview = preview;
      if (unread !== undefined) mergedSnapshot.unread = unread;
      this.byId.set(snapshot.stableId, {
        snapshot: mergedSnapshot,
        requestOrder: incomingHasPriority
          ? requestOrder
          : existingEntry.requestOrder,
        position: incomingHasPriority ? position : existingEntry.position
      });
    }
  }

  current(limit: number): InstagramThreadSnapshot[] {
    return [...this.byId.values()]
      .sort(
        (left, right) =>
          left.requestOrder - right.requestOrder || left.position - right.position
      )
      .slice(0, Math.max(0, limit))
      .map((entry) => entry.snapshot);
  }
}

export class InstagramNetworkMessageCapture {
  private generation = 0;
  private expectedThreadId: string | null = null;
  private nextRequestOrder = 0;
  private pendingRequests = 0;
  private successfulResponses = 0;
  private failedRequests = 0;
  private matchedResponses = 0;
  private recipientVerificationLabel: string | null = null;
  private recipientLabelConflict = false;
  private readonly byNativeId = new Map<
    string,
    {
      snapshot: InstagramMessageSnapshot;
      requestOrder: number;
      position: number;
    }
  >();

  begin(expectedThreadId: string): number {
    this.generation += 1;
    this.expectedThreadId = expectedThreadId;
    this.nextRequestOrder = 0;
    this.pendingRequests = 0;
    this.successfulResponses = 0;
    this.failedRequests = 0;
    this.matchedResponses = 0;
    this.recipientVerificationLabel = null;
    this.recipientLabelConflict = false;
    this.byNativeId.clear();
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  threadIdForGeneration(generation: number): string | null {
    return generation === this.generation ? this.expectedThreadId : null;
  }

  startRequest(generation: number): number | null {
    if (generation !== this.generation || !this.expectedThreadId) {
      return null;
    }
    const requestOrder = this.nextRequestOrder;
    this.nextRequestOrder += 1;
    this.pendingRequests += 1;
    return requestOrder;
  }

  finishRequest(generation: number, succeeded: boolean): void {
    if (generation !== this.generation) {
      return;
    }
    this.pendingRequests = Math.max(0, this.pendingRequests - 1);
    if (succeeded) {
      this.successfulResponses += 1;
    } else {
      this.failedRequests += 1;
    }
  }

  accept(
    generation: number,
    extraction: InstagramMessagePayloadExtraction,
    requestOrder: number
  ): void {
    if (generation !== this.generation || !extraction.matchedThread) {
      return;
    }
    this.matchedResponses += 1;
    const incomingRecipient = extraction.recipientVerificationLabel
      ?.replace(/\s+/g, " ")
      .trim();
    if (incomingRecipient) {
      if (
        this.recipientVerificationLabel &&
        this.recipientVerificationLabel.normalize("NFKC").toLocaleLowerCase() !==
          incomingRecipient.normalize("NFKC").toLocaleLowerCase()
      ) {
        this.recipientLabelConflict = true;
      } else {
        this.recipientVerificationLabel = incomingRecipient;
      }
    }
    for (let position = 0; position < extraction.snapshots.length; position += 1) {
      const snapshot = extraction.snapshots[position]!;
      const nativeId = snapshot.nativeId?.trim();
      if (!snapshot.nativeIdStable || !nativeId) {
        continue;
      }
      const existing = this.byNativeId.get(nativeId);
      if (
        !existing ||
        requestOrder > existing.requestOrder ||
        (requestOrder === existing.requestOrder && position >= existing.position)
      ) {
        this.byNativeId.set(nativeId, { snapshot, requestOrder, position });
      }
    }
  }

  status(): {
    expectedThreadId: string | null;
    pendingRequests: number;
    successfulResponses: number;
    failedRequests: number;
    matchedThread: boolean;
    explicitlyEmpty: boolean;
    recipientVerificationLabel?: string;
    snapshots: InstagramMessageSnapshot[];
  } {
    const result: {
      expectedThreadId: string | null;
      pendingRequests: number;
      successfulResponses: number;
      failedRequests: number;
      matchedThread: boolean;
      explicitlyEmpty: boolean;
      recipientVerificationLabel?: string;
      snapshots: InstagramMessageSnapshot[];
    } = {
      expectedThreadId: this.expectedThreadId,
      pendingRequests: this.pendingRequests,
      successfulResponses: this.successfulResponses,
      failedRequests: this.failedRequests,
      matchedThread: this.matchedResponses > 0,
      explicitlyEmpty: false,
      snapshots: [...this.byNativeId.values()]
        .sort((left, right) => {
          const leftTimestamp = parseInstagramSourceTimestamp(left.snapshot.sourceTimestamp);
          const rightTimestamp = parseInstagramSourceTimestamp(right.snapshot.sourceTimestamp);
          if (leftTimestamp && rightTimestamp && leftTimestamp !== rightTimestamp) {
            return Date.parse(leftTimestamp) - Date.parse(rightTimestamp);
          }
          if (leftTimestamp && !rightTimestamp) return -1;
          if (!leftTimestamp && rightTimestamp) return 1;
          return (
            left.requestOrder - right.requestOrder ||
            left.position - right.position
          );
        })
        .map((entry) => entry.snapshot)
    };
    if (!this.recipientLabelConflict && this.recipientVerificationLabel) {
      result.recipientVerificationLabel = this.recipientVerificationLabel;
    }
    return result;
  }
}

interface InstagramSendMutationCandidate {
  generation: number;
  transport: "relay" | "realtime";
  requestStartedAtMs: number;
  offlineThreadingId: string;
  settled: boolean;
  succeeded: boolean;
  response: InstagramTextSendMutationResponse | null;
}

export class InstagramNetworkSendCapture {
  private generation = 0;
  private expectedThreadId: string | null = null;
  private expectedText = "";
  private clickedAtMs: number | null = null;
  private readonly candidates: InstagramSendMutationCandidate[] = [];

  begin(expectedThreadId: string, expectedText: string): number {
    this.generation += 1;
    this.expectedThreadId = expectedThreadId;
    this.expectedText = cleanMessageText(expectedText);
    this.clickedAtMs = null;
    this.candidates.length = 0;
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  stageRequest(input: {
    generation: number;
    url: string;
    method: string;
    postData: string | null;
    requestStartedAtMs: number;
  }): InstagramSendMutationCandidate | null {
    if (input.generation !== this.generation || !this.expectedThreadId) {
      return null;
    }
    const matched = extractInstagramTextSendMutationRequest({
      url: input.url,
      method: input.method,
      postData: input.postData,
      expectedThreadId: this.expectedThreadId,
      expectedText: this.expectedText
    });
    if (!matched) {
      return null;
    }
    const candidate: InstagramSendMutationCandidate = {
      generation: input.generation,
      transport: "relay",
      requestStartedAtMs: input.requestStartedAtMs,
      offlineThreadingId: matched.offlineThreadingId,
      settled: false,
      succeeded: false,
      response: null
    };
    this.candidates.push(candidate);
    return candidate;
  }

  stageRealtimeFrame(input: {
    generation: number;
    frame: string | Uint8Array;
    frameSentAtMs: number;
  }): InstagramSendMutationCandidate | null {
    if (input.generation !== this.generation || !this.expectedThreadId) {
      return null;
    }
    const matched = extractInstagramRealtimeTextSend({
      frame: input.frame,
      expectedThreadId: this.expectedThreadId,
      expectedText: this.expectedText
    });
    if (!matched) {
      return null;
    }
    const candidate: InstagramSendMutationCandidate = {
      generation: input.generation,
      transport: "realtime",
      requestStartedAtMs: input.frameSentAtMs,
      offlineThreadingId: matched.offlineThreadingId,
      settled: true,
      succeeded: true,
      response: null
    };
    this.candidates.push(candidate);
    return candidate;
  }

  commitClick(generation: number, clickedAtMs: number): boolean {
    if (
      generation !== this.generation ||
      !Number.isFinite(clickedAtMs) ||
      clickedAtMs <= 0
    ) {
      return false;
    }
    this.clickedAtMs = clickedAtMs;
    return true;
  }

  updateRequestStart(
    candidate: InstagramSendMutationCandidate,
    requestStartedAtMs: number
  ): void {
    if (
      candidate.generation === this.generation &&
      Number.isFinite(requestStartedAtMs) &&
      requestStartedAtMs > 0
    ) {
      candidate.requestStartedAtMs = requestStartedAtMs;
    }
  }

  settleRequest(
    candidate: InstagramSendMutationCandidate,
    succeeded: boolean,
    payload?: unknown
  ): void {
    if (candidate.generation !== this.generation || candidate.settled) {
      return;
    }
    candidate.settled = true;
    candidate.response = succeeded
      ? extractInstagramTextSendMutationResponse(payload)
      : null;
    candidate.succeeded = succeeded && candidate.response !== null;
  }

  status(): {
    generation: number;
    expectedThreadId: string | null;
    clickCommitted: boolean;
    observedRequests: number;
    unverifiableRequests: number;
    matchingRequests: number;
    pendingRequests: number;
    failedRequests: number;
    outboundTransportBound: boolean;
    offlineThreadingId: string | null;
    acknowledgedMessageId: string | null;
    acknowledgedTimestampMs?: string;
  } {
    const eligible = this.clickedAtMs === null
      ? []
      : this.candidates.filter(
          (candidate) =>
            Number.isFinite(candidate.requestStartedAtMs) &&
            candidate.requestStartedAtMs >= this.clickedAtMs!
        );
    const sole = eligible.length === 1 ? eligible[0]! : null;
    const result: {
      generation: number;
      expectedThreadId: string | null;
      clickCommitted: boolean;
      observedRequests: number;
      unverifiableRequests: number;
      matchingRequests: number;
      pendingRequests: number;
      failedRequests: number;
      outboundTransportBound: boolean;
      offlineThreadingId: string | null;
      acknowledgedMessageId: string | null;
      acknowledgedTimestampMs?: string;
    } = {
      generation: this.generation,
      expectedThreadId: this.expectedThreadId,
      clickCommitted: this.clickedAtMs !== null,
      observedRequests: this.candidates.length,
      unverifiableRequests: this.candidates.filter(
        (candidate) =>
          !Number.isFinite(candidate.requestStartedAtMs) ||
          candidate.requestStartedAtMs <= 0
      ).length,
      matchingRequests: eligible.length,
      pendingRequests: eligible.filter((candidate) => !candidate.settled).length,
      failedRequests: eligible.filter(
        (candidate) => candidate.settled && !candidate.succeeded
      ).length,
      outboundTransportBound: Boolean(sole?.settled && sole.succeeded),
      offlineThreadingId: sole?.offlineThreadingId ?? null,
      acknowledgedMessageId:
        sole?.transport === "relay" && sole.settled && sole.succeeded
          ? sole.response?.messageId ?? null
          : null
    };
    if (sole?.settled && sole.succeeded && sole.response?.timestampMs !== undefined) {
      result.acknowledgedTimestampMs = sole.response.timestampMs;
    }
    return result;
  }
}

export function instagramEmptyInboxText(bodyText: string): boolean {
  const normalized = bodyText.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return normalized === "no messages" || normalized === "no conversations";
}

export interface InstagramEmptyInboxEvidence {
  documentRootPresent: boolean;
  scopedEmptyLabels: string[];
  threadItemCount: number;
  directThreadLinkCount: number;
  composerCount: number;
  messageItemCount: number;
  loadingSignalCount: number;
  errorSignalCount: number;
  networkPendingRequests: number;
  networkFailedRequests: number;
}

export function isInstagramExplicitEmptyInbox(
  evidence: InstagramEmptyInboxEvidence
): boolean {
  return (
    evidence.documentRootPresent &&
    evidence.scopedEmptyLabels.length === 1 &&
    instagramEmptyInboxText(evidence.scopedEmptyLabels[0] ?? "") &&
    evidence.threadItemCount === 0 &&
    evidence.directThreadLinkCount === 0 &&
    evidence.composerCount === 0 &&
    evidence.messageItemCount === 0 &&
    evidence.loadingSignalCount === 0 &&
    evidence.errorSignalCount === 0 &&
    evidence.networkPendingRequests === 0 &&
    evidence.networkFailedRequests === 0
  );
}

export class InstagramAdapter extends BetaAdapter {
  override readonly collectionBoundary: PlatformCollectionBoundaryCapability = {
    beginCycle: () => this.beginCollectionCycle(),
    getMetrics: () => this.getLastCollectionMetrics()
  };
  private readonly instagramDeps: InstagramAdapterDependencies;
  private cookieBridge: ChromeCookieBridge | null = null;
  private lastCookieSyncAt: number | null = null;
  private readonly shimmedContexts = new WeakSet<BrowserContext>();
  private readonly networkCapturePages = new WeakSet<Page>();
  private readonly networkThreadCaptures = new WeakMap<Page, InstagramNetworkThreadCapture>();
  private readonly networkMessageCaptures = new WeakMap<Page, InstagramNetworkMessageCapture>();
  private readonly networkSendCaptures = new WeakMap<Page, InstagramNetworkSendCapture>();
  private readonly networkRequestTokens = new WeakMap<
    object,
    { generation: number; requestOrder: number }
  >();
  private readonly networkMessageRequestTokens = new WeakMap<
    object,
    { generation: number; requestOrder: number }
  >();
  private readonly networkSendRequestTokens = new WeakMap<
    object,
    { capture: InstagramNetworkSendCapture; candidate: InstagramSendMutationCandidate }
  >();
  private readonly settledNetworkRequests = new WeakSet<object>();
  private readonly settledNetworkMessageRequests = new WeakSet<object>();
  private collectionCycleId = 0;
  private cachedCollectionThreads: {
    cycleId: number;
    threads: ThreadStub[];
    explicitlyEmpty: boolean;
  } | null = null;
  private collectionCalls = 0;
  private collectionObservedRows = false;
  private collectionExplicitlyEmpty = true;
  private collectionTotalFound = 0;
  private collectionUnreadFound = 0;

  constructor(deps: InstagramAdapterDependencies) {
    super({ ...deps, platform: "INSTAGRAM" });
    this.instagramDeps = deps;
  }

  protected override async getPage(): Promise<Page> {
    const page = await super.getPage();
    await this.ensurePageRuntimeShims(page);
    this.ensureNetworkThreadCapture(page);
    return page;
  }

  private ensureNetworkThreadCapture(page: Page): void {
    if (this.networkCapturePages.has(page)) {
      return;
    }
    if (typeof (page as Page & { on?: unknown }).on !== "function") {
      return;
    }
    this.networkCapturePages.add(page);
    const capture = new InstagramNetworkThreadCapture();
    const messageCapture = new InstagramNetworkMessageCapture();
    const sendCapture = new InstagramNetworkSendCapture();
    this.networkThreadCaptures.set(page, capture);
    this.networkMessageCaptures.set(page, messageCapture);
    this.networkSendCaptures.set(page, sendCapture);
    page.on("request", (request: any) => {
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return;
      }
      const sameInstagramOrigin =
        url.hostname === "www.instagram.com" || url.hostname === "instagram.com";
      if (
        !sameInstagramOrigin ||
        !/\/api\/graphql\/?$|\/graphql\/query\/?$/i.test(url.pathname)
      ) {
        return;
      }
      const generation = capture.currentGeneration();
      const requestOrder = capture.startRequest(generation);
      if (requestOrder !== null) {
        this.networkRequestTokens.set(request, { generation, requestOrder });
      }
      const messageGeneration = messageCapture.currentGeneration();
      const messageRequestOrder = messageCapture.startRequest(messageGeneration);
      if (messageRequestOrder !== null) {
        this.networkMessageRequestTokens.set(request, {
          generation: messageGeneration,
          requestOrder: messageRequestOrder
        });
      }
      const sendCandidate = sendCapture.stageRequest({
        generation: sendCapture.currentGeneration(),
        url: request.url(),
        method: request.method(),
        postData: request.postData(),
        requestStartedAtMs: request.timing().startTime
      });
      if (sendCandidate) {
        this.networkSendRequestTokens.set(request, {
          capture: sendCapture,
          candidate: sendCandidate
        });
      }
    });
    page.on("response", (response: any) => {
      let url: URL;
      try {
        url = new URL(response.url());
      } catch {
        return;
      }
      if (
        (url.hostname !== "www.instagram.com" && url.hostname !== "instagram.com") ||
        !/\/api\/graphql\/?$|\/graphql\/query\/?$/i.test(url.pathname)
      ) {
        return;
      }
      const request = typeof response.request === "function" ? response.request() : null;
      const token = request ? this.networkRequestTokens.get(request) : undefined;
      const messageToken = request
        ? this.networkMessageRequestTokens.get(request)
        : undefined;
      const sendToken = request ? this.networkSendRequestTokens.get(request) : undefined;
      if (!request || (!token && !messageToken && !sendToken)) {
        return;
      }
      const settleThread = (succeeded: boolean): void => {
        if (!token || this.settledNetworkRequests.has(request)) {
          return;
        }
        this.settledNetworkRequests.add(request);
        capture.finishRequest(token.generation, succeeded);
      };
      const settleMessage = (succeeded: boolean): void => {
        if (!messageToken || this.settledNetworkMessageRequests.has(request)) {
          return;
        }
        this.settledNetworkMessageRequests.add(request);
        messageCapture.finishRequest(messageToken.generation, succeeded);
      };
      const settleSend = (succeeded: boolean, payload?: unknown): void => {
        if (!sendToken) {
          return;
        }
        sendToken.capture.updateRequestStart(
          sendToken.candidate,
          request.timing().startTime
        );
        sendToken.capture.settleRequest(sendToken.candidate, succeeded, payload);
      };
      if (response.status() < 200 || response.status() >= 300) {
        settleThread(false);
        settleMessage(false);
        settleSend(false);
        return;
      }
      void response
        .json()
        .then((payload: unknown) => {
          if (
            (!token || this.settledNetworkRequests.has(request)) &&
            (!messageToken || this.settledNetworkMessageRequests.has(request)) &&
            !sendToken
          ) {
            return;
          }
          if (instagramGraphQlPayloadHasErrors(payload)) {
            settleThread(false);
            settleMessage(false);
            settleSend(false);
            return;
          }
          const snapshots = token
            ? extractInstagramThreadSnapshotsFromPayload(payload)
            : [];
          if (token) {
            capture.accept(token.generation, snapshots, token.requestOrder);
          }
          let messageSucceeded = true;
          if (messageToken) {
            const expectedThreadId = messageCapture.threadIdForGeneration(
              messageToken.generation
            );
            if (expectedThreadId) {
              try {
                messageCapture.accept(
                  messageToken.generation,
                  extractInstagramMessageSnapshotsFromPayload(payload, expectedThreadId),
                  messageToken.requestOrder
                );
              } catch {
                messageSucceeded = false;
              }
            }
          }
          settleThread(true);
          settleMessage(messageSucceeded);
          settleSend(true, payload);
        })
        .catch(() => {
          settleThread(false);
          settleMessage(false);
          settleSend(false);
        });
    });
    page.on("requestfailed", (request: object) => {
      const token = this.networkRequestTokens.get(request);
      if (token && !this.settledNetworkRequests.has(request)) {
        this.settledNetworkRequests.add(request);
        capture.finishRequest(token.generation, false);
      }
      const messageToken = this.networkMessageRequestTokens.get(request);
      if (messageToken && !this.settledNetworkMessageRequests.has(request)) {
        this.settledNetworkMessageRequests.add(request);
        messageCapture.finishRequest(messageToken.generation, false);
      }
      const sendToken = this.networkSendRequestTokens.get(request);
      if (sendToken) {
        sendToken.capture.updateRequestStart(
          sendToken.candidate,
          (request as any).timing().startTime
        );
        sendToken.capture.settleRequest(sendToken.candidate, false);
      }
    });
    page.on("websocket", (webSocket: any) => {
      webSocket.on("framesent", (event: { payload?: string | Uint8Array }) => {
        if (event.payload === undefined) {
          return;
        }
        sendCapture.stageRealtimeFrame({
          generation: sendCapture.currentGeneration(),
          frame: event.payload,
          frameSentAtMs: Date.now()
        });
      });
    });
  }

  private beginNetworkThreadCapture(page: Page): void {
    this.networkThreadCaptures.get(page)?.begin();
  }

  private capturedNetworkThreads(page: Page, limit = Number.MAX_SAFE_INTEGER): InstagramThreadSnapshot[] {
    return this.networkThreadCaptures.get(page)?.current(limit) ?? [];
  }

  private networkThreadCaptureStatus(page: Page): {
    pendingRequests: number;
    successfulResponses: number;
    failedRequests: number;
  } {
    return this.networkThreadCaptures.get(page)?.status() ?? {
      pendingRequests: 0,
      successfulResponses: 0,
      failedRequests: 0
    };
  }

  private async waitForCapturedNetworkThreads(page: Page, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.capturedNetworkThreads(page).length === 0) {
      await page.waitForTimeout(100);
    }
  }

  private async waitForPendingNetworkThreadCapture(
    page: Page,
    timeoutMs: number
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const quietWindowMs = 200;
    let previousStatus = this.networkThreadCaptureStatus(page);
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
      const status = this.networkThreadCaptureStatus(page);
      if (
        status.pendingRequests !== previousStatus.pendingRequests ||
        status.successfulResponses !== previousStatus.successfulResponses ||
        status.failedRequests !== previousStatus.failedRequests
      ) {
        quietSince = Date.now();
        previousStatus = status;
      }
      if (status.pendingRequests === 0 && Date.now() - quietSince >= quietWindowMs) {
        return;
      }
    }
  }

  private beginNetworkMessageCapture(page: Page, platformThreadId: string): void {
    this.networkMessageCaptures.get(page)?.begin(platformThreadId);
  }

  private networkMessageCaptureStatus(page: Page): ReturnType<InstagramNetworkMessageCapture["status"]> {
    return this.networkMessageCaptures.get(page)?.status() ?? {
      expectedThreadId: null,
      pendingRequests: 0,
      successfulResponses: 0,
      failedRequests: 0,
      matchedThread: false,
      explicitlyEmpty: false,
      snapshots: []
    };
  }

  private async waitForNetworkMessageCapture(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const quietWindowMs = 200;
    let previousStatus = this.networkMessageCaptureStatus(page);
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
      const status = this.networkMessageCaptureStatus(page);
      if (
        status.pendingRequests !== previousStatus.pendingRequests ||
        status.successfulResponses !== previousStatus.successfulResponses ||
        status.failedRequests !== previousStatus.failedRequests ||
        status.matchedThread !== previousStatus.matchedThread ||
        status.snapshots.length !== previousStatus.snapshots.length
      ) {
        quietSince = Date.now();
        previousStatus = status;
      }
      if (
        status.matchedThread &&
        status.pendingRequests === 0 &&
        status.failedRequests === 0 &&
        Date.now() - quietSince >= quietWindowMs
      ) {
        return true;
      }
    }
    return false;
  }

  private beginNetworkSendCapture(
    page: Page,
    platformThreadId: string,
    text: string
  ): number {
    const capture = this.networkSendCaptures.get(page);
    if (!capture) {
      throw new InstagramParsingError("send_network_capture_unavailable");
    }
    return capture.begin(platformThreadId, text);
  }

  private commitNetworkSendClick(
    page: Page,
    generation: number,
    clickedAtMs: number
  ): boolean {
    return this.networkSendCaptures.get(page)?.commitClick(generation, clickedAtMs) ?? false;
  }

  private networkSendCaptureStatus(
    page: Page
  ): ReturnType<InstagramNetworkSendCapture["status"]> {
    return this.networkSendCaptures.get(page)?.status() ?? {
      generation: 0,
      expectedThreadId: null,
      clickCommitted: false,
      observedRequests: 0,
      unverifiableRequests: 0,
      matchingRequests: 0,
      pendingRequests: 0,
      failedRequests: 0,
      outboundTransportBound: false,
      offlineThreadingId: null,
      acknowledgedMessageId: null
    };
  }

  private async waitForNetworkSendCapture(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const quietWindowMs = 250;
    let stableSignature = "";
    let quietSince = 0;
    while (Date.now() < deadline) {
      const status = this.networkSendCaptureStatus(page);
      const signature = [
        status.generation,
        status.observedRequests,
        status.unverifiableRequests,
        status.matchingRequests,
        status.pendingRequests,
        status.failedRequests,
        status.outboundTransportBound,
        status.offlineThreadingId ?? "",
        status.acknowledgedMessageId ?? ""
      ].join("\u001f");
      if (signature !== stableSignature) {
        stableSignature = signature;
        quietSince = Date.now();
      }
      if (
        status.clickCommitted &&
        status.unverifiableRequests === 0 &&
        status.matchingRequests === 1 &&
        status.pendingRequests === 0 &&
        status.failedRequests === 0 &&
        status.outboundTransportBound &&
        status.offlineThreadingId &&
        Date.now() - quietSince >= quietWindowMs
      ) {
        return true;
      }
      if (
        status.clickCommitted &&
        (status.matchingRequests > 1 || status.failedRequests > 0)
      ) {
        return false;
      }
      await page.waitForTimeout(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  private async createSendVerificationPage(page: Page): Promise<Page> {
    const verificationPage = await page.context().newPage();
    await this.ensurePageRuntimeShims(verificationPage);
    this.ensureNetworkThreadCapture(verificationPage);
    return verificationPage;
  }

  private async ensurePageRuntimeShims(page: Page): Promise<void> {
    const context = page.context();
    if (!this.shimmedContexts.has(context)) {
      try {
        await context.addInitScript(INSTAGRAM_RUNTIME_SHIM_SOURCE);
        this.shimmedContexts.add(context);
      } catch {
        // The current document is patched separately below.
      }
    }
    try {
      await page.evaluate(INSTAGRAM_RUNTIME_SHIM_SOURCE);
    } catch {
      try {
        await page.addScriptTag({ content: INSTAGRAM_RUNTIME_SHIM_SOURCE });
      } catch {
        return;
      }
    }
  }

  private async syncSessionCookies(page: Page): Promise<boolean> {
    if (this.instagramDeps.syncPersonalSessionCookies) {
      return this.instagramDeps.syncPersonalSessionCookies(page.context());
    }
    const personal = this.instagramDeps.personalProfile;
    if (!personal) {
      return false;
    }

    const now = Date.now();
    if (this.lastCookieSyncAt !== null && now - this.lastCookieSyncAt < 10 * 60 * 1000) {
      return true;
    }

    this.cookieBridge ??= new ChromeCookieBridge({
      sourceUserDataDir: personal.sourceUserDataDir,
      profileDirectory: personal.profileDirectory
    });

    const result = await this.cookieBridge.syncIntoContext(
      page.context(),
      "%instagram.com%"
    );
    if (result.reason === "ok") {
      this.lastCookieSyncAt = now;
      console.log(`[instagram-cookie-bridge] injected ${result.injected} cookies`);
      return result.injected > 0;
    }

    console.warn(`[instagram-cookie-bridge] no cookies injected (${result.reason})`);
    return false;
  }

  private safeFailure(
    kind: "SELECTOR_MISMATCH" | "THREAD_FETCH_FAILED" | "THREAD_NOT_FOUND" | "NAVIGATION_FAILED",
    stage: "connect" | "navigate" | "collect_threads" | "open_thread" | "parse" | "persist",
    reason: string,
    platformThreadId?: string,
    cause?: unknown
  ): AdapterFailure {
    return new AdapterFailure(`Instagram ${reason.replaceAll("_", " ")}`, {
      kind,
      platform: "INSTAGRAM",
      stage,
      platformThreadId,
      details: { reason },
      cause
    });
  }

  private async authRequirementForPage(page: Page): Promise<InstagramAuthRequirement | null> {
    const signals = await page.evaluate(() => ({
      fieldNames: Array.from(document.querySelectorAll("input[name]"))
        .map((node) => node.getAttribute("name") ?? "")
        .filter(Boolean),
      bodyText: document.body?.innerText?.slice(0, 500) ?? "",
      hasRecaptcha: Boolean(
        document.querySelector("iframe[src*='recaptcha'], .g-recaptcha, [data-sitekey]")
      )
    }));
    return classifyInstagramAuthRequirement({
      url: page.url(),
      fieldNames: signals.fieldNames,
      bodyText: signals.bodyText,
      hasRecaptcha: signals.hasRecaptcha
    });
  }

  private async throwIfInstagramAuthRequired(
    page: Page,
    context: string,
    deadlineAtMs?: number
  ): Promise<void> {
    const authCheck = this.authRequirementForPage(page);
    const requirement = deadlineAtMs === undefined
      ? await authCheck
      : await new Promise<InstagramAuthRequirement | null>((resolve, reject) => {
          const remainingMs = deadlineAtMs - Date.now();
          if (remainingMs <= 0) {
            reject(new InstagramParsingError("send_verification_timeout"));
            return;
          }
          const timeout = setTimeout(
            () => reject(new InstagramParsingError("send_verification_timeout")),
            remainingMs
          );
          authCheck.then(
            (value) => {
              clearTimeout(timeout);
              resolve(value);
            },
            (error) => {
              clearTimeout(timeout);
              reject(error);
            }
          );
        });
    if (requirement) {
      throw new AdapterFailure("Instagram auth required", {
        kind: "AUTH_REQUIRED",
        platform: "INSTAGRAM",
        stage: "navigate",
        details: { context, reason: `instagram_${requirement}` }
      });
    }
  }

  private async waitForAuthenticatedInbox(
    page: Page,
    selectors: SelectorRegistry,
    timeoutMs: number
  ): Promise<void> {
    const selectorPayload = JSON.stringify({
      threadList: selectors.thread_list,
      threadItem: selectors.thread_item,
      messageContainer: selectors.message_container
    });
    await page.waitForFunction(
      `() => {
        const { threadList, threadItem, messageContainer } = ${selectorPayload};
        const pathname = window.location.pathname;
        if (
          pathname.startsWith("/auth_platform/recaptcha") ||
          document.querySelector("iframe[src*='recaptcha'], .g-recaptcha, [data-sitekey]")
        ) {
          return true;
        }
        if (!pathname.startsWith("/direct")) {
          return false;
        }
        return Boolean(
          document.querySelector(threadList) ||
            document.querySelector(threadItem) ||
            document.querySelector(messageContainer) ||
            document.querySelector("main")
        );
      }`,
      undefined,
      { timeout: timeoutMs }
    );
  }

  private async navigateToInbox(
    page: Page,
    selectors: SelectorRegistry,
    timeoutMs: number
  ): Promise<void> {
    await page.goto(selectors.inbox_url, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeoutMs, 12_000)
    });
    await page.waitForTimeout(350);
    await this.throwIfInstagramAuthRequired(page, "instagram_inbox");
    await this.waitForAuthenticatedInbox(page, selectors, timeoutMs);
  }

  private async continueSavedProfileLogin(page: Page): Promise<boolean> {
    if (!/\/accounts\/login/i.test(page.url())) {
      return false;
    }

    const otherProfile = page.getByText("Use another profile", { exact: true });
    await otherProfile
      .first()
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => undefined);
    const continueControl = page.getByText("Continue", { exact: true });
    if (
      (await otherProfile.count()) < 1 ||
      (await continueControl.count()) !== 1 ||
      !(await continueControl.isEnabled())
    ) {
      return false;
    }

    await continueControl.click({ timeout: 10_000 });
    await page.waitForTimeout(500);
    return true;
  }

  async ensureConnected(): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    try {
      await this.navigateToInbox(page, selectors, 12_000);
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      throw this.safeFailure("SELECTOR_MISMATCH", "connect", "inbox_not_ready", undefined, error);
    }
  }

  async connectInteractively(): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    const startedAt = Date.now();
    const reserveMs = Math.max(
      2_000,
      Math.floor(this.instagramDeps.connectTimeoutMs * 0.15)
    );
    const navigationTimeoutMs = Math.max(
      1_000,
      Math.min(15_000, Math.floor(this.instagramDeps.connectTimeoutMs * 0.25))
    );
    try {
      await page.goto(selectors.inbox_url, {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs
      });
      await page.bringToFront();
      if (await this.continueSavedProfileLogin(page)) {
        await page
          .waitForFunction(() => !window.location.pathname.startsWith("/accounts/login"), undefined, {
            timeout: 5_000
          })
          .catch(() => undefined);
      }
      if ((await this.authRequirementForPage(page)) === "login_required") {
        const synced = await this.syncSessionCookies(page);
        if (synced) {
          await page.goto(selectors.inbox_url, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs
          });
          await this.continueSavedProfileLogin(page);
        }
      }
      const authWaitTimeoutMs = Math.max(
        1,
        this.instagramDeps.connectTimeoutMs - (Date.now() - startedAt) - reserveMs
      );
      await this.waitForAuthenticatedInbox(page, selectors, authWaitTimeoutMs);
      await this.throwIfInstagramAuthRequired(page, "interactive_connect");
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      await this.throwIfInstagramAuthRequired(page, "interactive_connect");
      throw this.safeFailure("SELECTOR_MISMATCH", "connect", "interactive_login_incomplete", undefined, error);
    }
  }

  private async snapshotThreads(
    page: Page,
    selectors: SelectorRegistry,
    limit: number
  ): Promise<ThreadStub[]> {
    const documentRoot = await page.$("body");
    if (!documentRoot) {
      throw new InstagramParsingError("instagram_document_missing");
    }
    await documentRoot.evaluate(INSTAGRAM_RUNTIME_SHIM_SOURCE);
    const domSnapshots = await documentRoot.evaluate(
      (root, { selectors }) => {
        const clean = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim();
        const query = (root: Element, selector: string | undefined): Element | null => {
          if (!selector) return null;
          try {
            return root.matches(selector) ? root : root.querySelector(selector);
          } catch {
            return null;
          }
        };
        const rows = Array.from(root.querySelectorAll(selectors.thread_item));
        return rows.map((row) => {
          const link = query(row, selectors.thread_link ?? "a[href*='/direct/t/']") as
            | HTMLAnchorElement
            | null;
          const identity = query(
            row,
            selectors.thread_identity ?? "span[title], img[alt]"
          ) as HTMLElement | null;
          const preview = query(row, selectors.thread_snippet ?? "span[dir='auto']") as
            | HTMLElement
            | null;
          const identityText =
            identity?.getAttribute("title") ||
            identity?.getAttribute("alt") ||
            identity?.textContent ||
            "";
          return {
            href: link?.href,
            displayName: clean(identityText),
            preview: clean(preview?.textContent),
            unread: Boolean(query(row, selectors.unread_badge))
          };
        });
      },
      { selectors }
    );
    return mergeInstagramThreadSnapshotSources({
      networkSnapshots: this.capturedNetworkThreads(page),
      domSnapshots,
      limit
    });
  }

  private async probeThreadDom(page: Page): Promise<Record<string, unknown>> {
    const documentRoot = await page.$("body");
    if (!documentRoot) {
      return { documentRootPresent: false };
    }
    await documentRoot.evaluate(INSTAGRAM_RUNTIME_SHIM_SOURCE);
    return documentRoot.evaluate((root) => {
      const anchors = Array.from(root.querySelectorAll("a[href]"));
      const directPathPatterns = new Set<string>();
      const candidateShapes = new Map<string, number>();
      const reactMetadataKeyPaths = new Set<string>();
      const seenMetadata = new WeakSet<object>();
      const collectMetadataKeys = (
        value: unknown,
        prefix: string,
        depth: number
      ): void => {
        if (!value || typeof value !== "object" || depth > 3 || seenMetadata.has(value)) {
          return;
        }
        seenMetadata.add(value);
        for (const key of Object.keys(value).slice(0, 60)) {
          let child: unknown;
          try {
            child = (value as Record<string, unknown>)[key];
          } catch {
            continue;
          }
          const path = `${prefix}.${key}`;
          if (/thread|conversation|href|route|url|id/i.test(key)) {
            reactMetadataKeyPaths.add(`${path}:${typeof child}`);
          }
          if (
            depth < 3 &&
            (key === "props" ||
              key === "memoizedProps" ||
              key === "pendingProps" ||
              key === "children" ||
              key === "child" ||
              key === "return")
          ) {
            collectMetadataKeys(child, path, depth + 1);
          }
        }
      };
      for (const anchor of anchors) {
        const rawHref = anchor.getAttribute("href") ?? "";
        if (!rawHref.includes("/direct/")) continue;
        try {
          const pathname = new URL(rawHref, "https://www.instagram.com").pathname;
          const segments = pathname.split("/").filter(Boolean);
          if (segments[0] === "direct" && segments[1] === "t" && segments.length >= 3) {
            directPathPatterns.add("/direct/t/:id/");
          } else {
            directPathPatterns.add("other_direct_path");
          }
        } catch {
          directPathPatterns.add("invalid_direct_url");
        }
      }
      const controls = Array.from(
        root.querySelectorAll("button, [role='button'], [role='link'], [tabindex='0']")
      ).slice(0, 160);
      for (const control of controls) {
        const rect = control.getBoundingClientRect();
        if (
          rect.width < 140 ||
          rect.height < 36 ||
          rect.height > 180 ||
          !control.querySelector("img, [dir='auto']")
        ) {
          continue;
        }
        const shape = [
          control.tagName.toLowerCase(),
          control.getAttribute("role") ?? "none",
          control.querySelectorAll("img").length > 0 ? "image" : "no-image",
          control.querySelectorAll("[dir='auto']").length > 0 ? "auto-text" : "no-auto-text",
          control.getAttribute("tabindex") ?? "no-tabindex"
        ].join(":");
        candidateShapes.set(shape, (candidateShapes.get(shape) ?? 0) + 1);

        let current: Element | null = control;
        for (let depth = 0; current && depth < 5; depth += 1) {
          for (const key of Object.getOwnPropertyNames(current)) {
            if (!key.startsWith("__reactProps$") && !key.startsWith("__reactFiber$")) {
              continue;
            }
            let metadata: unknown;
            try {
              metadata = (current as unknown as Record<string, unknown>)[key];
            } catch {
              continue;
            }
            collectMetadataKeys(metadata, key.startsWith("__reactProps$") ? "props" : "fiber", 0);
          }
          current = current.parentElement;
        }
      }
      return {
        documentRootPresent: true,
        mainCount: root.querySelectorAll("main, div[role='main']").length,
        anchorCount: anchors.length,
        directAnchorCount: anchors.filter((anchor) =>
          (anchor.getAttribute("href") ?? "").includes("/direct/")
        ).length,
        roleLinkCount: root.querySelectorAll("[role='link']").length,
        roleButtonCount: root.querySelectorAll("[role='button']").length,
        directPathPatterns: [...directPathPatterns].slice(0, 8),
        candidateControlCount: [...candidateShapes.values()].reduce(
          (total, count) => total + count,
          0
        ),
        candidateShapes: [...candidateShapes.entries()].slice(0, 12),
        reactMetadataKeyPaths: [...reactMetadataKeyPaths].sort().slice(0, 80)
      };
    });
  }

  private async collectThreads(limit: number): Promise<ThreadStub[]> {
    const cachedCollection = this.cachedCollectionThreads;
    if (
      this.collectionCycleId > 0 &&
      cachedCollection?.cycleId === this.collectionCycleId
    ) {
      const threads = cachedCollection.threads.slice(0, Math.max(0, limit));
      this.recordCollectionView(
        threads,
        cachedCollection.explicitlyEmpty,
        cachedCollection.threads
      );
      return threads;
    }

    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    try {
      this.beginNetworkThreadCapture(page);
      await this.navigateToInbox(page, selectors, 12_000);
      const captureReadyDeadline = Date.now() + 8_000;
      await Promise.race([
        page
          .waitForSelector(selectors.thread_item, { state: "attached", timeout: 8_000 })
          .catch(() => undefined),
        this.waitForCapturedNetworkThreads(page, 8_000)
      ]);
      await this.waitForPendingNetworkThreadCapture(
        page,
        captureReadyDeadline - Date.now()
      );
      const collectedThreads = await this.snapshotThreads(
        page,
        selectors,
        Number.MAX_SAFE_INTEGER
      );
      const threads = collectedThreads.slice(0, Math.max(0, limit));
      let explicitlyEmpty = false;
      if (threads.length === 0) {
        const domEvidence = await page
          .evaluate(({ selectors }) => {
            const main = document.querySelector("main, div[role='main']");
            const count = (root: ParentNode | null, selector: string | undefined): number => {
              if (!root || !selector) return 0;
              try {
                return root.querySelectorAll(selector).length;
              } catch {
                return -1;
              }
            };
            const visible = (element: Element): boolean => {
              if ((element as HTMLElement).hidden || element.getAttribute("aria-hidden") === "true") {
                return false;
              }
              const style = window.getComputedStyle(element);
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                element.getClientRects().length > 0
              );
            };
            const scopedEmptyLabels = main
              ? Array.from(
                  main.querySelectorAll(
                    "h1, h2, h3, [role='heading'], [role='status'], [aria-live='polite']"
                  )
                )
                  .filter(visible)
                  .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
                  .filter((text) => /^(no messages|no conversations)$/i.test(text))
              : [];
            return {
              documentRootPresent: Boolean(main),
              scopedEmptyLabels,
              threadItemCount: count(document, selectors.thread_item),
              directThreadLinkCount: count(document, "a[href*='/direct/t/']"),
              composerCount: count(document, selectors.composer_input),
              messageItemCount: count(document, selectors.message_item),
              loadingSignalCount: count(
                document,
                "[aria-busy='true'], [role='progressbar'], [data-visualcompletion='loading-state'], [aria-label*='Loading']"
              ),
              errorSignalCount: Array.from(
                document.querySelectorAll("[role='alert'], [aria-live='assertive']")
              ).filter(
                (element) =>
                  visible(element) &&
                  /try again|could(?:n't| not) load|something went wrong|\berror\b|log in|verify/i.test(
                    element.textContent ?? ""
                  )
              ).length
            };
          }, { selectors })
          .catch(() => null);
        const networkEvidence = this.networkThreadCaptureStatus(page);
        const emptyInbox = Boolean(
          domEvidence &&
          isInstagramExplicitEmptyInbox({
            ...domEvidence,
            networkPendingRequests: networkEvidence.pendingRequests,
            networkFailedRequests: networkEvidence.failedRequests
          })
        );
        explicitlyEmpty = emptyInbox;
        if (!emptyInbox) {
          const structuralDetails = await this.probeThreadDom(page).catch(() => ({
            documentProbeFailed: true
          }));
          console.warn(
            `[instagram-thread-probe] ${JSON.stringify(
              sanitizePlatformDiagnosticValue("INSTAGRAM", structuralDetails)
            )}`
          );
          throw this.safeFailure(
            "SELECTOR_MISMATCH",
            "collect_threads",
            "thread_selector_returned_no_rows",
            undefined,
            undefined
          );
        }
      }
      if (this.collectionCycleId > 0) {
        this.cachedCollectionThreads = {
          cycleId: this.collectionCycleId,
          threads: collectedThreads,
          explicitlyEmpty
        };
      }
      this.recordCollectionView(threads, explicitlyEmpty, collectedThreads);
      return threads;
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      const reason = classifyInstagramThreadCollectionError(error);
      throw this.safeFailure("SELECTOR_MISMATCH", "collect_threads", reason, undefined, error);
    }
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const threads = await this.collectThreads(80);
    return threads
      .filter((thread) => (thread.unreadCount ?? 0) > 0)
      .map((thread) => ({ ...thread, isUnreadCandidate: true }));
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const threads = await this.collectThreads(limit);
    return threads.map((thread) => ({ ...thread, isRecentCandidate: true }));
  }

  private recordCollectionView(
    threads: ThreadStub[],
    explicitlyEmpty: boolean,
    metricThreads: ThreadStub[] = threads
  ): void {
    this.collectionCalls += 1;
    this.collectionObservedRows ||= metricThreads.length > 0;
    this.collectionExplicitlyEmpty &&= explicitlyEmpty;
    this.collectionTotalFound = Math.max(this.collectionTotalFound, metricThreads.length);
    this.collectionUnreadFound = Math.max(
      this.collectionUnreadFound,
      metricThreads.filter((thread) => (thread.unreadCount ?? 0) > 0).length
    );
  }

  beginCollectionCycle(): void {
    this.collectionCycleId += 1;
    this.cachedCollectionThreads = null;
    this.collectionCalls = 0;
    this.collectionObservedRows = false;
    this.collectionExplicitlyEmpty = true;
    this.collectionTotalFound = 0;
    this.collectionUnreadFound = 0;
  }

  getLastCollectionMetrics(): {
    totalFound: number;
    unreadFound: number;
    failures: number;
    completeness: "complete" | "incomplete";
    nativeStopReason: "zero_threads_found" | "instagram_bounded_snapshot";
  } {
    const nativeStopReason = resolveInstagramCollectionStopReason({
      collectionCalls: this.collectionCalls,
      observedRows: this.collectionObservedRows,
      explicitlyEmpty: this.collectionExplicitlyEmpty
    });
    return {
      totalFound: this.collectionTotalFound,
      unreadFound: this.collectionUnreadFound,
      failures: 0,
      completeness: nativeStopReason === "zero_threads_found" ? "complete" : "incomplete",
      nativeStopReason
    };
  }

  private async openExactThread(
    page: Page,
    selectors: SelectorRegistry,
    thread: ThreadStub,
    requireRecipientHeader = false,
    verificationPhase: "open" | "before_send" = "open",
    deadlineAtMs?: number
  ): Promise<string> {
    const remainingOpenTimeout = (): number => {
      if (deadlineAtMs === undefined) {
        return 12_000;
      }
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        throw new InstagramParsingError("send_verification_timeout");
      }
      return Math.min(12_000, remainingMs);
    };
    const platformThreadId = threadIdForStub(thread);
    await page.goto(canonicalInstagramThreadUrl(platformThreadId), {
      waitUntil: "domcontentloaded",
      timeout: remainingOpenTimeout()
    });
    const settleDelayMs =
      deadlineAtMs === undefined
        ? 350
        : Math.min(350, Math.max(0, deadlineAtMs - Date.now()));
    if (settleDelayMs <= 0) {
      throw new InstagramParsingError("send_verification_timeout");
    }
    await page.waitForTimeout(settleDelayMs);
    await this.throwIfInstagramAuthRequired(page, "open_thread", deadlineAtMs);
    const selectorTimeoutMs = remainingOpenTimeout();
    await Promise.any([
      page.waitForSelector(selectors.message_container, { timeout: selectorTimeoutMs }),
      page.waitForSelector(selectors.composer_input, { timeout: selectorTimeoutMs }),
      page.waitForSelector(selectors.message_item, { timeout: selectorTimeoutMs })
    ]);

    await this.verifyCurrentThreadIdentity(
      page,
      selectors,
      thread,
      platformThreadId,
      requireRecipientHeader,
      verificationPhase,
      deadlineAtMs
    );

    return platformThreadId;
  }

  private async verifyCurrentThreadIdentity(
    page: Page,
    selectors: SelectorRegistry,
    thread: ThreadStub,
    platformThreadId: string,
    requireRecipientHeader: boolean,
    phase: "open" | "before_send",
    deadlineAtMs?: number
  ): Promise<void> {
    const remainingIdentityTimeout = (): number => {
      if (deadlineAtMs === undefined) {
        return 1_000;
      }
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        throw new InstagramParsingError("send_verification_timeout");
      }
      return Math.min(1_000, remainingMs);
    };
    const assertCurrentThreadUrl = (): void => {
      if (!instagramThreadUrlMatches(page.url(), platformThreadId)) {
        throw this.safeFailure(
          "THREAD_NOT_FOUND",
          "open_thread",
          phase === "before_send" ? "thread_changed_before_send" : "opened_thread_id_mismatch",
          platformThreadId
        );
      }
    };
    assertCurrentThreadUrl();

    const header = page
      .locator(selectors.conversation_header ?? "header h1, header h2, header span[title]")
      .first();
    const headerTimeoutMs = remainingIdentityTimeout();
    const [headerText, headerBody] = await Promise.all([
      header.getAttribute("title", { timeout: headerTimeoutMs }).catch(() => null),
      header.textContent({ timeout: headerTimeoutMs }).catch(() => "")
    ]);
    remainingIdentityTimeout();
    assertCurrentThreadUrl();
    const fallbackHeader = headerText || headerBody;
    const normalizedHeader = fallbackHeader?.replace(/\s+/g, " ").trim().normalize("NFKC").toLocaleLowerCase();
    const networkCapture = this.networkMessageCaptureStatus(page);
    const normalizedNetworkRecipient =
      networkCapture.expectedThreadId === platformThreadId
        ? networkCapture.recipientVerificationLabel
            ?.replace(/\s+/g, " ")
            .trim()
            .normalize("NFKC")
            .toLocaleLowerCase()
        : undefined;
    const normalizedRecipient = thread.recipientVerificationLabel
      ?.replace(/\s+/g, " ")
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase();
    const hasSpecificRecipient =
      Boolean(normalizedRecipient) && normalizedRecipient !== "instagram conversation";
    if (
      requireRecipientHeader &&
      (!hasSpecificRecipient || (!normalizedHeader && !normalizedNetworkRecipient))
    ) {
      throw this.safeFailure(
        "THREAD_NOT_FOUND",
        "open_thread",
        phase === "before_send" ? "recipient_unverified_before_send" : "recipient_unverified",
        platformThreadId
      );
    }
    if (normalizedHeader && hasSpecificRecipient && normalizedHeader !== normalizedRecipient) {
      throw this.safeFailure(
        "THREAD_NOT_FOUND",
        "open_thread",
        phase === "before_send" ? "recipient_changed_before_send" : "opened_recipient_mismatch",
        platformThreadId
      );
    }
    if (
      normalizedNetworkRecipient &&
      hasSpecificRecipient &&
      normalizedNetworkRecipient !== normalizedRecipient
    ) {
      throw this.safeFailure(
        "THREAD_NOT_FOUND",
        "open_thread",
        phase === "before_send" ? "recipient_changed_before_send" : "opened_recipient_mismatch",
        platformThreadId
      );
    }
  }

  private async snapshotMessages(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<InstagramMessageSnapshot[]> {
    const documentRoot = await page.$("body");
    if (!documentRoot) {
      throw new InstagramParsingError("instagram_document_missing");
    }
    await documentRoot.evaluate(INSTAGRAM_RUNTIME_SHIM_SOURCE);
    return documentRoot.evaluate(
      (root, { selectors }) => {
        const clean = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim();
        const matches = (root: Element, selector: string | undefined): boolean => {
          if (!selector) return false;
          try {
            return root.matches(selector) || Boolean(root.querySelector(selector));
          } catch {
            return false;
          }
        };
        const query = (root: Element, selector: string | undefined): Element | null => {
          if (!selector) return null;
          try {
            return root.matches(selector) ? root : root.querySelector(selector);
          } catch {
            return null;
          }
        };
        const queryAll = (root: Element, selector: string | undefined): Element[] => {
          if (!selector) return [];
          try {
            const descendants = Array.from(root.querySelectorAll(selector));
            return root.matches(selector) ? [root, ...descendants] : descendants;
          } catch {
            return [];
          }
        };
        const isRecipientImage = (candidate: Element): boolean => {
          const semantic = [
            candidate.getAttribute("alt"),
            candidate.getAttribute("aria-label"),
            candidate.getAttribute("data-testid"),
            candidate.className?.toString()
          ]
            .filter(Boolean)
            .join(" ");
          if (/\b(?:profile\s+(?:picture|photo)|avatar)\b/i.test(semantic)) {
            return true;
          }
          const anchor = candidate.closest("a[href]");
          const href = anchor?.getAttribute("href")?.trim();
          if (!href) return false;
          try {
            const pathname = new URL(href, "https://www.instagram.com").pathname;
            return pathname.startsWith("/direct/t/") || /^\/[^/]+\/?$/.test(pathname);
          } catch {
            return false;
          }
        };
        const broadContainer =
          root.querySelector(selectors.message_container) ??
          root.querySelector("main, div[role='main']");
        if (!broadContainer) {
          return [];
        }
        let container = broadContainer;
        const conversationAnchor =
          query(root, selectors.composer_input) ?? query(root, selectors.conversation_header);
        let candidateContainer = conversationAnchor?.parentElement ?? null;
        while (candidateContainer && candidateContainer !== broadContainer) {
          try {
            if (candidateContainer.querySelector(selectors.message_item)) {
              container = candidateContainer;
              break;
            }
          } catch {
            break;
          }
          candidateContainer = candidateContainer.parentElement;
        }
        const containerRect = container.getBoundingClientRect();
        return Array.from(container.querySelectorAll(selectors.message_item)).map((node) => {
          const root = node as HTMLElement;
          const threadLink = query(
            root,
            selectors.thread_link ?? "a[href^='/direct/t/']"
          );
          if (threadLink) {
            return null;
          }
          const semantic = [
            root.getAttribute("data-direction"),
            root.getAttribute("data-testid"),
            root.getAttribute("aria-label"),
            root.className?.toString()
          ]
            .filter(Boolean)
            .join(" ");
          const explicitIn =
            matches(root, selectors.message_direction_in) ||
            /\b(incoming|received|message-in|other|left)\b/i.test(semantic);
          const explicitOut =
            matches(root, selectors.message_direction_out) ||
            /\b(outgoing|sent|message-out|self|mine|right)\b/i.test(semantic);
          const rect = root.getBoundingClientRect();
          const delta = rect.left + rect.width / 2 - (containerRect.left + containerRect.width / 2);
          const layoutDirection =
            Math.abs(delta) >= Math.max(12, containerRect.width * 0.08)
              ? delta > 0
                ? "OUT"
                : "IN"
              : null;
          const direction: InstagramDirectionEvidence =
            explicitIn && explicitOut
              ? "AMBIGUOUS"
              : explicitIn
                ? "IN"
                : explicitOut
                  ? "OUT"
                  : layoutDirection ?? "AMBIGUOUS";
          const idNode = query(root, selectors.message_id);
          const nativeId =
            root.getAttribute("data-message-id") ||
            root.getAttribute("data-id") ||
            idNode?.getAttribute("data-message-id") ||
            idNode?.getAttribute("data-id") ||
            undefined;
          const textNode = query(root, selectors.message_text);
          const timestampNode = query(root, selectors.message_timestamp ?? "time[datetime]");
          const senderNode = query(root, selectors.message_sender);
          const mediaNode = queryAll(
            root,
            selectors.message_media ?? "img:not([alt='']), video, audio"
          ).find((candidate) => {
            if (candidate.tagName.toLowerCase() !== "img") return true;
            return !isRecipientImage(candidate);
          }) as HTMLElement | undefined;
          const mediaSignal = [
            mediaNode?.tagName,
            mediaNode?.getAttribute("aria-label"),
            mediaNode?.getAttribute("alt")
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          const mediaKind: InstagramMessageSnapshot["mediaKind"] = !mediaNode
            ? undefined
            : /voice|audio/.test(mediaSignal)
              ? "voice_message"
              : /video/.test(mediaSignal)
                ? "video"
                : /img|photo|image/.test(mediaSignal)
                  ? "photo"
                  : "attachment";
          return {
            nativeId,
            nativeIdStable: Boolean(nativeId),
            direction,
            text: clean(textNode?.textContent),
            senderName: clean(senderNode?.textContent) || undefined,
            sourceTimestamp:
              timestampNode?.getAttribute("datetime") ||
              timestampNode?.getAttribute("title") ||
              undefined,
            mediaKind,
            deleted:
              matches(root, selectors.message_deleted) ||
              /message (?:was )?(?:deleted|unavailable)/i.test(clean(root.textContent))
          };
        }).filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
      },
      { selectors }
    );
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    let platformThreadId: string | undefined;
    try {
      platformThreadId = threadIdForStub(thread);
      this.beginNetworkMessageCapture(page, platformThreadId);
      await this.openExactThread(page, selectors, thread);
      const networkReady = await this.waitForNetworkMessageCapture(page, 8_000);
      const networkCapture = this.networkMessageCaptureStatus(page);
      const recipientHeader = page
        .locator(selectors.conversation_header ?? "header h1, header h2, header span[title]")
        .first();
      const discoveredRecipient = (
        (networkReady ? networkCapture.recipientVerificationLabel : undefined) ??
        (await recipientHeader.getAttribute("title", { timeout: 1_000 }).catch(() => null)) ??
        (await recipientHeader.textContent({ timeout: 1_000 }).catch(() => null))
      )?.replace(/\s+/g, " ").trim();
      if (
        discoveredRecipient &&
        discoveredRecipient.toLocaleLowerCase() !== "instagram conversation"
      ) {
        thread.recipientVerificationLabel = discoveredRecipient;
      }
      const domSnapshots = await this.snapshotMessages(page, selectors);
      const snapshots = networkReady && networkCapture.snapshots.length > 0
        ? networkCapture.snapshots
        : domSnapshots;
      if (snapshots.length === 0) {
        throw new InstagramParsingError("message_selector_returned_no_rows");
      }
      return normalizeInstagramMessageSnapshots(platformThreadId, snapshots).slice(-limit);
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      const reason =
        error instanceof InstagramParsingError ? error.reason : "message_parse_failed";
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "parse",
        reason,
        platformThreadId,
        error
      );
    }
  }

  private async enabledCandidates(locator: Locator): Promise<Locator[]> {
    const count = await locator.count();
    const enabled: Locator[] = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = count === 1 ? locator : locator.nth(index);
      if (
        (await candidate.isVisible().catch(() => false)) &&
        (await candidate.isEnabled().catch(() => false)) &&
        (await candidate.getAttribute("aria-disabled")) !== "true"
      ) {
        enabled.push(candidate);
      }
    }
    return enabled;
  }

  private async requireEnabled(locator: Locator, reason: string): Promise<Locator> {
    const enabled = await this.enabledCandidates(locator);
    if (enabled.length === 0) {
      throw new InstagramParsingError(`${reason}_disabled`);
    }
    if (enabled.length !== 1) {
      throw new InstagramParsingError(`${reason}_not_unique`);
    }
    return enabled[0]!;
  }

  private async readComposerText(composer: Locator | ElementHandle): Promise<string> {
    const inputValue = await composer.inputValue().catch(() => null);
    if (inputValue !== null) {
      return cleanMessageText(inputValue);
    }
    return cleanMessageText((await composer.textContent().catch(() => "")) ?? "");
  }

  private async verifyComposerText(
    composer: Locator | ElementHandle,
    expectedText: string
  ): Promise<void> {
    if ((await this.readComposerText(composer)) !== expectedText) {
      throw new InstagramParsingError("composer_text_mismatch_before_send");
    }
  }

  private async runAtomicComposerAction(input: {
    composer: ElementHandle;
    composerConversationContainer: ElementHandle;
    composerDocumentPath: ElementHandle[];
    sendButton?: ElementHandle;
    sendOwner?: ElementHandle;
    sendConversationContainer?: ElementHandle;
    sendComposerPath?: ElementHandle[];
    sendPath?: ElementHandle[];
    sendOwnerDocumentPath?: ElementHandle[];
    selectors: SelectorRegistry;
    thread: ThreadStub;
    platformThreadId: string;
    action: "focus" | "type" | "send";
    expectedText: string;
    unit?: string;
  }): Promise<{ ok: true; clickedAtMs?: number } | { ok: false; reason: string }> {
    return input.composer.evaluate(
      (
        composerNode,
        {
          composerConversationContainer,
          composerDocumentPath,
          sendButton,
          sendOwner,
          sendConversationContainer,
          sendComposerPath,
          sendPath,
          sendOwnerDocumentPath,
          headerSelector,
          recipientVerificationLabel,
          platformThreadId,
          action,
          expectedText,
          unit
        }
      ) => {
        const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
        const normalizeIdentity = (value: string | null | undefined): string =>
          (value ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .normalize("NFKC")
            .toLocaleLowerCase();
        const currentThreadMatches = (): boolean => {
          if (
            window.location.hostname !== "www.instagram.com" &&
            window.location.hostname !== "instagram.com"
          ) {
            return false;
          }
          const match = window.location.pathname.match(/^\/direct\/t\/([^/?#]+)\/?$/i);
          if (!match?.[1]) return false;
          try {
            return decodeURIComponent(match[1]) === platformThreadId;
          } catch {
            return false;
          }
        };
        const isElementVisible = (element: Element): boolean => {
          if (
            !element.isConnected ||
            element.closest("[hidden], [aria-hidden='true'], [inert]")
          ) {
            return false;
          }
          const style = window.getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            element.getClientRects().length > 0
          );
        };
        const documentPath = (node: Element): Element[] => {
          const path: Element[] = [];
          let ancestor = node.parentElement;
          while (ancestor) {
            path.push(ancestor);
            ancestor = ancestor.parentElement;
          }
          return path;
        };
        const pathMatches = (boundPath: Element[], currentPath: Element[] | null): boolean => {
          if (!currentPath || boundPath.length !== currentPath.length) {
            return false;
          }
          return boundPath.every(
            (element, index) =>
              element.isConnected &&
              element.ownerDocument === document &&
              element === currentPath[index]
          );
        };
        const resolveConversationEvidence = (): {
          container: Element;
          labels: string[];
        } | null => {
          let headerCandidates: Element[];
          try {
            headerCandidates = Array.from(document.querySelectorAll(headerSelector));
          } catch {
            return null;
          }
          let container: Element | null = composerNode as Element;
          while (container) {
            if (container.matches("main, [role='main']") && isElementVisible(container)) {
              const labels = headerCandidates
                .filter((header) => container?.contains(header) && isElementVisible(header))
                .map((header) =>
                  normalizeIdentity(header.getAttribute("title") || header.textContent)
                )
                .filter((label) => label.length > 0);
              if (labels.length > 0) {
                return { container, labels: [...new Set(labels)] };
              }
            }
            container = container.parentElement;
          }
          return null;
        };
        const currentRecipientMatches = (): { ok: true } | { ok: false; reason: string } => {
          const evidence = resolveConversationEvidence();
          const normalizedRecipient = normalizeIdentity(recipientVerificationLabel);
          if (
            !normalizedRecipient ||
            normalizedRecipient === "instagram conversation" ||
            !evidence ||
            evidence.labels.length === 0
          ) {
            return fail("recipient_unverified_before_send");
          }
          return evidence.labels.length === 1 && evidence.labels[0] === normalizedRecipient
            ? { ok: true }
            : fail("recipient_changed_before_send");
        };
        const readComposer = (): string => {
          const element = composerNode as HTMLElement & { value?: string };
          const value = typeof element.value === "string" ? element.value : element.textContent ?? "";
          return value.replace(/\u00a0/g, " ");
        };
        const cleanComposer = (): string =>
          readComposer()
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        const verifyOwnership = (): { ok: true } | { ok: false; reason: string } => {
          if (
            !composerNode.isConnected ||
            composerNode.ownerDocument !== document ||
            !isElementVisible(composerNode as Element)
          ) {
            return fail("composer_detached");
          }
          if (!currentThreadMatches()) {
            return fail("thread_changed_before_send");
          }
          if (
            !composerConversationContainer ||
            !composerConversationContainer.isConnected ||
            composerConversationContainer.ownerDocument !== document ||
            !Array.isArray(composerDocumentPath) ||
            !pathMatches(
              composerDocumentPath as Element[],
              documentPath(composerNode as Element)
            )
          ) {
            return fail("composer_owner_changed_before_send");
          }
          const conversationEvidence = resolveConversationEvidence();
          if (conversationEvidence?.container !== composerConversationContainer) {
            return fail("composer_owner_changed_before_send");
          }
          const recipient = currentRecipientMatches();
          if (!recipient.ok) return recipient;
          return currentThreadMatches() ? { ok: true } : fail("thread_changed_before_send");
        };
        const ownership = verifyOwnership();
        if (!ownership.ok) return ownership;

        const composerElement = composerNode as HTMLElement & {
          value?: string;
          selectionStart?: number | null;
          selectionEnd?: number | null;
          setRangeText?: (
            replacement: string,
            start?: number,
            end?: number,
            selectionMode?: "select" | "start" | "end" | "preserve"
          ) => void;
        };
        if (action === "focus") {
          if (readComposer() !== expectedText) {
            return fail("composer_text_mismatch_before_send");
          }
          composerElement.focus();
          const ownershipAfterFocus = verifyOwnership();
          if (!ownershipAfterFocus.ok) return ownershipAfterFocus;
          composerElement.click();
          return verifyOwnership();
        }

        if (action === "type") {
          if (readComposer() !== expectedText || typeof unit !== "string") {
            return fail("composer_text_mismatch_before_send");
          }
          composerElement.focus();
          const ownershipAfterFocus = verifyOwnership();
          if (!ownershipAfterFocus.ok) return ownershipAfterFocus;

          const priorValue = typeof composerElement.value === "string"
            ? composerElement.value
            : null;
          const priorHtml = priorValue === null ? composerElement.innerHTML : null;
          if (priorValue !== null && typeof composerElement.setRangeText === "function") {
            composerElement.setRangeText(
              unit,
              priorValue.length,
              priorValue.length,
              "end"
            );
          } else {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(composerElement);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
            range.insertNode(document.createTextNode(unit));
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
          const inputEvent = typeof InputEvent === "function"
            ? new InputEvent("input", {
                bubbles: true,
                composed: true,
                data: unit,
                inputType: "insertText"
              })
            : new Event("input", { bubbles: true, composed: true });
          composerElement.dispatchEvent(inputEvent);

          if (!currentThreadMatches()) {
            if (priorValue !== null) {
              composerElement.value = priorValue;
            } else if (priorHtml !== null) {
              composerElement.innerHTML = priorHtml;
            }
            return fail("thread_changed_before_send");
          }
          const recipientAfterInput = currentRecipientMatches();
          if (!recipientAfterInput.ok) {
            if (priorValue !== null) {
              composerElement.value = priorValue;
            } else if (priorHtml !== null) {
              composerElement.innerHTML = priorHtml;
            }
            return recipientAfterInput;
          }
          return readComposer() === `${expectedText}${unit}`
            ? { ok: true }
            : fail("composer_text_mismatch_before_send");
        }

        if (cleanComposer() !== expectedText) {
          return fail("composer_text_mismatch_before_send");
        }
        if (
          !sendButton ||
          !sendButton.isConnected ||
          sendButton.ownerDocument !== document
        ) {
          return fail("send_button_detached");
        }
        const sendElement = sendButton as Element;
        const normalizeControlLabel = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        const labels = [
          sendElement.getAttribute("aria-label"),
          sendElement.getAttribute("title"),
          sendElement.textContent,
          (sendElement as HTMLInputElement).value
        ];
        const exactSend = labels.some((value) => normalizeControlLabel(value) === "send");
        if (!exactSend) {
          return fail("send_button_not_owned");
        }
        const finalOwnership = verifyOwnership();
        if (!finalOwnership.ok) return finalOwnership;
        const conversationEvidence = resolveConversationEvidence();
        if (!conversationEvidence?.container.contains(sendElement)) {
          return fail("send_button_not_owned");
        }
        if (
          !sendOwner ||
          !sendOwner.isConnected ||
          sendOwner.ownerDocument !== document ||
          !sendConversationContainer ||
          !sendConversationContainer.isConnected ||
          sendConversationContainer.ownerDocument !== document ||
          !Array.isArray(sendComposerPath) ||
          !Array.isArray(sendPath) ||
          !Array.isArray(sendOwnerDocumentPath)
        ) {
          return fail("send_button_not_owned");
        }
        const ownerElement = sendOwner as Element;
        const conversationContainerElement = sendConversationContainer as Element;
        const ancestorPath = (node: Element, ancestorBoundary: Element): Element[] | null => {
          const path: Element[] = [];
          let ancestor = node.parentElement;
          while (ancestor && ancestor !== ancestorBoundary) {
            path.push(ancestor);
            ancestor = ancestor.parentElement;
          }
          return ancestor === ancestorBoundary ? path : null;
        };
        let currentLocalOwner: Element | null = sendElement.parentElement;
        while (currentLocalOwner && !currentLocalOwner.contains(composerNode as Element)) {
          currentLocalOwner = currentLocalOwner.parentElement;
        }
        if (
          ownerElement === document.body ||
          ownerElement === document.documentElement ||
          ownerElement.matches("main, [role='main']") ||
          conversationEvidence.container !== conversationContainerElement ||
          conversationContainerElement !== composerConversationContainer ||
          currentLocalOwner !== ownerElement ||
          !ownerElement.contains(composerNode as Element) ||
          !ownerElement.contains(sendElement) ||
          !pathMatches(
            sendComposerPath as Element[],
            ancestorPath(composerNode as Element, ownerElement)
          ) ||
          !pathMatches(sendPath as Element[], ancestorPath(sendElement, ownerElement)) ||
          !pathMatches(sendOwnerDocumentPath as Element[], documentPath(ownerElement))
        ) {
          return fail("send_button_not_owned");
        }
        const composerForm = composerElement.closest("form");
        const sendForm = sendElement.closest("form");
        if ((composerForm || sendForm) && composerForm !== sendForm) {
          return fail("send_button_not_owned");
        }
        const composerRect = composerElement.getBoundingClientRect();
        const associatedSendRect = sendElement.getBoundingClientRect();
        const composerCenterY = composerRect.top + composerRect.height / 2;
        const sendCenterY = associatedSendRect.top + associatedSendRect.height / 2;
        const sendCenterX = associatedSendRect.left + associatedSendRect.width / 2;
        const sameRow =
          Math.abs(sendCenterY - composerCenterY) <= Math.max(36, composerRect.height);
        const maxHorizontalGap = Math.max(160, composerRect.height * 4);
        const horizontallyAssociated =
          sendCenterX >= composerRect.left &&
          sendCenterX <= composerRect.right + maxHorizontalGap;
        if (!sameRow || !horizontallyAssociated) {
          return fail("send_button_not_owned");
        }
        if (
          sendElement.hasAttribute("disabled") ||
          Boolean((sendElement as HTMLButtonElement).disabled) ||
          normalizeControlLabel(sendElement.getAttribute("aria-disabled")) === "true" ||
          sendElement.closest("[inert]")
        ) {
          return fail("send_button_disabled");
        }
        if (!isElementVisible(sendElement)) {
          return fail("send_button_not_actionable");
        }
        const sendStyle = window.getComputedStyle(sendElement);
        const sendRect = sendElement.getBoundingClientRect();
        const centerX = sendRect.left + sendRect.width / 2;
        const centerY = sendRect.top + sendRect.height / 2;
        const hitTarget = document.elementFromPoint(centerX, centerY);
        if (
          sendStyle.pointerEvents === "none" ||
          centerX < 0 ||
          centerY < 0 ||
          centerX > window.innerWidth ||
          centerY > window.innerHeight ||
          !hitTarget ||
          (hitTarget !== sendElement && !sendElement.contains(hitTarget))
        ) {
          return fail("send_button_not_actionable");
        }
        const clickedAtMs = Date.now();
        (sendElement as HTMLElement).click();
        return { ok: true, clickedAtMs };
      },
      {
        composerConversationContainer: input.composerConversationContainer,
        composerDocumentPath: input.composerDocumentPath,
        sendButton: input.sendButton,
        sendOwner: input.sendOwner,
        sendConversationContainer: input.sendConversationContainer,
        sendComposerPath: input.sendComposerPath,
        sendPath: input.sendPath,
        sendOwnerDocumentPath: input.sendOwnerDocumentPath,
        headerSelector:
          input.selectors.conversation_header ?? "header h1, header h2, header span[title]",
        recipientVerificationLabel: input.thread.recipientVerificationLabel,
        platformThreadId: input.platformThreadId,
        action: input.action,
        expectedText: input.expectedText,
        unit: input.unit
      }
    );
  }

  private assertAtomicComposerAction(
    result: { ok: true; clickedAtMs?: number } | { ok: false; reason: string },
    platformThreadId: string
  ): void {
    if (result.ok) {
      return;
    }
    if (
      result.reason === "thread_changed_before_send" ||
      result.reason === "recipient_unverified_before_send" ||
      result.reason === "recipient_changed_before_send"
    ) {
      throw this.safeFailure(
        "THREAD_NOT_FOUND",
        "open_thread",
        result.reason,
        platformThreadId
      );
    }
    throw new InstagramParsingError(result.reason);
  }

  private async disposeElementHandles(
    handles: Array<ElementHandle | null | undefined>
  ): Promise<void> {
    const uniqueHandles = [
      ...new Set(handles.filter((handle): handle is ElementHandle => Boolean(handle)))
    ];
    await Promise.all(
      uniqueHandles.map((handle) => handle.dispose().catch(() => undefined))
    );
  }

  private async disposeComposerSendBinding(
    binding: InstagramComposerSendBinding
  ): Promise<void> {
    await this.disposeElementHandles([
      binding.button,
      binding.owner,
      binding.conversationContainer,
      ...binding.composerPath,
      ...binding.sendPath,
      ...binding.ownerDocumentPath
    ]);
  }

  private async disposeComposerOwnershipBinding(
    binding: InstagramComposerOwnershipBinding
  ): Promise<void> {
    await this.disposeElementHandles([
      binding.conversationContainer,
      ...binding.documentPath
    ]);
  }

  private async readElementHandlePath(
    pathHandle: JSHandle | undefined
  ): Promise<ElementHandle[] | null> {
    if (!pathHandle) {
      return null;
    }
    const properties = await pathHandle.getProperties().catch(() => null);
    await pathHandle.dispose().catch(() => undefined);
    if (!properties) {
      return null;
    }
    const indexed = [...properties.entries()]
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right));
    const elements = indexed.map(([, handle]) => handle.asElement());
    const complete = indexed.every(([key], index) => Number(key) === index);
    if (!complete || elements.some((element) => !element)) {
      await Promise.all(
        [...properties.values()].map((handle) => handle.dispose().catch(() => undefined))
      );
      return null;
    }
    const retained = new Set(indexed.map(([, handle]) => handle));
    await Promise.all(
      [...properties.values()]
        .filter((handle) => !retained.has(handle))
        .map((handle) => handle.dispose().catch(() => undefined))
    );
    return elements as ElementHandle[];
  }

  private async requireComposerOwnershipBinding(
    composer: ElementHandle,
    conversationHeaderSelector = "header h1, header h2, header span[title]"
  ): Promise<InstagramComposerOwnershipBinding> {
    const structureHandle = await composer
      .evaluateHandle((composerNode, headerSelector) => {
        const composerElement = composerNode as Element;
        const isElementVisible = (element: Element): boolean => {
          if (
            !element.isConnected ||
            element.closest("[hidden], [aria-hidden='true'], [inert]")
          ) {
            return false;
          }
          const style = window.getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0" &&
            element.getClientRects().length > 0
          );
        };
        let headerCandidates: Element[];
        try {
          headerCandidates = Array.from(document.querySelectorAll(headerSelector));
        } catch {
          return {};
        }
        let conversationContainer: Element | null = composerElement;
        while (conversationContainer) {
          if (
            conversationContainer.matches("main, [role='main']") &&
            isElementVisible(conversationContainer) &&
            headerCandidates.some(
              (header) =>
                conversationContainer?.contains(header) && isElementVisible(header)
            )
          ) {
            break;
          }
          conversationContainer = conversationContainer.parentElement;
        }
        if (!conversationContainer) {
          return {};
        }
        const documentPath: Element[] = [];
        let ancestor = composerElement.parentElement;
        while (ancestor) {
          documentPath.push(ancestor);
          ancestor = ancestor.parentElement;
        }
        if (!documentPath.includes(conversationContainer)) {
          return {};
        }
        return { conversationContainer, documentPath };
      }, conversationHeaderSelector)
      .catch(() => null);
    const structure = await structureHandle?.getProperties().catch(() => null);
    await structureHandle?.dispose().catch(() => undefined);
    const conversationContainer =
      structure?.get("conversationContainer")?.asElement() ?? null;
    const documentPath = await this.readElementHandlePath(
      structure?.get("documentPath")
    );
    if (!conversationContainer || !documentPath) {
      await this.disposeElementHandles([
        conversationContainer,
        ...(documentPath ?? [])
      ]);
      throw new InstagramParsingError("composer_owner_unverified");
    }
    return { conversationContainer, documentPath };
  }

  private async requireComposerSendButton(
    page: Page,
    composer: Locator | ElementHandle,
    selector: string,
    conversationHeaderSelector = "header h1, header h2, header span[title]"
  ): Promise<InstagramComposerSendBinding> {
    let candidates = await this.enabledCandidates(page.locator(selector));
    if (candidates.length === 0) {
      candidates = await this.enabledCandidates(
        page.getByRole("button", { name: "Send", exact: true })
      );
    }
    if (candidates.length === 0) {
      throw new InstagramParsingError("send_button_disabled");
    }

    const composerHandle =
      "elementHandle" in composer && typeof composer.elementHandle === "function"
        ? await composer.elementHandle()
        : composer;
    if (!composerHandle) {
      throw new InstagramParsingError("composer_not_visible");
    }
    const composerBox = await composerHandle.boundingBox();
    if (!composerBox) {
      throw new InstagramParsingError("composer_not_visible");
    }
    const composerCenterY = composerBox.y + composerBox.height / 2;
    const composerRight = composerBox.x + composerBox.width;
    const maxHorizontalGap = Math.max(160, composerBox.height * 4);
    const nearby: InstagramComposerSendBinding[] = [];
    for (const candidate of candidates) {
      const candidateHandle = await candidate.elementHandle();
      if (!candidateHandle) continue;
      const association = await candidateHandle
        .evaluate((button, composerNode) => {
          const buttonElement = button as Element;
          const normalize = (value: string | null | undefined): string =>
            (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
          const labels = [
            buttonElement.getAttribute("aria-label"),
            buttonElement.getAttribute("title"),
            buttonElement.textContent,
            (buttonElement as HTMLInputElement).value
          ];
          const exactSend = labels.some((value) => normalize(value) === "send");
          return { exactSend };
        }, composerHandle)
        .catch(() => null);
      if (!association?.exactSend) {
        await candidateHandle.dispose().catch(() => undefined);
        continue;
      }
      const structureHandle = await candidateHandle
        .evaluateHandle((button, { composerNode, conversationHeaderSelector }) => {
          const buttonElement = button as Element;
          const composerElement = composerNode as Element;
          const isElementVisible = (element: Element): boolean => {
            if (
              !element.isConnected ||
              element.closest("[hidden], [aria-hidden='true'], [inert]")
            ) {
              return false;
            }
            const style = window.getComputedStyle(element);
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              element.getClientRects().length > 0
            );
          };
          let headerCandidates: Element[];
          try {
            headerCandidates = Array.from(
              document.querySelectorAll(conversationHeaderSelector)
            );
          } catch {
            return {};
          }
          let conversationContainer: Element | null = composerElement;
          while (conversationContainer) {
            if (
              conversationContainer.matches("main, [role='main']") &&
              isElementVisible(conversationContainer) &&
              headerCandidates.some(
                (header) =>
                  conversationContainer?.contains(header) && isElementVisible(header)
              )
            ) {
              break;
            }
            conversationContainer = conversationContainer.parentElement;
          }
          if (!conversationContainer || !conversationContainer.contains(buttonElement)) {
            return {};
          }
          let owner = buttonElement.parentElement;
          while (owner && !owner.contains(composerNode as Element)) {
            owner = owner.parentElement;
          }
          if (
            !owner ||
            owner === document.body ||
            owner === document.documentElement ||
            owner.matches("main, [role='main']")
          ) {
            return {};
          }
          const ancestorPath = (node: Element): Element[] | null => {
            const path: Element[] = [];
            let ancestor = node.parentElement;
            while (ancestor && ancestor !== owner) {
              path.push(ancestor);
              ancestor = ancestor.parentElement;
            }
            return ancestor === owner ? path : null;
          };
          const composerPath = ancestorPath(composerElement);
          const sendPath = ancestorPath(buttonElement);
          if (!composerPath || !sendPath) {
            return {};
          }
          const ownerDocumentPath: Element[] = [];
          let ancestor = owner.parentElement;
          while (ancestor) {
            ownerDocumentPath.push(ancestor);
            ancestor = ancestor.parentElement;
          }
          if (!ownerDocumentPath.includes(conversationContainer)) {
            return {};
          }
          return {
            owner,
            conversationContainer,
            composerPath,
            sendPath,
            ownerDocumentPath
          };
        }, { composerNode: composerHandle, conversationHeaderSelector })
        .catch(() => null);
      const structure = await structureHandle?.getProperties().catch(() => null);
      await structureHandle?.dispose().catch(() => undefined);
      const owner = structure?.get("owner")?.asElement() ?? null;
      const conversationContainer =
        structure?.get("conversationContainer")?.asElement() ?? null;
      const composerPath = await this.readElementHandlePath(structure?.get("composerPath"));
      const sendPath = await this.readElementHandlePath(structure?.get("sendPath"));
      const ownerDocumentPath = await this.readElementHandlePath(
        structure?.get("ownerDocumentPath")
      );
      if (
        !owner ||
        !conversationContainer ||
        !composerPath ||
        !sendPath ||
        !ownerDocumentPath
      ) {
        await this.disposeElementHandles([
          candidateHandle,
          owner,
          conversationContainer,
          ...(composerPath ?? []),
          ...(sendPath ?? []),
          ...(ownerDocumentPath ?? [])
        ]);
        continue;
      }
      const binding = {
        button: candidateHandle,
        owner,
        conversationContainer,
        composerPath,
        sendPath,
        ownerDocumentPath
      };
      const box = await candidateHandle.boundingBox();
      if (!box) {
        await this.disposeComposerSendBinding(binding);
        continue;
      }
      const centerY = box.y + box.height / 2;
      const centerX = box.x + box.width / 2;
      const sameRow = Math.abs(centerY - composerCenterY) <= Math.max(36, composerBox.height);
      const horizontallyAssociated =
        centerX >= composerBox.x && centerX <= composerRight + maxHorizontalGap;
      if (sameRow && horizontallyAssociated) {
        nearby.push(binding);
      } else {
        await this.disposeComposerSendBinding(binding);
      }
    }
    if (nearby.length !== 1) {
      await Promise.all(nearby.map((binding) => this.disposeComposerSendBinding(binding)));
      throw new InstagramParsingError("send_button_not_unique");
    }
    return nearby[0]!;
  }

  async sendMessage(
    thread: ThreadStub,
    text: string,
    attachments: OutboundAttachment[] = [],
    beforeDispatch?: () => Promise<void>
  ): Promise<SendReceipt> {
    if (attachments.length > 0) {
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "persist",
        "text_only_send_required",
        thread.platformThreadId
      );
    }
    const normalizedText = cleanMessageText(text);
    if (!normalizedText) {
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "persist",
        "empty_message_rejected",
        thread.platformThreadId
      );
    }
    if (normalizedText.includes("\n")) {
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "persist",
        "multiline_message_not_supported",
        thread.platformThreadId
      );
    }

    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    let platformThreadId: string | undefined;
    let submissionMayHaveOccurred = false;
    let dispatchStartedAt: number | null = null;
    let sendCaptureGeneration: number | null = null;
    let composerOwnership: InstagramComposerOwnershipBinding | null = null;
    let verificationPage: Page | null = null;
    try {
      platformThreadId = threadIdForStub(thread);
      this.beginNetworkMessageCapture(page, platformThreadId);
      platformThreadId = await this.openExactThread(
        page,
        selectors,
        thread,
        false,
        "before_send"
      );
      await this.verifyCurrentThreadIdentity(
        page,
        selectors,
        thread,
        platformThreadId,
        true,
        "before_send"
      );
      const preSendNetworkReady = await this.waitForNetworkMessageCapture(page, 8_000);
      const networkBefore = this.networkMessageCaptureStatus(page);
      if (
        !preSendNetworkReady ||
        !networkBefore.matchedThread ||
        networkBefore.expectedThreadId !== platformThreadId
      ) {
        throw new InstagramParsingError("message_network_capture_incomplete_before_send");
      }
      if (!instagramThreadUrlMatches(page.url(), platformThreadId)) {
        throw new InstagramParsingError("thread_changed_before_send");
      }
      const expectedRecipient = thread.recipientVerificationLabel
        ?.replace(/\s+/g, " ")
        .trim()
        .normalize("NFKC")
        .toLocaleLowerCase();
      const networkRecipient = networkBefore.recipientVerificationLabel
        ?.replace(/\s+/g, " ")
        .trim()
        .normalize("NFKC")
        .toLocaleLowerCase();
      if (!expectedRecipient || expectedRecipient === "instagram conversation" || !networkRecipient) {
        throw new InstagramParsingError("recipient_unverified_before_send");
      }
      if (networkRecipient !== expectedRecipient) {
        throw new InstagramParsingError("recipient_changed_before_send");
      }
      const before = normalizeInstagramMessageSnapshots(
        platformThreadId,
        networkBefore.snapshots
      );
      const composerLocator = await this.requireEnabled(
        page.locator(selectors.composer_input),
        "composer"
      );
      const composer = await composerLocator.elementHandle();
      if (!composer) {
        throw new InstagramParsingError("composer_detached");
      }
      composerOwnership = await this.requireComposerOwnershipBinding(
        composer,
        selectors.conversation_header ?? "header h1, header h2, header span[title]"
      );
      await this.verifyCurrentThreadIdentity(
        page,
        selectors,
        thread,
        platformThreadId,
        true,
        "before_send"
      );
      const existingComposerText = await this.readComposerText(composer);
      if (existingComposerText && existingComposerText !== normalizedText) {
        throw new InstagramParsingError("composer_contains_unsent_text");
      }
      await this.verifyCurrentThreadIdentity(
        page,
        selectors,
        thread,
        platformThreadId,
        true,
        "before_send"
      );
      if (!existingComposerText) {
        await humanClick(page, composer, {
          timeout: 10_000,
          performClick: async () => {
            const result = await this.runAtomicComposerAction({
              composer,
              composerConversationContainer: composerOwnership!.conversationContainer,
              composerDocumentPath: composerOwnership!.documentPath,
              selectors,
              thread,
              platformThreadId: platformThreadId!,
              action: "focus",
              expectedText: ""
            });
            this.assertAtomicComposerAction(result, platformThreadId!);
          }
        });
        let typedPrefix = "";
        await humanType(page, composer, normalizedText, {
          alreadyFocused: true,
          reading: null,
          typeUnit: async (unit) => {
            const result = await this.runAtomicComposerAction({
              composer,
              composerConversationContainer: composerOwnership!.conversationContainer,
              composerDocumentPath: composerOwnership!.documentPath,
              selectors,
              thread,
              platformThreadId: platformThreadId!,
              action: "type",
              expectedText: typedPrefix,
              unit
            });
            this.assertAtomicComposerAction(result, platformThreadId!);
            typedPrefix += unit;
          }
        });
      }
      await this.verifyComposerText(composer, normalizedText);
      await readingPause(500, 1_100);

      const boundSend = await this.requireComposerSendButton(
        page,
        composer,
        selectors.send_button,
        selectors.conversation_header ?? "header h1, header h2, header span[title]"
      );
      try {
        await humanClick(page, boundSend.button, {
          timeout: 10_000,
          reading: null,
          performClick: async () => {
            await beforeDispatch?.();
            sendCaptureGeneration = this.beginNetworkSendCapture(
              page,
              platformThreadId!,
              normalizedText
            );
            submissionMayHaveOccurred = true;
            const result = await this.runAtomicComposerAction({
              composer,
              composerConversationContainer: composerOwnership!.conversationContainer,
              composerDocumentPath: composerOwnership!.documentPath,
              sendButton: boundSend.button,
              sendOwner: boundSend.owner,
              sendConversationContainer: boundSend.conversationContainer,
              sendComposerPath: boundSend.composerPath,
              sendPath: boundSend.sendPath,
              sendOwnerDocumentPath: boundSend.ownerDocumentPath,
              selectors,
              thread,
              platformThreadId: platformThreadId!,
              action: "send",
              expectedText: normalizedText
            });
            if (!result.ok) {
              submissionMayHaveOccurred = false;
            } else {
              dispatchStartedAt = result.clickedAtMs ?? null;
              if (
                dispatchStartedAt === null ||
                sendCaptureGeneration === null ||
                !this.commitNetworkSendClick(
                  page,
                  sendCaptureGeneration,
                  dispatchStartedAt
                )
              ) {
                throw new InstagramParsingError("send_dispatch_timestamp_missing");
              }
            }
            this.assertAtomicComposerAction(result, platformThreadId!);
          }
        });
      } finally {
        await this.disposeComposerSendBinding(boundSend);
      }

      if (dispatchStartedAt === null) {
        throw new InstagramParsingError("send_dispatch_timestamp_missing");
      }
      const deadline = Date.now() + (this.instagramDeps.sendVerificationTimeoutMs ?? 12_000);
      const sendCaptureReady = await this.waitForNetworkSendCapture(
        page,
        Math.min(6_000, Math.max(1, deadline - Date.now()))
      );
      const sendCapture = this.networkSendCaptureStatus(page);
      if (
        !sendCaptureReady ||
        sendCaptureGeneration === null ||
        sendCapture.generation !== sendCaptureGeneration ||
        sendCapture.expectedThreadId !== platformThreadId ||
        sendCapture.unverifiableRequests !== 0 ||
        sendCapture.matchingRequests !== 1 ||
        sendCapture.pendingRequests !== 0 ||
        sendCapture.failedRequests !== 0 ||
        !sendCapture.outboundTransportBound ||
        !sendCapture.offlineThreadingId
      ) {
        throw new InstagramParsingError("send_transport_not_bound");
      }
      const expectedPlatformMessageKey = sendCapture.acknowledgedMessageId
        ? instagramStableMessageKey(
            platformThreadId,
            "native",
            sendCapture.acknowledgedMessageId
          )
        : undefined;
      verificationPage = await this.createSendVerificationPage(page);
      while (Date.now() < deadline) {
        this.beginNetworkMessageCapture(verificationPage, platformThreadId);
        await this.openExactThread(
          verificationPage,
          selectors,
          thread,
          false,
          "before_send",
          deadline
        );
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new InstagramParsingError("send_verification_timeout");
        }
        const postSendNetworkReady = await this.waitForNetworkMessageCapture(
          verificationPage,
          Math.min(6_000, remainingMs)
        );
        const networkAfter = this.networkMessageCaptureStatus(verificationPage);
        if (
          !postSendNetworkReady ||
          !networkAfter.matchedThread ||
          networkAfter.expectedThreadId !== platformThreadId
        ) {
          if (Date.now() < deadline) {
            await verificationPage.waitForTimeout(Math.min(250, deadline - Date.now()));
          }
          continue;
        }
        await this.verifyCurrentThreadIdentity(
          verificationPage,
          selectors,
          thread,
          platformThreadId,
          true,
          "before_send",
          deadline
        );
        const after = normalizeInstagramMessageSnapshots(
          platformThreadId,
          networkAfter.snapshots
        );
        const sent = findNewAcknowledgedInstagramOutgoing(
          before,
          after,
          normalizedText,
          dispatchStartedAt,
          Date.now(),
          0,
          expectedPlatformMessageKey,
          sendCapture.offlineThreadingId,
          sendCapture.acknowledgedTimestampMs
        );
        if (sent) {
          const finalRemainingMs = deadline - Date.now();
          if (finalRemainingMs <= 0) {
            throw new InstagramParsingError("send_verification_timeout");
          }
          const finalCaptureReady = await this.waitForNetworkSendCapture(
            page,
            Math.min(1_000, finalRemainingMs)
          );
          const finalCapture = this.networkSendCaptureStatus(page);
          if (
            !finalCaptureReady ||
            finalCapture.generation !== sendCaptureGeneration ||
            finalCapture.expectedThreadId !== platformThreadId ||
            finalCapture.unverifiableRequests !== 0 ||
            finalCapture.matchingRequests !== 1 ||
            finalCapture.pendingRequests !== 0 ||
            finalCapture.failedRequests !== 0 ||
            !finalCapture.outboundTransportBound ||
            finalCapture.offlineThreadingId !== sendCapture.offlineThreadingId ||
            finalCapture.acknowledgedMessageId !== sendCapture.acknowledgedMessageId
          ) {
            throw new InstagramParsingError("send_transport_not_stable");
          }
          if (Date.now() > deadline) {
            throw new InstagramParsingError("send_verification_timeout");
          }
          return {
            sentAt: new Date().toISOString(),
            acknowledgedAt: new Date().toISOString(),
            verifiedBy: "platform_acknowledged",
            platformMessageKey: sent.platformMessageKey,
            raw: { verification: "mutation_bound_network_acknowledgement" }
          };
        }
        if (Date.now() < deadline) {
          await verificationPage.waitForTimeout(Math.min(250, deadline - Date.now()));
        }
      }

      throw new InstagramParsingError("submitted_message_not_observed");
    } catch (error) {
      if (submissionMayHaveOccurred) {
        throw this.safeFailure(
          "THREAD_FETCH_FAILED",
          "persist",
          "delivery_uncertain_after_submit",
          platformThreadId,
          error
        );
      }
      if (error instanceof AdapterFailure) {
        throw error;
      }
      const reason =
        error instanceof InstagramParsingError ? error.reason : "send_verification_failed";
      throw this.safeFailure(
        "THREAD_FETCH_FAILED",
        "persist",
        reason,
        platformThreadId,
        error
      );
    } finally {
      if (composerOwnership) {
        await this.disposeComposerOwnershipBinding(composerOwnership);
      }
      if (verificationPage) {
        await verificationPage.close().catch(() => undefined);
      }
    }
  }

  async openThread(thread: ThreadStub): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    try {
      this.beginNetworkMessageCapture(page, threadIdForStub(thread));
      await this.openExactThread(page, selectors, thread);
    } catch (error) {
      if (error instanceof AdapterFailure) {
        throw error;
      }
      const reason =
        error instanceof InstagramParsingError ? error.reason : "open_thread_failed";
      throw this.safeFailure("THREAD_NOT_FOUND", "open_thread", reason, undefined, error);
    } finally {
      await this.instagramDeps.sessionManager
        .revealWindow?.("INSTAGRAM", this.instagramDeps.personKey)
        .catch(() => undefined);
    }
  }
}
