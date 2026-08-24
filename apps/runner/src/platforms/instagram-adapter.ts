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
    const hasDirectThreadType = /direct.*thread/i.test(typeName ?? "");
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
    ].some((key) => key in record);
    const isThreadRecord =
      context.inThreadCollection &&
      (hasDirectThreadType || (!typeName && hasThreadStructure));
    const typedThreadId = isThreadRecord
      ? instagramString(record, ["id"])
      : undefined;
    const stableId = typedThreadId;
    if (isStableInstagramId(stableId)) {
      const participants = [record.users, record.participants]
        .flatMap((candidate) => (Array.isArray(candidate) ? candidate : []))
        .map(instagramRecord)
        .filter((candidate): candidate is Record<string, unknown> => Boolean(candidate))
        .map((candidate) =>
          instagramString(candidate, ["username", "full_name", "fullName", "name"])
        )
        .filter((candidate): candidate is string => Boolean(candidate));
      const unreadCount = [record.unread_count, record.unreadCount].find(
        (candidate) => typeof candidate === "number" && Number.isFinite(candidate)
      ) as number | undefined;
      const explicitUnread = [
        record.unread,
        record.has_unread,
        record.hasUnread,
        record.marked_as_unread,
        record.markedAsUnread
      ].find((candidate) => typeof candidate === "boolean") as boolean | undefined;
      const readState = instagramString(record, ["read_state", "readState"]);
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
          instagramString(record, ["thread_title", "threadTitle", "title", "name"]) ??
          (participants.slice(0, 3).join(", ") || undefined),
        unread
      });
    }

    for (const [key, child] of Object.entries(record)) {
      const inInboxPayload = context.inInboxPayload || /inbox/i.test(key);
      const startsThreadCollection =
        inInboxPayload &&
        !context.inThreadCollection &&
        !context.insideThreadRecord &&
        Array.isArray(child) &&
        /(?:^|_)(?:threads?|edges|items)(?:$|_)/i.test(key);
      visit(child, {
        inInboxPayload,
        inThreadCollection:
          startsThreadCollection ||
          (context.inThreadCollection && /^(?:node|item|thread)$/i.test(key)),
        insideThreadRecord: context.insideThreadRecord || isThreadRecord
      });
    }
  };

  visit(payload, {
    inInboxPayload: false,
    inThreadCollection: false,
    insideThreadRecord: false
  });
  return snapshots;
}

export function parseInstagramSourceTimestamp(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function instagramThreadUrlMatches(url: string, expectedThreadId: string): boolean {
  return instagramThreadIdFromUrl(url) === expectedThreadId;
}

export function findNewVerifiedInstagramOutgoing(
  before: NormalizedMessage[],
  after: NormalizedMessage[],
  text: string
): NormalizedMessage | null {
  const normalizedText = cleanMessageText(text);
  const beforeMatches = before.filter(
    (message) =>
      message.direction === "OUT" && cleanMessageText(message.text) === normalizedText
  );
  const afterMatches = after.filter(
    (message) =>
      message.direction === "OUT" && cleanMessageText(message.text) === normalizedText
  );
  return afterMatches.length > beforeMatches.length
    ? afterMatches[beforeMatches.length] ?? afterMatches.at(-1) ?? null
    : null;
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
        messageIdentityVersion: "instagram_stable_v2"
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
      const existing = existingEntry?.snapshot;
      this.byId.set(snapshot.stableId, {
        snapshot: {
          ...existing,
          ...snapshot,
          displayName: snapshot.displayName ?? existing?.displayName,
          unread: snapshot.unread ?? existing?.unread
        },
        requestOrder: existingEntry?.requestOrder ?? requestOrder,
        position: existingEntry?.position ?? position
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
  private readonly networkRequestTokens = new WeakMap<
    object,
    { generation: number; requestOrder: number }
  >();
  private readonly settledNetworkRequests = new WeakSet<object>();
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
    this.networkThreadCaptures.set(page, capture);
    page.on("request", (request: any) => {
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return;
      }
      if (
        (url.hostname !== "www.instagram.com" && url.hostname !== "instagram.com") ||
        !/\/api\/graphql$|\/graphql\/query$/i.test(url.pathname)
      ) {
        return;
      }
      const generation = capture.currentGeneration();
      const requestOrder = capture.startRequest(generation);
      if (requestOrder !== null) {
        this.networkRequestTokens.set(request, { generation, requestOrder });
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
        !/\/api\/graphql$|\/graphql\/query$/i.test(url.pathname)
      ) {
        return;
      }
      const request = typeof response.request === "function" ? response.request() : null;
      const token = request ? this.networkRequestTokens.get(request) : undefined;
      if (!request || !token) {
        return;
      }
      const settle = (succeeded: boolean): void => {
        if (this.settledNetworkRequests.has(request)) {
          return;
        }
        this.settledNetworkRequests.add(request);
        capture.finishRequest(token.generation, succeeded);
      };
      if (response.status() < 200 || response.status() >= 300) {
        settle(false);
        return;
      }
      void response
        .json()
        .then((payload: unknown) => {
          if (this.settledNetworkRequests.has(request)) {
            return;
          }
          if (instagramGraphQlPayloadHasErrors(payload)) {
            settle(false);
            return;
          }
          capture.accept(
            token.generation,
            extractInstagramThreadSnapshotsFromPayload(payload),
            token?.requestOrder
          );
          settle(true);
        })
        .catch(() => settle(false));
    });
    page.on("requestfailed", (request: object) => {
      const token = this.networkRequestTokens.get(request);
      if (!token || this.settledNetworkRequests.has(request)) {
        return;
      }
      this.settledNetworkRequests.add(request);
      capture.finishRequest(token.generation, false);
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

  private async throwIfInstagramAuthRequired(page: Page, context: string): Promise<void> {
    const requirement = await this.authRequirementForPage(page);
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
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    try {
      this.beginNetworkThreadCapture(page);
      await this.navigateToInbox(page, selectors, 12_000);
      await Promise.race([
        page
          .waitForSelector(selectors.thread_item, { state: "attached", timeout: 8_000 })
          .catch(() => undefined),
        this.waitForCapturedNetworkThreads(page, 8_000)
      ]);
      const threads = await this.snapshotThreads(page, selectors, limit);
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
      this.collectionCalls += 1;
      this.collectionObservedRows ||= threads.length > 0;
      this.collectionExplicitlyEmpty &&= explicitlyEmpty;
      this.collectionTotalFound = Math.max(this.collectionTotalFound, threads.length);
      this.collectionUnreadFound = Math.max(
        this.collectionUnreadFound,
        threads.filter((thread) => (thread.unreadCount ?? 0) > 0).length
      );
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

  beginCollectionCycle(): void {
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
    verificationPhase: "open" | "before_send" = "open"
  ): Promise<string> {
    const platformThreadId = threadIdForStub(thread);
    await page.goto(canonicalInstagramThreadUrl(platformThreadId), {
      waitUntil: "domcontentloaded",
      timeout: 12_000
    });
    await page.waitForTimeout(350);
    await this.throwIfInstagramAuthRequired(page, "open_thread");
    await Promise.race([
      page.waitForSelector(selectors.message_container, { timeout: 12_000 }),
      page.waitForSelector(selectors.composer_input, { timeout: 12_000 }),
      page.waitForSelector(selectors.message_item, { timeout: 12_000 })
    ]);

    await this.verifyCurrentThreadIdentity(
      page,
      selectors,
      thread,
      platformThreadId,
      requireRecipientHeader,
      verificationPhase
    );

    return platformThreadId;
  }

  private async verifyCurrentThreadIdentity(
    page: Page,
    selectors: SelectorRegistry,
    thread: ThreadStub,
    platformThreadId: string,
    requireRecipientHeader: boolean,
    phase: "open" | "before_send"
  ): Promise<void> {
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

    const headerText = await page
      .locator(selectors.conversation_header ?? "header h1, header h2, header span[title]")
      .first()
      .getAttribute("title")
      .catch(() => null);
    assertCurrentThreadUrl();
    const fallbackHeader = headerText
      ? headerText
      : await page
          .locator(selectors.conversation_header ?? "header h1, header h2, header span[title]")
          .first()
          .textContent()
          .catch(() => "");
    assertCurrentThreadUrl();
    const normalizedHeader = fallbackHeader?.replace(/\s+/g, " ").trim().normalize("NFKC").toLocaleLowerCase();
    const normalizedRecipient = thread.recipientVerificationLabel
      ?.replace(/\s+/g, " ")
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase();
    const hasSpecificRecipient =
      Boolean(normalizedRecipient) && normalizedRecipient !== "instagram conversation";
    if (requireRecipientHeader && (!hasSpecificRecipient || !normalizedHeader)) {
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
      platformThreadId = await this.openExactThread(page, selectors, thread);
      const snapshots = await this.snapshotMessages(page, selectors);
      if (snapshots.length === 0 && (await page.locator(selectors.composer_input).count()) === 0) {
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
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    return input.composer.evaluate(
      (
        composerNode,
        {
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
        let currentLocalOwner: Element | null = sendElement.parentElement;
        while (currentLocalOwner && !currentLocalOwner.contains(composerNode as Element)) {
          currentLocalOwner = currentLocalOwner.parentElement;
        }
        if (
          ownerElement === document.body ||
          ownerElement === document.documentElement ||
          ownerElement.matches("main, [role='main']") ||
          conversationEvidence.container !== conversationContainerElement ||
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
        (sendElement as HTMLElement).click();
        return { ok: true };
      },
      {
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
    result: { ok: true } | { ok: false; reason: string },
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

  private async countExactOutgoingBubbles(
    page: Page,
    selectors: SelectorRegistry,
    text: string
  ): Promise<number> {
    const exactText = page.getByText(text, { exact: true });
    const count = await exactText.count();
    if (count === 0) {
      return 0;
    }
    const containerBox = await page
      .locator(selectors.message_container)
      .first()
      .boundingBox();
    if (!containerBox) {
      return 0;
    }
    const composerBox = await page
      .locator(selectors.composer_input)
      .first()
      .boundingBox()
      .catch(() => null);
    const containerCenterX = containerBox.x + containerBox.width / 2;
    const boxes = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const candidate = count === 1 ? exactText : exactText.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const box = await candidate.boundingBox();
      if (!box) continue;
      const centerX = box.x + box.width / 2;
      if (centerX <= containerCenterX + Math.max(12, containerBox.width * 0.08)) continue;
      if (
        composerBox &&
        box.y < composerBox.y + composerBox.height &&
        box.y + box.height > composerBox.y
      ) {
        continue;
      }
      boxes.add(
        [box.x, box.y, box.width, box.height]
          .map((value) => Math.round(value))
          .join(":")
      );
    }
    return boxes.size;
  }

  async sendMessage(
    thread: ThreadStub,
    text: string,
    attachments: OutboundAttachment[] = []
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
    try {
      platformThreadId = await this.openExactThread(
        page,
        selectors,
        thread,
        true,
        "before_send"
      );
      const before = normalizeInstagramMessageSnapshots(
        platformThreadId,
        await this.snapshotMessages(page, selectors)
      );
      const exactOutgoingBefore = await this.countExactOutgoingBubbles(
        page,
        selectors,
        normalizedText
      );
      const composerLocator = await this.requireEnabled(
        page.locator(selectors.composer_input),
        "composer"
      );
      const composer = await composerLocator.elementHandle();
      if (!composer) {
        throw new InstagramParsingError("composer_detached");
      }
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
            submissionMayHaveOccurred = true;
            const result = await this.runAtomicComposerAction({
              composer,
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
            }
            this.assertAtomicComposerAction(result, platformThreadId!);
          }
        });
      } finally {
        await this.disposeComposerSendBinding(boundSend);
      }

      const deadline =
        Date.now() + (this.instagramDeps.sendVerificationTimeoutMs ?? 12_000);
      while (Date.now() < deadline) {
        if (!instagramThreadUrlMatches(page.url(), platformThreadId)) {
          throw new InstagramParsingError("thread_changed_during_send");
        }
        const after = normalizeInstagramMessageSnapshots(
          platformThreadId,
          await this.snapshotMessages(page, selectors)
        );
        const sent = findNewVerifiedInstagramOutgoing(before, after, normalizedText);
        if (sent) {
          return {
            sentAt: new Date().toISOString(),
            acknowledgedAt: new Date().toISOString(),
            verifiedBy: "bubble_detected",
            platformMessageKey: sent?.platformMessageKey,
            raw: { verification: "new_outgoing_bubble" }
          };
        }
        const exactOutgoingAfter = await this.countExactOutgoingBubbles(
          page,
          selectors,
          normalizedText
        );
        if (exactOutgoingAfter > exactOutgoingBefore) {
          return {
            sentAt: new Date().toISOString(),
            acknowledgedAt: new Date().toISOString(),
            verifiedBy: "bubble_detected",
            platformMessageKey: instagramMessageFallbackKey(
              platformThreadId,
              "OUT",
              normalizedText,
              undefined,
              Math.max(0, exactOutgoingAfter - 1)
            ),
            raw: { verification: "exact_outgoing_layout_bubble" }
          };
        }
        await page.waitForTimeout(500);
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
    }
  }

  async openThread(thread: ThreadStub): Promise<void> {
    const selectors = await this.deps.resolveSelectors();
    const page = await this.getPage();
    try {
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
