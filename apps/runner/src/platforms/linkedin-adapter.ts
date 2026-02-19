import type { ElementHandle, Locator, Page } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  NormalizedMessage,
  PlatformAdapter,
  SelectorRegistry,
  SendReceipt,
  ThreadStub,
  VerificationMethod
} from "@inbox-os/core";
import { stableHash } from "@inbox-os/core";
import {
  cleanText,
  AdapterFailure,
  toStageFailure,
  humanDelay,
  inferAdapterFailureKindFromMessage,
  retryWithBackoff,
  isTransientPageError
} from "./utils.js";
import type { AdapterFailureKind, AdapterStage } from "./utils.js";
import type { SessionManager } from "../services/session-manager";
import {
  executeTracedOperation,
  type RunLogger
} from "../services/run-logger.js";
import {
  buildTemporaryCandidateId,
  normalizeCanonicalLinkedInThreadId
} from "../linkedin/linkedinIdentity.js";
import { parseLinkedInListTimestamp } from "../linkedin/linkedinTime.js";
import {
  isSponsoredPillText,
  needsReplyFromPreview
} from "../linkedin/linkedinRowSignals.js";

interface LinkedInAdapterDependencies {
  screenshotDir: string;
  domDumpDir: string;
  resolveSelectors: () => Promise<SelectorRegistry>;
  sessionManager: SessionManager;
  personKey?: string;
  scanMaxThreads: number;
  scanStableIterations: number;
  scanScrollWaitMs: number;
  messageBackfillAttempts: number;
}

interface LinkedInThreadSnapshot {
  stableKey: string;
  platformThreadId?: string;
  isTemporaryId: boolean;
  displayName: string;
  unreadCount: number;
  lastMessagePreview: string;
  lastMessageAt?: string;
  threadUrl?: string;
  avatarUrl?: string;
  needsReplyFromList: boolean;
}

interface LinkedInVisibleRowSnapshot {
  rowKey: string;
  displayName: string;
  previewSnippet: string;
  listTimestamp: string;
  unreadCount: number;
  sponsored: boolean;
  needsReplyFromList: boolean;
  locatorPath?: string;
  href?: string;
  activeKey?: string;
  threadUrl?: string;
}

interface LinkedInStreamingRowRawSnapshot {
  locatorPath: string;
  id: string;
  conversationUrn: string;
  urn: string;
  conversationId: string;
  dataId: string;
  controlId: string;
  displayName: string;
  previewSnippet: string;
  listTimestamp: string;
  unreadText: string;
  unreadContainerPresent: boolean;
  pillText: string;
  href: string;
  activeKey: string;
}

interface LinkedInResolverNodeProbe {
  tag: string;
  class: string;
  id: string;
  overflowY: string;
  clientHeight: number;
  scrollHeight: number;
  delta: number;
  outerHtmlSample: string;
}

interface LinkedInResolverNodeResolution {
  handle: ElementHandle<Element>;
  selector: string;
  index: number;
  score: number;
  mode: "selector" | "fallback";
  triedSelectorCounts: Record<string, number>;
  topCandidates: LinkedInResolverNodeProbe[];
}

interface LinkedInScrollContainerResolution {
  handle: ElementHandle<Element>;
  mode:
    | "ancestor_scrollable"
    | "wrapper_ancestor"
    | "shell_heuristic"
    | "nonstandard_overflow_fallback";
  topCandidates: LinkedInResolverNodeProbe[];
}

interface LinkedInSelectorScopeCounts {
  threadList: number;
  threadItem: number;
  rowSignals: Record<string, number>;
}

interface LinkedInStreamingBlockerSignal {
  reason: "blocked_by_modal";
  signal: string;
  modalTextSnippet?: string;
}

interface LinkedInThreadCollectionIteration {
  rows: LinkedInThreadSnapshot[];
  trailingKey: string | null;
  didScroll: boolean;
  reachedBottom: boolean;
  threadListCount: number;
  threadItemCount: number;
  spinnerCount: number;
}

interface LinkedInMessageSnapshot {
  platformMessageKey: string;
  direction: "IN" | "OUT";
  timestamp: string;
  text: string;
  senderName?: string;
  raw?: Record<string, unknown>;
  attachments: Array<{ type: string; manualReview: boolean; rawLabel?: string }>;
}

interface ActiveThreadDescriptor {
  threadUrl?: string;
  activeKey?: string;
  displayName?: string;
}

interface LinkedInScanRuntimeContext {
  url: string;
  threadListCount: number;
  threadItemCount: number;
  unreadBadgeCount: number;
  unreadPillPresent: boolean;
  unreadPillActive: boolean;
  spinnerCount: number;
  overlayReason?: LinkedInScanFailureReason;
}

interface LinkedInRunCounters {
  unreadViewActive: boolean;
  threadsVisibleCount: number;
  threadsCollectedTotal: number;
  threadsWithUnreadBadgeCount: number;
  candidatesToOpenCount: number;
  openedThreadsCount: number;
  messagesParsedCount: number;
  scrollIterations: number;
  noProgressStreak: number;
  stopReason?: string;
  recoveryAttemptsUsed: number;
  reloadSuppressed: boolean;
}

export interface LinkedInFullScanOptions {
  maxThreads?: number;
  maxOpens?: number;
  disableDeepScroll?: boolean;
  requestId: string;
  runLogger?: RunLogger;
}

export type LinkedInStreamFailureReason =
  | "row_not_mounted"
  | "row_not_found_after_scroll"
  | "activation_mismatch"
  | "unresolved_thread_id_after_open"
  | "open_click_failed"
  | "message_container_not_ready";

export interface LinkedInStreamThreadCandidate {
  rowKey: string;
  thread: ThreadStub;
  messages: NormalizedMessage[];
}

export interface LinkedInStreamCandidateSignals {
  rowKey: string;
  displayName: string;
  unreadCount: number;
  needsReplyFromList: boolean;
  sponsored: boolean;
}

export interface LinkedInStreamScanMetrics {
  stopReason: LinkedInCollectionStopReason;
  iterations: number;
  scrollIterations: number;
  processedRows: number;
  actionableRows: number;
  openedRows: number;
  skippedRows: number;
  failures: number;
}

export interface LinkedInStreamScanOptions extends LinkedInFullScanOptions {
  onThreadCandidate: (input: LinkedInStreamThreadCandidate) => Promise<void>;
}

const linkedInUnreadPillSelector = "button[data-test-messaging-inbox-filters__filter-pill='UNREAD']";
const linkedInAllPillSelector = "button[data-test-messaging-inbox-filters__filter-pill='ALL']";
const linkedInSmokeEntryUrl = "https://www.linkedin.com/messaging/?filter=unread";
const linkedInSmokeThreadRowSelector = ".msg-conversation-listitem";
const linkedInSmokeThreadLinkSelector = ".msg-conversation-listitem__link";
const linkedInSmokeThreadRowFallbackSelector = [
  "ul.msg-conversations-container__conversations-list li:has(.msg-conversation-listitem__link)",
  "ul.msg-conversations-container__conversations-list li:has(a[href*='/messaging/thread/'])",
  "ul.msg-conversations-container__conversations-list li:has(a[href*='/messaging/'])"
].join(", ");
const linkedInSmokeParticipantSelector = ".msg-conversation-listitem__participant-names";
const linkedInSmokeListTimestampSelector = "time.msg-conversation-listitem__time-stamp";
const linkedInSmokePreviewSelector = ".msg-conversation-card__message-snippet";
const linkedInSmokeMessageContainerSelector = ".msg-s-message-list";
const linkedInSmokeMessageRowSelector = ".msg-s-message-list__event, .msg-s-event-listitem";
const linkedInSmokeMessageTextSelector = ".msg-s-event-listitem__body";
const linkedInSmokeMessageSenderSelector = ".msg-s-message-group__name";
const linkedInSmokeMessageTimestampSelector = "time.msg-s-message-group__timestamp";
const linkedInSmokeSearchInputSelectors = [
  "input[placeholder*='Search messages' i]",
  "input[aria-label*='Search messages' i]",
  "input[aria-label*='Search' i]"
];
const linkedInSmokeListContainerSelectors = [
  "ul.msg-conversations-container__conversations-list",
  "[class*='msg-conversations-container__conversations-list']"
];
const linkedInStreamingShellSelectors = [
  "main",
  "#main",
  ".scaffold-layout__main",
  ".msg-overlay-list-bubble__content",
  ".msg-conversations-container",
  "[class*='msg-conversations-container']"
];
const linkedInStreamingListRootSelectors = [
  "ul.msg-conversations-container__conversations-list",
  "[class*='msg-conversations-container__conversations-list']",
  ".msg-conversations-container",
  "[data-test*='conversations']",
  "[role='list']",
  "[role='listbox']"
];
const linkedInStreamingRowClickTargetSelectors = [
  "div.msg-conversation-listitem__link",
  "a.msg-conversation-card__conversation-link",
  "a.msg-conversation-card__conversation-link *",
  "[data-control-name*='conversation_item']"
];
const linkedInStreamingHydrationRowSignalSelectors = [
  "li.msg-conversation-listitem",
  "div.msg-conversation-listitem__link",
  "a.msg-conversation-card__conversation-link"
];
const linkedInStreamingHydrationRowSignalSelector = linkedInStreamingHydrationRowSignalSelectors.join(", ");
const linkedInStreamingEmptyStateSelector =
  ".msg-conversations-container__no-results, .msg-conversations-container__empty-state, .msg-conversations-container__empty-convos, [data-test-empty-state]";
const linkedInStreamingListRootValidationSelectors = [
  "li.msg-conversation-listitem",
  "div.msg-conversation-listitem__link",
  "a.msg-conversation-card__conversation-link"
];
const linkedInStreamingListRootValidationSelector = linkedInStreamingListRootValidationSelectors.join(", ");
const linkedInStreamingShellReadySelectors = [
  "div.msg__messaging-container",
  "main[role='main']",
  "main .msg-conversations-container",
  ".msg-conversations-container",
  "[class*='msg-conversations-container']"
];
const linkedInStreamingRowRootSelectors = [
  "li.msg-conversation-listitem",
  "div.msg-conversation-listitem",
  "[data-control-name*='conversation_item']",
  "[role='option']",
  "[role='listitem']"
];
const linkedInStreamingRowRootSelector = linkedInStreamingRowRootSelectors.join(", ");
const linkedInStreamingRowClickTargetSelector = linkedInStreamingRowClickTargetSelectors.join(", ");
const linkedInStreamingWrapperClassHints = ["scaffold-finite-scroll", "artdeco-scroll", "scaffold-layout__list", "msg__list"];
const linkedInSmokeFilterPillSelector = "button[data-test-messaging-inbox-filters__filter-pill]";
const linkedInSmokeBlockedModalSelectors = [
  "#artdeco-modal-outlet .artdeco-modal[aria-modal='true']",
  ".artdeco-modal-overlay",
  ".artdeco-modal__overlay",
  "[role='dialog'][aria-modal='true']"
];
const linkedInSmokeEmptyStatePatterns = [/no unread/i, /you're all caught up/i, /no messages match/i];
const linkedInSmokeSelectorMismatchError =
  "Selector mismatch: Unread view shows list structure/counters but 0 detectable conversation rows. See list-probe.* in LOG_DIR.";
const linkedInSmokeRowMismatchMessage =
  "Selector mismatch: list has X direct li children but 0 real rows (has participant+link).";
const linkedInLoadingSpinnerSelector = [
  ".artdeco-loader",
  ".artdeco-spinner",
  ".msg-conversations-container__conversations-list-loader",
  ".msg-conversations-container__loading",
  "[aria-label*='Loading']"
].join(", ");
const linkedInStreamingBackControlSelectors = [
  "button[aria-label*='Back to conversations' i]",
  "button[aria-label*='Back to messaging' i]",
  "button[aria-label='Back']",
  "button[aria-label*='Back' i]",
  "[data-control-name*='back_to_conversation']",
  "[data-control-name*='back_to_thread_list']",
  ".msg-thread-actions__back-button"
];

export interface LinkedInSmokeThreadRowMetadata {
  stableKey: string;
  platformThreadId?: string;
  isTemporaryId?: boolean;
  participantName: string;
  listTimestamp?: string;
  previewSnippet?: string;
  unreadCount?: number;
  threadUrl?: string;
  needsReplyFromList?: boolean;
}

export interface LinkedInSmokeParsedMessage {
  platformMessageKey: string;
  direction: "IN" | "OUT";
  text: string;
  senderName?: string;
  timestamp?: string;
}

export interface LinkedInSmokePersistInput {
  thread: ThreadStub;
  messages: NormalizedMessage[];
}

export interface LinkedInSmokeProbeArtifacts {
  listProbeJson: string;
  listProbeHtml: string;
  listProbePng: string;
  domHtml?: string;
  failurePng?: string;
}

export interface LinkedInDiscoveredUnreadRowsResult {
  namesCount: number;
  clickTargetsCount: number;
  primaryClickTargetsCount: number;
  rows: LinkedInSmokeThreadRowMetadata[];
}

export type LinkedInSmokeOutcome = "INGESTED_ONE_THREAD" | "UNREAD_EMPTY";

export interface LinkedInSmokeIngestResult {
  outcome: LinkedInSmokeOutcome;
  unreadCount: number;
  thread?: ThreadStub;
  messagesParsed: number;
  messages: NormalizedMessage[];
  persisted?: {
    updatedThreads: number;
    parsedMessages: number;
  };
  summary: {
    name: string | null;
    listTimestamp: string | null;
    previewSnippet: string | null;
    unreadCount: number;
  };
  probeArtifacts: LinkedInSmokeProbeArtifacts;
  diagnostics: {
    namesCount: number;
    clickTargetsCount: number;
    primaryClickTargetsCount: number;
    listContainerChildCount: number;
    unreadCounterValues: number[];
    emptyStateDetected: boolean;
  };
}

export type LinkedInSmokeStepLog = (input: {
  step: number;
  totalSteps: number;
  stepName: string;
  message: string;
  details?: Record<string, unknown>;
}) => void | Promise<void>;

export interface LinkedInMessagingShellProbe {
  url: string;
  title: string;
  searchInputCounts: Record<string, number>;
  listContainerCounts: Record<string, number>;
  filterPillCount: number;
  visibleSearchInput: boolean;
  visibleListContainer: boolean;
  visibleFilterPills: boolean;
  bodyTextSnippet: string;
}

export type LinkedInSmokeNavigateBlockedReason = "login_required" | "checkpoint_required" | "blocked_by_modal";

export type LinkedInSmokeNavigateState =
  | { blocked: false }
  | { blocked: true; reason: LinkedInSmokeNavigateBlockedReason; signal: string; modalTextSnippet?: string };

export interface LinkedInConversationRowCandidate {
  liIndex: number;
  stableKey: string;
  platformThreadId?: string;
  isTemporaryId: boolean;
  participantName: string;
  listTimestamp?: string;
  previewSnippet?: string;
  threadUrl?: string;
  needsReplyFromList: boolean;
  clickSelector: string;
}

export interface LinkedInConversationRowDiscovery {
  containerSelector: string | null;
  directLiCount: number;
  liWithParticipantCount: number;
  liWithLinkCount: number;
  liWithParticipantAndLinkCount: number;
  participantNamesCount: number;
  linkCount: number;
  snippetCount: number;
  timeCount: number;
  candidates: LinkedInConversationRowCandidate[];
}

function cleanLocatorText(value: string | null | undefined): string {
  return cleanText(value ?? "");
}

function normalizeLinkedInRowKeyInput(value: string | null | undefined): string {
  return cleanText(value ?? "").toLowerCase();
}

function buildLinkedInRowFallbackKey(input: {
  displayName: string;
  previewSnippet: string;
  listTimestamp: string;
}): string {
  const displayName = normalizeLinkedInRowKeyInput(input.displayName);
  const previewSnippet = normalizeLinkedInRowKeyInput(input.previewSnippet);
  const timestampSalt = normalizeLinkedInRowKeyInput(input.listTimestamp);
  const baseParts = [displayName, previewSnippet].filter((entry) => entry.length > 0);
  let signature = baseParts.join("|");
  if (!signature && timestampSalt) {
    signature = `ts:${timestampSalt}`;
  } else if (baseParts.length === 1 && timestampSalt) {
    signature = `${baseParts[0]}|ts:${timestampSalt}`;
  } else if (!signature) {
    signature = "missing-row-identity";
  }
  return `li-row:${stableHash(signature)}`;
}

function resolveLinkedInRowKey(input: {
  id?: string | null;
  conversationUrn?: string | null;
  urn?: string | null;
  conversationId?: string | null;
  dataId?: string | null;
  controlId?: string | null;
  displayName: string;
  previewSnippet: string;
  listTimestamp: string;
}): string {
  const directCandidates = [
    input.id,
    input.conversationUrn,
    input.urn,
    input.conversationId,
    input.dataId,
    input.controlId
  ]
    .map((value) => cleanText(value ?? ""))
    .filter((value) => value.length > 0);

  if (directCandidates[0]) {
    return directCandidates[0];
  }

  return buildLinkedInRowFallbackKey({
    displayName: input.displayName,
    previewSnippet: input.previewSnippet,
    listTimestamp: input.listTimestamp
  });
}

function resolveSmokeThreadUrl(rawHref: string, baseUrl: string): string | undefined {
  const trimmed = rawHref.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function resolveSmokeThreadToken(rawUrl: string | undefined): string {
  const normalized = (rawUrl ?? "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const threadMatch = normalized.match(/\/messaging\/thread\/([^/?#]+)/i);
  if (threadMatch?.[1]) {
    return threadMatch[1];
  }
  const conversationMatch = normalized.match(/conversationid=([^&]+)/i);
  if (conversationMatch?.[1]) {
    return conversationMatch[1];
  }
  return normalized;
}

async function hasAny(locator: Locator): Promise<boolean> {
  return (await locator.count().catch(() => 0)) > 0;
}

function extractNumbersFromText(value: string): number[] {
  const matches = value.match(/\d+/g) ?? [];
  return matches.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry));
}

function truncateForLog(value: string, limit = 1200): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…[truncated:${value.length}]`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function shouldAllowSmokePii(): boolean {
  return isTruthyEnvFlag(process.env.DEV_LOG_PII);
}

function redactSmokeBodySnippet(value: string): string {
  if (shouldAllowSmokePii()) {
    return value;
  }
  return `[redacted:${value.length}]`;
}

async function collectSelectorCounts(page: Page, selectors: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const selector of selectors) {
    counts[selector] = await page.locator(selector).count().catch(() => 0);
  }
  return counts;
}

function hasAnySelectorMatch(counts: Record<string, number>): boolean {
  return Object.values(counts).some((count) => count > 0);
}

async function hasVisibleMatch(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 5); index += 1) {
      const visible = await locator.nth(index).isVisible().catch(() => false);
      if (visible) {
        return true;
      }
    }
  }
  return false;
}

async function resolveLinkedInConversationListContainer(page: Page): Promise<{
  selector: string;
  locator: Locator;
} | null> {
  let fallback: { selector: string; locator: Locator } | null = null;
  for (const selector of linkedInSmokeListContainerSelectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (count <= 0) {
      continue;
    }
    if (!fallback) {
      fallback = {
        selector,
        locator
      };
    }
    const visible = await locator.isVisible().catch(() => false);
    if (visible) {
      return {
        selector,
        locator
      };
    }
  }
  return fallback;
}

async function readText(locator: Locator): Promise<string> {
  const first = locator.first();
  if (!(await hasAny(first))) {
    return "";
  }
  return cleanLocatorText(await first.innerText({ timeout: 0 }).catch(() => ""));
}

async function readAttr(locator: Locator, name: string): Promise<string> {
  const first = locator.first();
  if (!(await hasAny(first))) {
    return "";
  }
  return cleanLocatorText(await first.getAttribute(name, { timeout: 0 }).catch(() => ""));
}

interface LinkedInDiscoveredUnreadRowHandle {
  metadata: LinkedInSmokeThreadRowMetadata;
  clickTarget: Locator;
  scope: Locator;
}

interface LinkedInDiscoveredUnreadRowsWithHandles {
  namesCount: number;
  clickTargetsCount: number;
  primaryClickTargetsCount: number;
  directLiCount: number;
  liWithParticipantAndLinkCount: number;
  containerSelector: string | null;
  rows: LinkedInDiscoveredUnreadRowHandle[];
}

interface LinkedInConversationRowDiscoveryWithContainer extends LinkedInConversationRowDiscovery {
  containerLocator: Locator | null;
}

interface LinkedInUnreadCounterProbe {
  selector: string;
  count: number;
  samples: string[];
  numbers: number[];
}

interface LinkedInUnreadListProbeData {
  url: string;
  generatedAt: string;
  directLiCount: number;
  realRowCount: number;
  liWithParticipantCount: number;
  liWithLinkCount: number;
  liWithParticipantAndLinkCount: number;
  participantNamesCount: number;
  linkCount: number;
  snippetCount: number;
  timeCount: number;
  unreadPillActive: boolean;
  containerProbes: Array<{
    selector: string;
    count: number;
    firstOuterHtmlExcerpt: string | null;
  }>;
  chosenContainer: {
    selector: string;
    childCount: number;
    outerHtmlExcerpt: string | null;
  } | null;
  rowProbes: Array<{ selector: string; count: number }>;
  unreadCounterProbes: LinkedInUnreadCounterProbe[];
  unreadCounterValues: number[];
  sampleRows: Array<{
    name: string;
    listTimestamp: string | null;
    previewSnippet: string | null;
    unreadCount: number | null;
  }>;
  firstDirectLiOuterHtml: string[];
  emptyStateTextMatches: string[];
}

async function readOuterHtmlExcerpt(locator: Locator): Promise<string | null> {
  const first = locator.first();
  if (!(await hasAny(first))) {
    return null;
  }
  return first
    .evaluate((node) => (node as HTMLElement).outerHTML ?? "")
    .then((value) => truncateForLog(value))
    .catch(() => null);
}

function pickFirstNumber(...candidates: Array<number | undefined>): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function readUnreadCountFromScope(scope: Locator): Promise<number | undefined> {
  const selectors = [
    ".msg-conversation-card__unread-count .notification-badge__count",
    ".msg-conversation-card__unread-count",
    ".artdeco-notification-badge .notification-badge__count",
    ".artdeco-notification-badge[aria-label*='unread']",
    "[aria-label*='unread message']",
    "[aria-label*='new notification']"
  ];

  let first: number | undefined;
  for (const selector of selectors) {
    const value = await readText(scope.locator(selector));
    const numbers = extractNumbersFromText(value);
    first = pickFirstNumber(first, numbers[0]);

    const aria = await readAttr(scope.locator(selector), "aria-label");
    const ariaNumbers = extractNumbersFromText(aria);
    first = pickFirstNumber(first, ariaNumbers[0]);

    if (first !== undefined) {
      return first;
    }
  }
  return first;
}

async function getConversationRowCandidatesWithContainer(
  page: Page
): Promise<LinkedInConversationRowDiscoveryWithContainer> {
  const container = await resolveLinkedInConversationListContainer(page);
  if (!container) {
    return {
      containerSelector: null,
      containerLocator: null,
      directLiCount: 0,
      liWithParticipantCount: 0,
      liWithLinkCount: 0,
      liWithParticipantAndLinkCount: 0,
      participantNamesCount: 0,
      linkCount: 0,
      snippetCount: 0,
      timeCount: 0,
      candidates: []
    };
  }

  const raw = await container.locator
    .evaluate((containerNode) => {
      const liNodes = Array.from(containerNode.querySelectorAll(":scope > li"));
      const rows: Array<{
        liIndex: number;
        participantName: string;
        listTimestamp: string | null;
        previewSnippet: string | null;
        href: string | null;
        pillText: string | null;
        clickSelector: string;
      }> = [];
      let liWithParticipantCount = 0;
      let liWithLinkCount = 0;
      let liWithParticipantAndLinkCount = 0;

      for (let index = 0; index < liNodes.length; index += 1) {
        const node = liNodes[index];
        if (!node) {
          continue;
        }
        const participant = node.querySelector(".msg-conversation-listitem__participant-names");
        const link = node.querySelector(".msg-conversation-listitem__link");
        if (participant) {
          liWithParticipantCount += 1;
        }
        if (link) {
          liWithLinkCount += 1;
        }
        if (!(participant && link)) {
          continue;
        }
        liWithParticipantAndLinkCount += 1;

        const participantName = (participant.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!participantName) {
          continue;
        }
        const listTimestamp = (
          node.querySelector("time.msg-conversation-listitem__time-stamp")?.textContent ?? ""
        )
          .replace(/\s+/g, " ")
          .trim();
        const previewSnippet = (node.querySelector(".msg-conversation-card__message-snippet")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const pillText = (node.querySelector(".msg-conversation-card__pill")?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
        const anchor = link.tagName.toLowerCase() === "a" ? link : node.querySelector("a[href*='/messaging/']");
        const href = (anchor?.getAttribute("href") ?? "").replace(/\s+/g, " ").trim();
        rows.push({
          liIndex: index,
          participantName,
          listTimestamp: listTimestamp || null,
          previewSnippet: previewSnippet || null,
          href: href || null,
          pillText: pillText || null,
          clickSelector: ".msg-conversation-listitem__link"
        });
      }

      return {
        directLiCount: liNodes.length,
        liWithParticipantCount,
        liWithLinkCount,
        liWithParticipantAndLinkCount,
        rows
      };
    })
    .catch(() => {
      return {
        directLiCount: 0,
        liWithParticipantCount: 0,
        liWithLinkCount: 0,
        liWithParticipantAndLinkCount: 0,
        rows: []
      };
    });

  const candidates = raw.rows
    .filter((entry) => !isSponsoredPillText(entry.pillText ?? ""))
    .map((entry) => {
      const threadUrl = resolveSmokeThreadUrl(entry.href ?? "", page.url());
      const canonicalId = normalizeCanonicalLinkedInThreadId({
        threadUrl
      });
      const stableKey =
        canonicalId ??
        buildTemporaryCandidateId({
          displayName: entry.participantName,
          preview: entry.previewSnippet ?? "",
          listTimestamp: entry.listTimestamp ?? "",
          rowIndex: entry.liIndex
        });
      return {
        liIndex: entry.liIndex,
        stableKey,
        platformThreadId: canonicalId ?? undefined,
        isTemporaryId: !canonicalId,
        participantName: entry.participantName,
        listTimestamp: entry.listTimestamp ?? undefined,
        previewSnippet: entry.previewSnippet ?? undefined,
        threadUrl,
        needsReplyFromList: needsReplyFromPreview(entry.previewSnippet ?? ""),
        clickSelector: entry.clickSelector
      };
    });

  return {
    containerSelector: container.selector,
    containerLocator: container.locator,
    directLiCount: raw.directLiCount,
    liWithParticipantCount: raw.liWithParticipantCount,
    liWithLinkCount: raw.liWithLinkCount,
    liWithParticipantAndLinkCount: raw.liWithParticipantAndLinkCount,
    participantNamesCount: await container.locator.locator(linkedInSmokeParticipantSelector).count().catch(() => 0),
    linkCount: await container.locator.locator(".msg-conversation-listitem__link").count().catch(() => 0),
    snippetCount: await container.locator.locator(linkedInSmokePreviewSelector).count().catch(() => 0),
    timeCount: await container.locator.locator(linkedInSmokeListTimestampSelector).count().catch(() => 0),
    candidates
  };
}

export async function getConversationRowCandidates(page: Page): Promise<LinkedInConversationRowDiscovery> {
  const discovered = await getConversationRowCandidatesWithContainer(page);
  return {
    containerSelector: discovered.containerSelector,
    directLiCount: discovered.directLiCount,
    liWithParticipantCount: discovered.liWithParticipantCount,
    liWithLinkCount: discovered.liWithLinkCount,
    liWithParticipantAndLinkCount: discovered.liWithParticipantAndLinkCount,
    participantNamesCount: discovered.participantNamesCount,
    linkCount: discovered.linkCount,
    snippetCount: discovered.snippetCount,
    timeCount: discovered.timeCount,
    candidates: discovered.candidates
  };
}

async function discoverLinkedInUnreadRowsWithHandles(page: Page): Promise<LinkedInDiscoveredUnreadRowsWithHandles> {
  const discovered = await getConversationRowCandidatesWithContainer(page);
  const rows: LinkedInDiscoveredUnreadRowHandle[] = [];
  if (discovered.containerLocator) {
    for (const candidate of discovered.candidates) {
      const scope = discovered.containerLocator.locator(":scope > li").nth(candidate.liIndex);
      const clickTarget = scope.locator(candidate.clickSelector).first();
      if ((await clickTarget.count().catch(() => 0)) <= 0) {
        continue;
      }
      rows.push({
        metadata: {
          stableKey: candidate.stableKey,
          platformThreadId: candidate.platformThreadId,
          isTemporaryId: candidate.isTemporaryId,
          participantName: candidate.participantName,
          listTimestamp: candidate.listTimestamp,
          previewSnippet: candidate.previewSnippet,
          unreadCount: await readUnreadCountFromScope(scope),
          threadUrl: candidate.threadUrl,
          needsReplyFromList: candidate.needsReplyFromList
        },
        clickTarget,
        scope
      });
    }
  }

  return {
    namesCount: discovered.participantNamesCount,
    clickTargetsCount: rows.length,
    primaryClickTargetsCount: discovered.linkCount,
    directLiCount: discovered.directLiCount,
    liWithParticipantAndLinkCount: discovered.liWithParticipantAndLinkCount,
    containerSelector: discovered.containerSelector,
    rows
  };
}

export async function discoverLinkedInUnreadRows(page: Page): Promise<LinkedInDiscoveredUnreadRowsResult> {
  const discovered = await discoverLinkedInUnreadRowsWithHandles(page);
  return {
    namesCount: discovered.namesCount,
    clickTargetsCount: discovered.clickTargetsCount,
    primaryClickTargetsCount: discovered.primaryClickTargetsCount,
    rows: discovered.rows.map((row) => row.metadata)
  };
}

export function classifyLinkedInSmokeUnreadOutcome(input: {
  emptyStateDetected: boolean;
  namesCount: number;
  clickTargetsCount: number;
  listContainerChildCount: number;
  unreadCounterValues: number[];
}): {
  outcome: "INGEST" | "EMPTY" | "MISMATCH";
  reason?: "selector_mismatch_thread_rows";
} {
  if (input.emptyStateDetected) {
    return {
      outcome: "EMPTY"
    };
  }
  if (input.namesCount > 0 || input.clickTargetsCount > 0) {
    return {
      outcome: "INGEST"
    };
  }
  const appearsPopulated = input.listContainerChildCount > 0 || input.unreadCounterValues.length > 0;
  if (appearsPopulated) {
    return {
      outcome: "MISMATCH",
      reason: "selector_mismatch_thread_rows"
    };
  }
  return {
    outcome: "EMPTY"
  };
}

export async function isLinkedInMessagingShellReady(
  page: Page
): Promise<{ ok: boolean; details: LinkedInMessagingShellProbe }> {
  const searchInputCounts = await collectSelectorCounts(page, linkedInSmokeSearchInputSelectors);
  const listContainerCounts = await collectSelectorCounts(page, linkedInSmokeListContainerSelectors);
  const filterPillCount = await page.locator(linkedInSmokeFilterPillSelector).count().catch(() => 0);
  const visibleSearchInput = await hasVisibleMatch(page, linkedInSmokeSearchInputSelectors);
  const visibleListContainer = await hasVisibleMatch(page, linkedInSmokeListContainerSelectors);
  const visibleFilterPills = await hasVisibleMatch(page, [linkedInSmokeFilterPillSelector]);
  const title = cleanText(await page.title().catch(() => ""));
  const rawBodyText = cleanText(await page.locator("body").innerText().catch(() => ""));
  const bodySnippet = rawBodyText.slice(0, 500);

  const details: LinkedInMessagingShellProbe = {
    url: page.url(),
    title,
    searchInputCounts,
    listContainerCounts,
    filterPillCount,
    visibleSearchInput,
    visibleListContainer,
    visibleFilterPills,
    bodyTextSnippet: redactSmokeBodySnippet(bodySnippet)
  };

  return {
    ok: visibleSearchInput && visibleListContainer && visibleFilterPills,
    details
  };
}

export async function classifyLinkedInSmokeNavigateState(
  page: Page,
  probe: LinkedInMessagingShellProbe
): Promise<LinkedInSmokeNavigateState> {
  const currentUrl = probe.url.toLowerCase();
  if (currentUrl.includes("/login") || currentUrl.includes("/uas/login")) {
    return {
      blocked: true,
      reason: "login_required",
      signal: "url_login"
    };
  }

  const usernameCount = await page.locator("#username").count().catch(() => 0);
  if (usernameCount > 0) {
    return {
      blocked: true,
      reason: "login_required",
      signal: "username_input"
    };
  }

  const rawBodyText = cleanText(await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (currentUrl.includes("/checkpoint") || /checkpoint|verify|action required/i.test(rawBodyText)) {
    return {
      blocked: true,
      reason: "checkpoint_required",
      signal: currentUrl.includes("/checkpoint") ? "url_checkpoint" : "body_checkpoint"
    };
  }

  for (const selector of linkedInSmokeBlockedModalSelectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, 4); index += 1) {
      const node = locator.nth(index);
      const visible = await node.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      const box = await node.boundingBox().catch(() => null);
      if (!box || box.width <= 200 || box.height <= 200) {
        continue;
      }
      const modalTextSnippet = cleanText(await node.innerText({ timeout: 0 }).catch(() => "")).slice(0, 120);
      return {
        blocked: true,
        reason: "blocked_by_modal",
        signal: selector,
        modalTextSnippet
      };
    }
  }

  return {
    blocked: false
  };
}

export async function waitForLinkedInShellReady(
  page: Page,
  timeoutMs = 15_000
): Promise<
  | { state: "READY"; probe: LinkedInMessagingShellProbe }
  | { state: "BLOCKED"; probe: LinkedInMessagingShellProbe; blocked: Exclude<LinkedInSmokeNavigateState, { blocked: false }> }
  | { state: "TIMEOUT"; probe: LinkedInMessagingShellProbe }
> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let latest = await isLinkedInMessagingShellReady(page);
  while (Date.now() < deadline) {
    if (latest.ok) {
      return {
        state: "READY",
        probe: latest.details
      };
    }
    const navigateState = await classifyLinkedInSmokeNavigateState(page, latest.details);
    if (navigateState.blocked) {
      return {
        state: "BLOCKED",
        probe: latest.details,
        blocked: navigateState
      };
    }
    await page.waitForTimeout(250);
    latest = await isLinkedInMessagingShellReady(page);
  }
  return {
    state: "TIMEOUT",
    probe: latest.details
  };
}

export async function waitUnreadRowsOrEmptyState(
  page: Page,
  timeoutMs = 12_000
): Promise<
  | { state: "ROWS_READY"; discovery: LinkedInConversationRowDiscovery }
  | { state: "EMPTY_UNREAD"; discovery: LinkedInConversationRowDiscovery; matches: string[] }
  | { state: "TIMEOUT"; discovery: LinkedInConversationRowDiscovery }
> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  let discovery = await getConversationRowCandidates(page);
  while (Date.now() < deadline) {
    if (discovery.candidates.length > 0) {
      return {
        state: "ROWS_READY",
        discovery
      };
    }
    const emptyState = await detectLinkedInUnreadEmptyState(page);
    if (emptyState.detected) {
      return {
        state: "EMPTY_UNREAD",
        discovery,
        matches: emptyState.matches
      };
    }
    await page.waitForTimeout(250);
    discovery = await getConversationRowCandidates(page);
  }
  return {
    state: "TIMEOUT",
    discovery
  };
}

async function dumpLinkedInSmokeNavigateProbe(input: {
  page: Page;
  logDir: string;
  probe: LinkedInMessagingShellProbe;
  reason: string;
}): Promise<{ navigateProbeJson: string; domHtml?: string; navigateFailurePng?: string }> {
  const navigateProbeJson = join(input.logDir, "navigate-probe.json");
  const navigateFailurePng = join(input.logDir, "navigate-failure.png");
  const domHtml = join(input.logDir, "dom.html");
  const payload = {
    generatedAt: new Date().toISOString(),
    reason: input.reason,
    url: input.probe.url,
    title: input.probe.title,
    searchInputCounts: input.probe.searchInputCounts,
    listContainerCounts: input.probe.listContainerCounts,
    filterPillCount: input.probe.filterPillCount,
    visibleSearchInput: input.probe.visibleSearchInput,
    visibleListContainer: input.probe.visibleListContainer,
    visibleFilterPills: input.probe.visibleFilterPills,
    bodyTextSnippet: input.probe.bodyTextSnippet
  };
  await writeFile(navigateProbeJson, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  let savedDom: string | undefined;
  try {
    await writeFile(domHtml, await input.page.content(), "utf8");
    savedDom = domHtml;
  } catch {
    // best effort
  }

  let savedScreenshot: string | undefined;
  try {
    await input.page.screenshot({
      path: navigateFailurePng,
      fullPage: true
    });
    savedScreenshot = navigateFailurePng;
  } catch {
    // best effort
  }

  return {
    navigateProbeJson,
    domHtml: savedDom,
    navigateFailurePng: savedScreenshot
  };
}

async function detectLinkedInUnreadEmptyState(page: Page): Promise<{ detected: boolean; matches: string[] }> {
  const container = await resolveLinkedInConversationListContainer(page);
  let panelLocator: Locator | null = null;
  if (container) {
    const ancestor = container.locator
      .locator("xpath=ancestor::*[contains(@class,'msg-conversations-container')][1]")
      .first();
    if ((await ancestor.count().catch(() => 0)) > 0) {
      panelLocator = ancestor;
    } else {
      panelLocator = container.locator;
    }
  } else {
    const fallback = page
      .locator(
        ".msg-conversations-container, .msg-overlay-list-bubble__content, [class*='msg-conversations-container']"
      )
      .first();
    if ((await fallback.count().catch(() => 0)) > 0) {
      panelLocator = fallback;
    }
  }
  const panelText = panelLocator ? await readText(panelLocator.locator(":scope")) : "";
  const matches = linkedInSmokeEmptyStatePatterns
    .filter((pattern) => pattern.test(panelText))
    .map((pattern) => pattern.source);
  return {
    detected: matches.length > 0,
    matches
  };
}

async function captureLinkedInSmokeFailureArtifacts(input: {
  page: Page;
  logDir: string;
}): Promise<{ domHtml?: string; failurePng?: string }> {
  const domHtml = join(input.logDir, "dom.html");
  const failurePng = join(input.logDir, "failure.png");
  let savedDom: string | undefined;
  let savedPng: string | undefined;

  try {
    const html = await input.page.content();
    await writeFile(domHtml, html, "utf8");
    savedDom = domHtml;
  } catch {
    // best effort
  }

  try {
    await input.page.screenshot({
      path: failurePng,
      fullPage: true
    });
    savedPng = failurePng;
  } catch {
    // best effort
  }

  return {
    domHtml: savedDom,
    failurePng: savedPng
  };
}

async function dumpLinkedInUnreadListProbe(input: {
  page: Page;
  logDir: string;
  discovery: LinkedInConversationRowDiscovery;
  emptyStateMatches: string[];
  unreadPillActive: boolean;
}): Promise<{ artifacts: LinkedInSmokeProbeArtifacts; data: LinkedInUnreadListProbeData }> {
  const containerCandidates = [
    "ul.msg-conversations-container__conversations-list",
    ".msg-conversations-container__conversations-list",
    "[class*='msg-conversations-container__conversations-list']",
    "[class*='msg-conversations-container__convo-item-link']",
    ":is(section,div,aside,main):has(input[placeholder*='Search messages']), :is(section,div,aside,main):has(input[aria-label*='Search messages'])"
  ];
  const rowSelectors = [
    "li.msg-conversation-listitem",
    ".msg-conversation-listitem",
    "div.msg-conversation-listitem__link",
    "a.msg-conversation-listitem__link",
    "[class*='msg-conversations-container__convo-item-link']",
    ".msg-conversation-listitem__participant-names",
    ".msg-conversation-card__message-snippet",
    "time.msg-conversation-listitem__time-stamp"
  ];
  const unreadCounterSelectors = [
    ".msg-conversation-card__unread-count",
    ".msg-conversation-card__unread-count .notification-badge__count",
    ".artdeco-notification-badge[aria-label*='unread']",
    ".artdeco-notification-badge .notification-badge__count",
    "[aria-label*='unread message']",
    "[aria-label*='new notification']"
  ];

  const containerProbes: LinkedInUnreadListProbeData["containerProbes"] = [];
  let chosenContainerSelector: string | null = null;
  let chosenContainerLocator: Locator | null = null;
  for (const selector of containerCandidates) {
    const locator = input.page.locator(selector);
    const count = await locator.count().catch(() => 0);
    const firstOuterHtmlExcerpt = await readOuterHtmlExcerpt(locator);
    containerProbes.push({
      selector,
      count,
      firstOuterHtmlExcerpt
    });
    if (!chosenContainerSelector && count > 0) {
      chosenContainerSelector = selector;
      chosenContainerLocator = locator.first();
    }
  }

  const chosenContainerChildCount = chosenContainerLocator
    ? await chosenContainerLocator
        .locator(":scope > *")
        .count()
        .catch(() => 0)
    : 0;

  const rowProbes: LinkedInUnreadListProbeData["rowProbes"] = [];
  for (const selector of rowSelectors) {
    const count = await input.page.locator(selector).count().catch(() => 0);
    rowProbes.push({
      selector,
      count
    });
  }

  const unreadCounterProbes: LinkedInUnreadCounterProbe[] = [];
  const unreadCounterValues: number[] = [];
  for (const selector of unreadCounterSelectors) {
    const locator = input.page.locator(selector);
    const count = await locator.count().catch(() => 0);
    const sampleLimit = Math.min(5, count);
    const samples: string[] = [];
    const numbers: number[] = [];
    for (let index = 0; index < sampleLimit; index += 1) {
      const node = locator.nth(index);
      const text = (await readText(node)) || (await readAttr(node, "aria-label"));
      if (text) {
        samples.push(text);
        numbers.push(...extractNumbersFromText(text));
      }
      const aria = await readAttr(node, "aria-label");
      if (aria && aria !== text) {
        samples.push(aria);
        numbers.push(...extractNumbersFromText(aria));
      }
    }
    unreadCounterValues.push(...numbers);
    unreadCounterProbes.push({
      selector,
      count,
      samples,
      numbers
    });
  }

  const sampleRows: LinkedInUnreadListProbeData["sampleRows"] = input.discovery.candidates.slice(0, 10).map((row) => ({
    name: row.participantName,
    listTimestamp: row.listTimestamp ?? null,
    previewSnippet: row.previewSnippet ?? null,
    unreadCount: null
  }));

  const listProbeJson = join(input.logDir, "list-probe.json");
  const listProbeHtml = join(input.logDir, "list-probe.html");
  const listProbePng = join(input.logDir, "list-probe.png");
  const firstDirectLiOuterHtml: string[] = [];
  if (chosenContainerLocator) {
    const directLi = chosenContainerLocator.locator(":scope > li");
    const count = await directLi.count().catch(() => 0);
    for (let index = 0; index < Math.min(8, count); index += 1) {
      const html = await directLi
        .nth(index)
        .evaluate((node) => (node as HTMLElement).outerHTML ?? "")
        .catch(() => "");
      if (html) {
        firstDirectLiOuterHtml.push(truncateForLog(html, 1800));
      }
    }
  }

  const data: LinkedInUnreadListProbeData = {
    url: input.page.url(),
    generatedAt: new Date().toISOString(),
    directLiCount: input.discovery.directLiCount,
    realRowCount: input.discovery.candidates.length,
    liWithParticipantCount: input.discovery.liWithParticipantCount,
    liWithLinkCount: input.discovery.liWithLinkCount,
    liWithParticipantAndLinkCount: input.discovery.liWithParticipantAndLinkCount,
    participantNamesCount: input.discovery.participantNamesCount,
    linkCount: input.discovery.linkCount,
    snippetCount: input.discovery.snippetCount,
    timeCount: input.discovery.timeCount,
    unreadPillActive: input.unreadPillActive,
    containerProbes,
    chosenContainer: chosenContainerSelector
      ? {
          selector: chosenContainerSelector,
          childCount: chosenContainerChildCount,
          outerHtmlExcerpt: await readOuterHtmlExcerpt(input.page.locator(chosenContainerSelector))
        }
      : null,
    rowProbes,
    unreadCounterProbes,
    unreadCounterValues,
    sampleRows,
    firstDirectLiOuterHtml,
    emptyStateTextMatches: input.emptyStateMatches
  };

  await writeFile(listProbeJson, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  const probeHtml = [
    "<!doctype html>",
    "<html><head><meta charset='utf-8'><title>LinkedIn Smoke List Probe</title></head><body>",
    "<h1>LinkedIn Smoke List Probe</h1>",
    "<h2>Chosen Container</h2>",
    `<pre>${escapeHtml(data.chosenContainer?.outerHtmlExcerpt ?? "(none)")}</pre>`,
    "<h2>First 8 Direct LI Children</h2>",
    firstDirectLiOuterHtml.length
      ? firstDirectLiOuterHtml.map((entry, index) => `<h3>#${index + 1}</h3><pre>${escapeHtml(entry)}</pre>`).join("\n")
      : "<pre>(none)</pre>",
    "</body></html>"
  ].join("\n");
  await writeFile(listProbeHtml, probeHtml, "utf8");

  let captured = false;
  if (chosenContainerLocator) {
    const bbox = await chosenContainerLocator.boundingBox().catch(() => null);
    if (bbox && bbox.width > 4 && bbox.height > 4) {
      const viewport = input.page.viewportSize();
      const width = viewport?.width ?? (await input.page.evaluate(() => window.innerWidth).catch(() => 1280));
      const height = viewport?.height ?? (await input.page.evaluate(() => window.innerHeight).catch(() => 720));
      const clip = {
        x: Math.max(0, Math.min(bbox.x, width - 1)),
        y: Math.max(0, Math.min(bbox.y, height - 1)),
        width: Math.max(1, Math.min(bbox.width, width - Math.max(0, Math.min(bbox.x, width - 1)))),
        height: Math.max(1, Math.min(bbox.height, height - Math.max(0, Math.min(bbox.y, height - 1))))
      };
      await input.page.screenshot({
        path: listProbePng,
        clip
      });
      captured = true;
    }
  }
  if (!captured) {
    await input.page.screenshot({
      path: listProbePng,
      fullPage: true
    });
  }

  return {
    artifacts: {
      listProbeJson,
      listProbeHtml,
      listProbePng
    },
    data
  };
}

export async function extractLinkedInSmokeFirstThreadRow(page: Page): Promise<LinkedInSmokeThreadRowMetadata | null> {
  const discovered = await discoverLinkedInUnreadRowsWithHandles(page);
  return discovered.rows[0]?.metadata ?? null;
}

export async function extractLinkedInSmokeMessages(
  page: Page,
  limit = 20
): Promise<LinkedInSmokeParsedMessage[]> {
  const rows = page.locator(linkedInSmokeMessageRowSelector);
  const count = await rows.count().catch(() => 0);
  if (count <= 0) {
    return [];
  }

  const parsed: LinkedInSmokeParsedMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = await readText(row.locator(linkedInSmokeMessageTextSelector));
    if (!text) {
      continue;
    }

    const className = await readAttr(row, "class");
    const inbound =
      className.includes("msg-s-event-listitem--other") ||
      /other|received|incoming/i.test(className);
    const senderName = await readText(row.locator(linkedInSmokeMessageSenderSelector));
    const timestamp =
      (await readAttr(row.locator(linkedInSmokeMessageTimestampSelector), "datetime")) ||
      (await readText(row.locator(linkedInSmokeMessageTimestampSelector)));
    const platformMessageKey =
      (await readAttr(row, "data-event-urn")) ||
      (await readAttr(row, "data-id")) ||
      (await readAttr(row, "id")) ||
      `linkedin-smoke-msg-${index + 1}`;

    parsed.push({
      platformMessageKey,
      direction: inbound ? "IN" : "OUT",
      text,
      senderName: senderName || undefined,
      timestamp: timestamp || undefined
    });
  }

  if (parsed.length <= limit) {
    return parsed;
  }
  return parsed.slice(parsed.length - limit);
}

export type LinkedInUnreadRefreshReason =
  | "state_flip"
  | "spinner_cycle"
  | "settle_delay"
  | "already_active"
  | "pill_missing"
  | "click_failed";

export interface LinkedInUnreadFilterActivationResult {
  pillPresent: boolean;
  clicked: boolean;
  waitReason: LinkedInUnreadRefreshReason;
}

export type LinkedInScanFailureReason =
  | "transient_context_destroyed"
  | "element_detached"
  | "evaluate_helper_missing"
  | "evaluate_reference_error"
  | "timeout"
  | "list_hydration_timeout"
  | "thread_list_not_ready"
  | "page_closed_mid_stage"
  | "login_required"
  | "checkpoint_required"
  | "blocked_by_modal"
  | "rate_limited"
  | "linkedin_error_overlay"
  | "manual_refresh_required"
  | "repeated_reload_guard_triggered"
  | "unknown";

export interface LinkedInScanStageReceipt {
  stage: "navigate" | "auth_check" | "unread_filter" | "collect_threads";
  status: "OK" | "FAIL";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export function isRetryableLinkedInCollectError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /execution context was destroyed/i.test(message) ||
    /detached/i.test(message) ||
    /navigation.*interrupted/i.test(message) ||
    /timeout/i.test(message)
  );
}

export function resolveLinkedInScanFailureReason(input: {
  message: string;
  url?: string;
  overlayReason?: LinkedInScanFailureReason;
  threadListCount?: number;
  threadItemCount?: number;
  spinnerCount?: number;
}): LinkedInScanFailureReason {
  if (input.overlayReason) {
    return input.overlayReason;
  }

  const message = input.message.toLowerCase();
  const url = (input.url ?? "").toLowerCase();
  if (message.includes("__name is not defined")) {
    return "evaluate_helper_missing";
  }
  if (message.includes("referenceerror")) {
    return "evaluate_reference_error";
  }
  if (message.includes("target page, context or browser has been closed")) {
    return "page_closed_mid_stage";
  }
  if (message.includes("timeouterror") || message.includes("timeout")) {
    return "timeout";
  }
  if (message.includes("list_hydration_timeout")) {
    return "list_hydration_timeout";
  }
  if (message.includes("execution context was destroyed")) {
    return "transient_context_destroyed";
  }
  if (message.includes("detached")) {
    return "element_detached";
  }
  if (url.includes("/uas/login") || message.includes("auth required") || message.includes("sign in")) {
    return "login_required";
  }
  if (url.includes("/checkpoint/") || message.includes("checkpoint") || message.includes("verify")) {
    return "checkpoint_required";
  }
  if (message.includes("blocked_by_modal") || message.includes("paywall") || message.includes("interstitial")) {
    return "blocked_by_modal";
  }
  if (message.includes("too many requests") || message.includes("rate limit")) {
    return "rate_limited";
  }
  if (message.includes("something went wrong")) {
    return "linkedin_error_overlay";
  }
  if (message.includes("manual refresh required") || message.includes("refresh linkedin manually")) {
    return "manual_refresh_required";
  }

  if ((input.threadListCount ?? 0) <= 0 || ((input.threadItemCount ?? 0) <= 0 && (input.spinnerCount ?? 0) > 0)) {
    return "thread_list_not_ready";
  }

  return "unknown";
}

export function isLinkedInUnreadPillActive(input: {
  ariaPressed?: string | null;
  ariaChecked?: string | null;
}): boolean {
  const pressed = (input.ariaPressed ?? "").toLowerCase();
  const checked = (input.ariaChecked ?? "").toLowerCase();
  return pressed === "true" || checked === "true";
}

export function shouldClickLinkedInUnreadPill(input: {
  present: boolean;
  ariaPressed?: string | null;
  ariaChecked?: string | null;
}): boolean {
  if (!input.present) {
    return false;
  }
  return !isLinkedInUnreadPillActive({
    ariaPressed: input.ariaPressed,
    ariaChecked: input.ariaChecked
  });
}

export async function waitForLinkedInUnreadRefresh(input: {
  waitForStateFlip: () => Promise<boolean>;
  waitForSpinnerCycle: () => Promise<boolean>;
  waitForTimeout: (ms: number) => Promise<void>;
  settleDelayMs?: number;
}): Promise<LinkedInUnreadRefreshReason> {
  if (await input.waitForStateFlip()) {
    return "state_flip";
  }

  if (await input.waitForSpinnerCycle()) {
    return "spinner_cycle";
  }

  const settleDelayMs = Math.max(250, Math.min(500, input.settleDelayMs ?? 350));
  await input.waitForTimeout(settleDelayMs);
  return "settle_delay";
}

export async function activateLinkedInUnreadFilter(page: Page): Promise<LinkedInUnreadFilterActivationResult> {
  return activateLinkedInUnreadFilterWithHooks(page);
}

async function activateLinkedInUnreadFilterWithHooks(
  page: Page,
  hooks?: {
    clickUnreadPill?: () => Promise<boolean>;
    waitForTimeout?: (ms: number) => Promise<void>;
  }
): Promise<LinkedInUnreadFilterActivationResult> {
  async function readPillState(): Promise<{
    present: boolean;
    active: boolean;
  }> {
    const unreadPill = page.locator(linkedInUnreadPillSelector).first();
    const pillCount = await unreadPill.count().catch(() => 0);
    if (pillCount === 0) {
      return { present: false, active: false };
    }

    const ariaPressed = await unreadPill.getAttribute("aria-pressed").catch(() => null);
    const ariaChecked = await unreadPill.getAttribute("aria-checked").catch(() => null);
    return {
      present: true,
      active: isLinkedInUnreadPillActive({
        ariaPressed,
        ariaChecked
      })
    };
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const initialState = await readPillState();
    if (!initialState.present) {
      return {
        pillPresent: false,
        clicked: false,
        waitReason: "pill_missing"
      };
    }
    if (initialState.active) {
      return {
        pillPresent: true,
        clicked: false,
        waitReason: "already_active"
      };
    }

    const clicked = hooks?.clickUnreadPill
      ? await hooks.clickUnreadPill()
      : await page
          .locator(linkedInUnreadPillSelector)
          .first()
          .click({ timeout: 5000 })
          .then(() => true)
          .catch(() => false);
    if (!clicked) {
      continue;
    }

    const waitReason = await waitForLinkedInUnreadRefresh({
      waitForStateFlip: async () => {
        const deadline = Date.now() + 2_200;
        while (Date.now() < deadline) {
          const state = await readPillState();
          if (state.active) {
            return true;
          }
          await page.waitForTimeout(120);
        }
        return false;
      },
      waitForSpinnerCycle: async () => {
        const spinner = page.locator(linkedInLoadingSpinnerSelector);
        const appearDeadline = Date.now() + 1_600;
        let sawSpinner = false;

        while (Date.now() < appearDeadline) {
          const count = await spinner.count().catch(() => 0);
          if (count > 0) {
            sawSpinner = true;
            break;
          }
          if (hooks?.waitForTimeout) {
            await hooks.waitForTimeout(100);
          } else {
            await page.waitForTimeout(100);
          }
        }

        if (!sawSpinner) {
          return false;
        }

        const disappearDeadline = Date.now() + 2_200;
        while (Date.now() < disappearDeadline) {
          const count = await spinner.count().catch(() => 0);
          if (count === 0) {
            return true;
          }
          if (hooks?.waitForTimeout) {
            await hooks.waitForTimeout(100);
          } else {
            await page.waitForTimeout(100);
          }
        }

        return false;
      },
      waitForTimeout: (ms) => (hooks?.waitForTimeout ? hooks.waitForTimeout(ms) : page.waitForTimeout(ms))
    });

    const finalState = await readPillState();
    if (finalState.active || waitReason === "spinner_cycle") {
      return {
        pillPresent: true,
        clicked: true,
        waitReason
      };
    }
  }

  return {
    pillPresent: true,
    clicked: false,
    waitReason: "click_failed"
  };
}

export type LinkedInCollectionStopReason =
  | "max_threads"
  | "end_of_list_no_progress"
  | "end_of_list_reached"
  | "no_scroll_container"
  | "max_iterations"
  | "max_duration"
  | "zero_threads_found";

export function updateLinkedInCollectionStability(input: {
  previousCount: number;
  nextCount: number;
  previousTrailingKey: string | null;
  nextTrailingKey: string | null;
  noGrowthIterations: number;
  trailingRepeatIterations: number;
}): { noGrowthIterations: number; trailingRepeatIterations: number } {
  const grew = input.nextCount > input.previousCount;
  const noGrowthIterations = grew ? 0 : input.noGrowthIterations + 1;

  const trailingRepeatIterations =
    input.nextTrailingKey && input.previousTrailingKey === input.nextTrailingKey
      ? input.trailingRepeatIterations + 1
      : 0;

  return {
    noGrowthIterations,
    trailingRepeatIterations
  };
}

export function shouldStopLinkedInCollection(input: {
  uniqueCount: number;
  maxThreads: number;
  noGrowthIterations: number;
  trailingRepeatIterations: number;
  stableIterations: number;
  didScroll: boolean;
  reachedBottom: boolean;
}): boolean {
  if (input.uniqueCount >= input.maxThreads) {
    return true;
  }
  if (input.noGrowthIterations >= input.stableIterations) {
    return true;
  }
  if (input.trailingRepeatIterations >= input.stableIterations) {
    return true;
  }
  if (!input.didScroll && input.reachedBottom) {
    return true;
  }
  return false;
}

export function resolveLinkedInCollectionStopReason(input: {
  uniqueCount: number;
  maxThreads: number;
  noGrowthIterations: number;
  trailingRepeatIterations: number;
  stableIterations: number;
  didScroll: boolean;
  reachedBottom: boolean;
}): LinkedInCollectionStopReason | null {
  if (input.uniqueCount >= input.maxThreads) {
    return "max_threads";
  }
  if (input.noGrowthIterations >= input.stableIterations) {
    return "end_of_list_no_progress";
  }
  if (input.trailingRepeatIterations >= input.stableIterations) {
    return "end_of_list_reached";
  }
  if (!input.didScroll && input.reachedBottom) {
    return "end_of_list_reached";
  }
  return null;
}

export function buildLinkedInPreviewMap(
  threads: Array<Pick<ThreadStub, "platformThreadId" | "lastMessagePreview">>
): Map<string, string> {
  const previewByThread = new Map<string, string>();
  for (const thread of threads) {
    previewByThread.set(thread.platformThreadId, cleanText(thread.lastMessagePreview ?? ""));
  }
  return previewByThread;
}

export class LinkedInAdapter implements PlatformAdapter {
  platform = "LINKEDIN" as const;
  private lastCollectionMetrics: {
    totalFound: number;
    unreadFound: number;
    iterations: number;
    stopReason: LinkedInCollectionStopReason;
  } | null = null;

  private static readonly inboxNavigationTimeoutMs = 10_000;
  private static readonly inboxReadyTimeoutMs = 10_000;
  private runLogger: RunLogger | null = null;
  private activeStage: string | null = null;
  private readonly pageTraceIds = new WeakMap<Page, string>();
  private pageTraceSequence = 0;

  constructor(private readonly deps: LinkedInAdapterDependencies) {}

  setRunLogger(logger: RunLogger | null): void {
    this.runLogger = logger;
  }

  private resolveActiveStage(stage?: string | null): string | null {
    return stage ?? this.activeStage;
  }

  private getPageTraceId(page: Page): string {
    const existing = this.pageTraceIds.get(page);
    if (existing) {
      return existing;
    }
    this.pageTraceSequence += 1;
    const created = `linkedin-page-${this.pageTraceSequence}`;
    this.pageTraceIds.set(page, created);
    return created;
  }

  private logTraceEvent(input: {
    level?: "debug" | "info" | "warn" | "error";
    action: string;
    stage?: string | null;
    details?: Record<string, unknown>;
    url?: string;
    page?: Page;
    attempt?: number;
    elapsedMs?: number;
  }): void {
    if (!this.runLogger?.enabled) {
      return;
    }
    this.runLogger.logEvent({
      level: input.level ?? "info",
      component: "linkedin-adapter",
      stage: this.resolveActiveStage(input.stage),
      action: input.action,
      details: input.details ?? {},
      url: input.url,
      pageId: input.page ? this.getPageTraceId(input.page) : undefined,
      attempt: input.attempt,
      elapsedMs: input.elapsedMs
    });
  }

  private logTraceDecision(input: {
    decision: string;
    details?: Record<string, unknown>;
    stage?: string | null;
    level?: "debug" | "info" | "warn" | "error";
    attempt?: number;
  }): void {
    if (!this.runLogger?.enabled) {
      return;
    }
    this.runLogger.logDecision({
      stage: this.resolveActiveStage(input.stage),
      decision: input.decision,
      details: input.details,
      level: input.level,
      attempt: input.attempt
    });
  }

  private async runTracedPageAction<T>(input: {
    page: Page;
    action: string;
    stage?: string | null;
    selector?: string;
    url?: string;
    note?: string;
    attempt?: number;
    details?: Record<string, unknown>;
    counts?: Record<string, unknown>;
    run: () => Promise<T>;
  }): Promise<T> {
    if (!this.runLogger?.enabled) {
      return input.run();
    }

    return executeTracedOperation({
      logger: this.runLogger,
      component: "linkedin-adapter",
      stage: this.resolveActiveStage(input.stage),
      action: input.action,
      selector: input.selector,
      url: input.url,
      note: input.note,
      counts: input.counts,
      attempt: input.attempt,
      details: {
        pageId: this.getPageTraceId(input.page),
        ...(input.details ?? {})
      },
      run: input.run
    });
  }

  private async tracedClick(
    page: Page,
    selector: string,
    input?: {
      stage?: string | null;
      timeoutMs?: number;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "click",
      selector,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => {
        await page.locator(selector).first().click({
          timeout: input?.timeoutMs
        });
      }
    });
  }

  private async tracedWaitForVisible(
    page: Page,
    selector: string,
    timeoutMs: number,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "wait_for_visible",
      selector,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => {
        await page.waitForSelector(selector, {
          state: "visible",
          timeout: timeoutMs
        });
      }
    });
  }

  private async tracedLocatorCount(
    page: Page,
    selector: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<number> {
    return this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "locator_count",
      selector,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => page.locator(selector).count()
    });
  }

  private async tracedScrollContainer(
    page: Page,
    containerSelector: string,
    delta: number,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "scroll_container",
      selector: containerSelector,
      note: input?.note,
      attempt: input?.attempt,
      details: {
        delta
      },
      run: async () => {
        const target = page.locator(containerSelector).first();
        await target.hover({ force: true }).catch(() => undefined);
        await page.mouse.wheel(0, delta);
      }
    });
  }

  private async tracedScreenshot(
    page: Page,
    filePath: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "screenshot",
      note: input?.note,
      attempt: input?.attempt,
      details: {
        filePath
      },
      run: async () => {
        await page.screenshot({
          path: filePath,
          fullPage: true
        });
      }
    });
  }

  private async tracedDomDump(
    page: Page,
    filePath: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "dom_dump",
      note: input?.note,
      attempt: input?.attempt,
      details: {
        filePath
      },
      run: async () => {
        const html = await page.content();
        await writeFile(filePath, html, "utf8");
      }
    });
  }

  private async tracedGoto(
    page: Page,
    url: string,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
      timeoutMs?: number;
      waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "goto",
      url,
      note: input?.note,
      attempt: input?.attempt,
      run: async () => {
        await page.goto(url, {
          waitUntil: input?.waitUntil ?? "domcontentloaded",
          timeout: input?.timeoutMs
        });
      }
    });
  }

  private async tracedReload(
    page: Page,
    input?: {
      stage?: string | null;
      note?: string;
      attempt?: number;
      timeoutMs?: number;
      waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
    }
  ): Promise<void> {
    await this.runTracedPageAction({
      page,
      stage: input?.stage,
      action: "reload",
      note: input?.note,
      attempt: input?.attempt,
      url: page.url(),
      run: async () => {
        await page.reload({
          waitUntil: input?.waitUntil ?? "domcontentloaded",
          timeout: input?.timeoutMs
        });
      }
    });
  }

  private async startRunTracing(page: Page): Promise<() => Promise<void>> {
    const cleanup: Array<() => void> = [];
    let tracingStarted = false;

    if (this.runLogger?.enabled) {
      const pageId = this.getPageTraceId(page);
      const onConsole = (msg: any): void => {
        this.logTraceEvent({
          level: "debug",
          stage: "browser_events",
          action: "browser_console",
          details: {
            type: msg.type(),
            text: msg.text()
          },
          page
        });
      };
      const onPageError = (error: any): void => {
        this.logTraceEvent({
          level: "error",
          stage: "browser_events",
          action: "pageerror",
          details: {
            message: error.message,
            stack: error.stack
          },
          page
        });
      };
      const onRequestFailed = (request: any): void => {
        this.logTraceEvent({
          level: "warn",
          stage: "browser_events",
          action: "requestfailed",
          details: {
            url: request.url(),
            method: request.method(),
            failure: request.failure()?.errorText ?? "unknown"
          },
          url: request.url(),
          page
        });
      };
      const onResponse = (response: any): void => {
        const status = response.status();
        if (status < 400) {
          return;
        }
        this.logTraceEvent({
          level: "warn",
          stage: "browser_events",
          action: "http_error",
          details: {
            url: response.url(),
            status
          },
          url: response.url(),
          page
        });
      };
      const onFrameNavigated = (frame: any): void => {
        if (frame !== page.mainFrame()) {
          return;
        }
        this.logTraceEvent({
          level: "info",
          stage: "browser_events",
          action: "navigated",
          details: {
            url: frame.url(),
            pageId
          },
          url: frame.url(),
          page
        });
      };
      const onClose = (): void => {
        this.logTraceEvent({
          level: "warn",
          stage: "browser_events",
          action: "page_closed",
          details: {
            pageId
          }
        });
      };

      page.on("console", onConsole);
      page.on("pageerror", onPageError);
      page.on("requestfailed", onRequestFailed);
      page.on("response", onResponse);
      page.on("framenavigated", onFrameNavigated);
      page.on("close", onClose);
      cleanup.push(() => page.off("console", onConsole));
      cleanup.push(() => page.off("pageerror", onPageError));
      cleanup.push(() => page.off("requestfailed", onRequestFailed));
      cleanup.push(() => page.off("response", onResponse));
      cleanup.push(() => page.off("framenavigated", onFrameNavigated));
      cleanup.push(() => page.off("close", onClose));

      try {
        await page.context().tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true
        });
        tracingStarted = true;
        this.logTraceEvent({
          level: "info",
          stage: "browser_events",
          action: "playwright_trace_started",
          details: {
            pageId
          },
          page
        });
      } catch (error) {
        this.runLogger.logError({
          component: "linkedin-adapter",
          stage: this.resolveActiveStage("browser_events"),
          action: "playwright_trace_start_failed",
          error
        });
      }
    }

    return async () => {
      for (const dispose of cleanup) {
        dispose();
      }
      if (!this.runLogger?.enabled || !tracingStarted || !this.runLogger.runDir) {
        return;
      }

      const tracePath = join(this.runLogger.runDir, "playwright-trace.zip");
      try {
        await page.context().tracing.stop({
          path: tracePath
        });
        this.runLogger.attachArtifact({
          playwrightTracePath: tracePath
        });
        this.logTraceEvent({
          stage: "browser_events",
          action: "playwright_trace_saved",
          details: {
            tracePath
          },
          page
        });
      } catch (error) {
        this.runLogger.logError({
          component: "linkedin-adapter",
          stage: this.resolveActiveStage("browser_events"),
          action: "playwright_trace_stop_failed",
          error
        });
      }
    };
  }

  private async captureRunFailureArtifacts(page: Page): Promise<void> {
    if (!this.runLogger?.enabled || !this.runLogger.runDir || page.isClosed()) {
      return;
    }
    const failureScreenshotPath = join(this.runLogger.runDir, "failure.png");
    const failureDomPath = join(this.runLogger.runDir, "dom.html");

    try {
      await this.tracedScreenshot(page, failureScreenshotPath, {
        stage: this.resolveActiveStage("failure_artifacts"),
        note: "failure_capture"
      });
      this.runLogger.attachArtifact({
        failureScreenshotPath
      });
    } catch {
      // best effort only
    }

    try {
      await this.tracedDomDump(page, failureDomPath, {
        stage: this.resolveActiveStage("failure_artifacts"),
        note: "failure_capture"
      });
      this.runLogger.attachArtifact({
        failureDomDumpPath: failureDomPath
      });
    } catch {
      // best effort only
    }
  }

  private async runWithPlatformLease<T>(work: () => Promise<T>): Promise<T> {
    const manager = this.deps.sessionManager as SessionManager & {
      withPlatformLease?: (input: { platform: "LINKEDIN"; personKey?: string }, work: () => Promise<T>) => Promise<T>;
    };
    if (typeof manager.withPlatformLease !== "function") {
      return work();
    }
    return manager.withPlatformLease({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default"
    }, work);
  }

  private async getPage(): Promise<Page> {
    return this.deps.sessionManager.getManagedPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default",
      args: ["--disable-blink-features=AutomationControlled"],
      runLogger: this.runLogger ?? undefined
    });
  }

  private async navigateInbox(selectors: SelectorRegistry): Promise<Page> {
    const navigate = async (target: Page): Promise<void> => {
      await target.bringToFront();
      await this.tracedGoto(target, selectors.inbox_url, {
        stage: "navigate",
        note: "navigate_inbox",
        waitUntil: "commit",
        timeoutMs: LinkedInAdapter.inboxNavigationTimeoutMs
      });
      await this.runTracedPageAction({
        page: target,
        stage: "navigate",
        action: "wait_for_domcontentloaded",
        note: "post_goto_domcontentloaded",
        run: async () => {
          await target.waitForLoadState("domcontentloaded", {
            timeout: 4_000
          }).catch(() => undefined);
        }
      });
      await this.runTracedPageAction({
        page: target,
        stage: "navigate",
        action: "wait_for_timeout",
        note: "post_navigation_settle",
        details: {
          delayMs: 350
        },
        run: async () => {
          await target.waitForTimeout(350);
        }
      });
    };

    const page = await retryWithBackoff({
      attempts: 2,
      baseDelayMs: 300,
      isRetryable: (error) => isTransientPageError(error),
      run: async () => {
        const target = await this.getPage();
        await navigate(target);
        return target;
      }
    });

    return page;
  }

  private classifyFailureKind(reason: string, fallback: AdapterFailureKind): AdapterFailureKind {
    const normalized = reason.toLowerCase();
    if (
      normalized.includes("target page, context or browser has been closed") ||
      normalized.includes("execution context was destroyed") ||
      normalized.includes("manual refresh required")
    ) {
      return "NAVIGATION_FAILED";
    }
    return inferAdapterFailureKindFromMessage(reason) ?? fallback;
  }

  private normalizeTimestamp(rawValue: string | undefined, fallbackIso: string): string {
    if (!rawValue) {
      return fallbackIso;
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
      return fallbackIso;
    }

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        const normalizedMs = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
        const parsedNumeric = new Date(normalizedMs);
        if (!Number.isNaN(parsedNumeric.getTime())) {
          return parsedNumeric.toISOString();
        }
      }
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }

    const parsedListTimestamp = parseLinkedInListTimestamp(trimmed, new Date());
    if (parsedListTimestamp) {
      return parsedListTimestamp.toISOString();
    }

    return fallbackIso;
  }

  private normalizeIdentity(value: string | undefined): string {
    return cleanText(value ?? "").toLowerCase();
  }

  private normalizeThreadUrl(value: string | undefined): string {
    if (!value) {
      return "";
    }
    try {
      const parsed = new URL(value);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch {
      return value.replace(/[?#].*$/, "").replace(/\/+$/, "").trim();
    }
  }

  private resolveThreadUrlToken(value: string | undefined): string {
    const normalized = this.normalizeThreadUrl(value);
    if (!normalized) {
      return "";
    }

    const threadMatch = normalized.match(/\/messaging\/thread\/([^/]+)/i);
    if (threadMatch?.[1]) {
      return threadMatch[1].toLowerCase();
    }

    const conversationMatch = normalized.match(/conversationid=([^&]+)/i);
    if (conversationMatch?.[1]) {
      return conversationMatch[1].toLowerCase();
    }

    return normalized.toLowerCase();
  }

  private extractThreadTokenFromUrlLike(value: string | undefined): string | null {
    const trimmed = cleanText(value ?? "");
    if (!trimmed) {
      return null;
    }
    try {
      const parsed = new URL(trimmed, "https://www.linkedin.com");
      const fromPath = parsed.pathname.match(/\/messaging\/thread\/([^/?#]+)/i)?.[1]?.trim().toLowerCase();
      if (fromPath) {
        return fromPath;
      }
      const fromHash = parsed.hash.match(/\/messaging\/thread\/([^/?#]+)/i)?.[1]?.trim().toLowerCase();
      if (fromHash) {
        return fromHash;
      }
      const fromConversationId =
        parsed.searchParams.get("conversationId")?.trim().toLowerCase() ??
        parsed.searchParams.get("conversationid")?.trim().toLowerCase();
      if (fromConversationId) {
        return fromConversationId;
      }
      if (parsed.protocol === "data:" || parsed.protocol === "blob:") {
        return null;
      }
    } catch {
      // fall through
    }
    const fromRaw = trimmed.match(/\/messaging\/thread\/([^/?#]+)/i)?.[1]?.trim().toLowerCase();
    if (fromRaw) {
      return fromRaw;
    }
    return null;
  }

  private resolveCurrentActiveThreadToken(page: Page): string | null {
    return this.extractThreadTokenFromUrlLike(page.url());
  }

  private async extractCandidateRowToken(
    rowHandle: ElementHandle<Element> | null,
    row: LinkedInVisibleRowSnapshot
  ): Promise<string | null> {
    const fromRowSnapshot =
      this.extractThreadTokenFromUrlLike(row.threadUrl ?? row.href) ??
      this.extractThreadTokenFromUrlLike(row.activeKey);
    if (fromRowSnapshot) {
      return fromRowSnapshot;
    }
    if (!rowHandle) {
      return null;
    }
    const domToken = await rowHandle
      .evaluate((node) => {
        const asElement = node as HTMLElement;
        const rawCandidates = [
          asElement.getAttribute("data-thread-id"),
          asElement.getAttribute("data-conversation-id"),
          asElement.getAttribute("data-id"),
          asElement.getAttribute("data-conversation-urn"),
          asElement.getAttribute("data-urn"),
          (asElement.querySelector("a[href*='/messaging/thread/']") as HTMLAnchorElement | null)?.getAttribute("href"),
          (asElement.querySelector("a[href*='/messaging/']") as HTMLAnchorElement | null)?.getAttribute("href")
        ];
        for (const entry of rawCandidates) {
          const value = (entry ?? "").trim();
          if (value) {
            return value;
          }
        }
        return null;
      })
      .catch(() => null);
    return this.extractThreadTokenFromUrlLike(domToken ?? undefined);
  }

  private async isRowMarkedActive(rowHandle: ElementHandle<Element>): Promise<boolean> {
    return rowHandle
      .evaluate((node) => {
        const target = node as HTMLElement;
        const clickTarget =
          target.matches(".msg-conversation-listitem__link")
            ? target
            : (target.querySelector(".msg-conversation-listitem__link") as HTMLElement | null) ?? target;
        const className = (clickTarget.className ?? "").toString().toLowerCase();
        if (className.includes("convo-item-link--active") || className.includes("conversation-listitem__link--active")) {
          return true;
        }
        const ariaCurrent = (clickTarget.getAttribute("aria-current") ?? "").toLowerCase();
        const ariaSelected = (clickTarget.getAttribute("aria-selected") ?? "").toLowerCase();
        if (ariaCurrent === "true" || ariaCurrent === "page" || ariaSelected === "true") {
          return true;
        }
        const activeAncestor = clickTarget.closest("[aria-current='true'], [aria-selected='true']");
        return Boolean(activeAncestor);
      })
      .catch(() => false);
  }

  private async detectAuthRequired(
    page: Page
  ): Promise<{ authRequired: boolean; url: string; source?: "url" | "dom" }> {
    const url = page.url();
    if (/\/uas\/login/i.test(url)) {
      return { authRequired: true, url, source: "url" };
    }

    const hasUsername = (await page.locator("#username").count().catch(() => 0)) > 0;
    const hasPassword = (await page.locator("#password").count().catch(() => 0)) > 0;
    const hasLoginForm =
      (await page.locator("form[action*='login-submit']").count().catch(() => 0)) > 0 ||
      (await page.locator("form[data-id='sign-in-form']").count().catch(() => 0)) > 0 ||
      (await page.locator("[data-id='sign-in-form']").count().catch(() => 0)) > 0;
    const hasLoginDom = hasUsername || hasPassword || hasLoginForm;

    return {
      authRequired: hasLoginDom,
      url,
      source: hasLoginDom ? "dom" : undefined
    };
  }

  private async throwIfAuthRequired(page: Page, context: string): Promise<void> {
    const authState = await this.detectAuthRequired(page);
    if (!authState.authRequired) {
      return;
    }

    throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
      kind: "AUTH_REQUIRED",
      platform: this.platform,
      stage: "navigate",
      details: {
        context,
        url: authState.url,
        detection: authState.source ?? "unknown"
      }
    });
  }

  private summarizeError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
    return {
      message: String(error)
    };
  }

  private async detectLinkedInOverlayReason(page: Page): Promise<LinkedInScanFailureReason | undefined> {
    const url = page.url().toLowerCase();
    if (/\/uas\/login/i.test(url)) {
      return "login_required";
    }
    if (/\/checkpoint\//i.test(url)) {
      return "checkpoint_required";
    }

    const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
    if (bodyText.includes("verify your identity") || bodyText.includes("checkpoint")) {
      return "checkpoint_required";
    }
    if (bodyText.includes("upgrade to premium") || bodyText.includes("start free trial")) {
      return "blocked_by_modal";
    }
    if (bodyText.includes("too many requests") || bodyText.includes("try again later")) {
      return "rate_limited";
    }
    if (bodyText.includes("something went wrong")) {
      return "linkedin_error_overlay";
    }
    if (bodyText.includes("sign in") && (bodyText.includes("join now") || bodyText.includes("forgot password"))) {
      return "login_required";
    }

    return undefined;
  }

  private async captureUnreadScanRuntimeContext(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<LinkedInScanRuntimeContext> {
    const unreadPill = page.locator(linkedInUnreadPillSelector).first();
    const unreadPillPresent = (await unreadPill.count().catch(() => 0)) > 0;
    const unreadPillActive = unreadPillPresent
      ? isLinkedInUnreadPillActive({
          ariaPressed: await unreadPill.getAttribute("aria-pressed").catch(() => null),
          ariaChecked: await unreadPill.getAttribute("aria-checked").catch(() => null)
        })
      : false;

    const overlayReason = await this.detectLinkedInOverlayReason(page);

    return {
      url: page.url(),
      threadListCount: await page.locator(selectors.thread_list).count().catch(() => 0),
      threadItemCount: await page.locator(selectors.thread_item).count().catch(() => 0),
      unreadBadgeCount: await page.locator(selectors.unread_badge).count().catch(() => 0),
      unreadPillPresent,
      unreadPillActive,
      spinnerCount: await page.locator(linkedInLoadingSpinnerSelector).count().catch(() => 0),
      overlayReason
    };
  }

  private async waitForUnreadListSettle(page: Page, selectors: SelectorRegistry): Promise<void> {
    const deadline = Date.now() + 4_000;
    let stableIterations = 0;
    let previousFingerprint = "";
    while (Date.now() < deadline) {
      const threadItemCount = await this.tracedLocatorCount(page, selectors.thread_item, {
        stage: "unread_filter",
        note: "settle_thread_count"
      }).catch(() => 0);
      const unreadBadgeCount = await this.tracedLocatorCount(page, selectors.unread_badge, {
        stage: "unread_filter",
        note: "settle_unread_badge_count"
      }).catch(() => 0);
      const spinnerCount = await this.tracedLocatorCount(page, linkedInLoadingSpinnerSelector, {
        stage: "unread_filter",
        note: "settle_spinner_count"
      }).catch(() => 0);
      const firstRow = page.locator(selectors.thread_item).first();
      const firstRowText =
        (await firstRow.count().catch(() => 0)) > 0
          ? ((await firstRow.textContent({ timeout: 0 }).catch(() => null)) ?? "")
          : "";
      const fingerprint = `${threadItemCount}|${unreadBadgeCount}|${spinnerCount}|${firstRowText.slice(0, 80)}`;

      if (threadItemCount > 0 || unreadBadgeCount > 0) {
        return;
      }

      if (spinnerCount > 0) {
        stableIterations = 0;
      } else if (fingerprint === previousFingerprint) {
        stableIterations += 1;
        if (stableIterations >= 3) {
          return;
        }
      } else {
        stableIterations = 0;
      }

      previousFingerprint = fingerprint;
      await this.runTracedPageAction({
        page,
        stage: "unread_filter",
        action: "wait_for_timeout",
        note: "settle_poll_wait",
        details: {
          delayMs: 140
        },
        run: async () => {
          await page.waitForTimeout(140);
        }
      });
    }
  }

  async ensureUnreadFilterActive(page: Page, selectors: SelectorRegistry): Promise<LinkedInUnreadFilterActivationResult> {
    const result = await activateLinkedInUnreadFilterWithHooks(page, {
      clickUnreadPill: async () => {
        return this.tracedClick(page, linkedInUnreadPillSelector, {
          stage: "unread_filter",
          timeoutMs: 5_000,
          note: "activate_unread_pill"
        })
          .then(() => true)
          .catch(() => false);
      },
      waitForTimeout: async (ms: number) => {
        await this.runTracedPageAction({
          page,
          stage: "unread_filter",
          action: "wait_for_timeout",
          note: "unread_filter_refresh_wait",
          details: {
            delayMs: ms
          },
          run: async () => {
            await page.waitForTimeout(ms);
          }
        });
      }
    });
    this.logTraceDecision({
      stage: "unread_filter",
      decision: "Unread filter activation result",
      details: { ...result }
    });
    await this.waitForUnreadListSettle(page, selectors);
    return result;
  }

  private async ensureAllFilterActive(page: Page): Promise<void> {
    const allPill = page.locator(linkedInAllPillSelector).first();
    const allPillCount = await allPill.count().catch(() => 0);
    if (allPillCount <= 0) {
      this.logTraceDecision({
        stage: "collect_threads",
        decision: "All filter pill not present; proceeding with default inbox filter"
      });
      return;
    }

    const ariaPressed = await allPill.getAttribute("aria-pressed").catch(() => null);
    const ariaChecked = await allPill.getAttribute("aria-checked").catch(() => null);
    const active = isLinkedInUnreadPillActive({
      ariaPressed,
      ariaChecked
    });

    if (active) {
      return;
    }

    await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "click",
      selector: linkedInAllPillSelector,
      note: "activate_all_pill",
      run: async () => {
        await allPill.click({
          timeout: 5_000
        });
      }
    });
    await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "wait_for_timeout",
      note: "after_activate_all_pill",
      details: {
        delayMs: 300
      },
      run: async () => {
        await page.waitForTimeout(300);
      }
    });
  }

  async waitForThreadListReadyOrClassified(
    page: Page,
    selectors: SelectorRegistry,
    timeoutMs = 8_000
  ): Promise<{ ready: boolean; empty: boolean; reason?: LinkedInScanFailureReason | LinkedInCollectionStopReason }> {
    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        throw new Error("Target page, context or browser has been closed");
      }

      const overlayReason = await this.detectLinkedInOverlayReason(page);
      if (overlayReason) {
        return {
          ready: false,
          empty: false,
          reason: overlayReason
        };
      }

      const listLocator = page.locator(selectors.thread_list).first();
      await listLocator.isVisible({ timeout: 0 }).catch(() => false);
      const threadCount = await this.tracedLocatorCount(page, selectors.thread_item, {
        stage: "collect_threads",
        note: "read_thread_item_count"
      }).catch(() => 0);
      if (threadCount > 0) {
        return {
          ready: true,
          empty: false
        };
      }

      const emptyStateCount = await this.tracedLocatorCount(
        page,
        linkedInStreamingEmptyStateSelector,
        {
          stage: "collect_threads",
          note: "read_empty_state_count"
        }
      ).catch(() => 0);
      if (emptyStateCount > 0) {
        return {
          ready: true,
          empty: true,
          reason: "zero_threads_found"
        };
      }

      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "wait_for_timeout",
        note: "thread_list_poll_wait",
        details: {
          delayMs: 140
        },
        run: async () => {
          await page.waitForTimeout(140);
        }
      });
    }

    throw new Error("Timed out waiting for LinkedIn thread list container to become ready.");
  }

  async collectThreadCandidates(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{
    rows: LinkedInThreadSnapshot[];
    trailingKey: string | null;
    threadListCount: number;
    threadItemCount: number;
    spinnerCount: number;
    visibleSetHash: string;
    bottomKey: string | null;
  }> {
    const threadListLocator = page.locator(selectors.thread_list).first();
    const threadListCount = await threadListLocator.count().catch(() => 0);
    const rowRoots = page.locator(".msg-conversation-listitem");
    const selectorItemCount = await rowRoots.count().catch(() => 0);
    const rows: LinkedInThreadSnapshot[] = [];

    const readText = async (locator: Locator): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.innerText({ timeout: 0 }).catch(() => null);
    };
    const readAttr = async (locator: Locator, name: string): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.getAttribute(name, { timeout: 0 }).catch(() => null);
    };

    for (let index = 0; index < selectorItemCount; index += 1) {
      const scope = rowRoots.nth(index);
      const clickTarget = scope.locator(".msg-conversation-listitem__link").first();
      const clickTargetExists = (await clickTarget.count().catch(() => 0)) > 0;
      const linkContainer = clickTargetExists ? clickTarget : scope;

      const hrefRaw =
        (await readAttr(linkContainer, "href")) ??
        (await readAttr(linkContainer.locator("a[href*='/messaging/']"), "href")) ??
        "";
      let href = hrefRaw.trim();
      if (href) {
        try {
          href = new URL(href, page.url()).toString();
        } catch {
          href = href.trim();
        }
      }

      const displayName = cleanText(
        (await readText(scope.locator(".msg-conversation-listitem__participant-names span.truncate"))) ??
          (await readText(scope.locator(".msg-conversation-listitem__participant-names"))) ??
          (await readText(scope.locator("h3 span.truncate"))) ??
          (await readText(scope.locator("h3"))) ??
          ""
      );
      const preview = cleanText(
        (await readText(scope.locator(".msg-conversation-card__message-snippet"))) ??
          (await readText(scope.locator("p.msg-conversation-card__message-snippet"))) ??
          ""
      ).slice(0, 220);
      const pillText = cleanText(
        (await readText(scope.locator(".msg-conversation-card__pill"))) ??
          (await readText(scope.locator("span.msg-conversation-card__pill"))) ??
          ""
      );
      if (isSponsoredPillText(pillText)) {
        continue;
      }
      const lastMessageAt = cleanText(
        (await readText(scope.locator("time.msg-conversation-listitem__time-stamp"))) ??
          (await readText(scope.locator("time"))) ??
          ""
      );

      const unreadContainer = scope.locator(".msg-conversation-card__unread-count").first();
      const unreadContainerExists = (await unreadContainer.count().catch(() => 0)) > 0;
      const unreadText = cleanText(
        (await readText(unreadContainer.locator(".notification-badge__count"))) ??
          (await readText(unreadContainer)) ??
          ""
      );
      const unreadMatch = unreadText.match(/\d+/);
      const unreadCount = unreadMatch ? Number(unreadMatch[0]) : unreadContainerExists ? 1 : 0;

      const urnToken =
        (await readAttr(scope, "data-conversation-urn")) ??
        (await readAttr(scope, "data-urn")) ??
        (await readAttr(scope, "data-event-urn")) ??
        (await readAttr(scope, "data-conversation-id")) ??
        (await readAttr(scope, "data-id")) ??
        (await readAttr(scope, "id")) ??
        "";
      const canonicalId = normalizeCanonicalLinkedInThreadId({
        threadUrl: href || undefined,
        activeKey: urnToken || undefined
      });
      const stableKey =
        canonicalId ??
        buildTemporaryCandidateId({
          displayName,
          preview,
          listTimestamp: lastMessageAt,
          rowIndex: index
        });
      const needsReplyFromList = needsReplyFromPreview(preview);
      const includeCandidate = unreadCount > 0 || needsReplyFromList;
      if (!displayName || !includeCandidate) {
        continue;
      }
      const avatarUrl = (await readAttr(scope.locator("img"), "src")) ?? undefined;

      rows.push({
        stableKey,
        platformThreadId: canonicalId ?? undefined,
        isTemporaryId: !canonicalId,
        displayName,
        unreadCount,
        lastMessagePreview: preview,
        lastMessageAt: lastMessageAt || undefined,
        threadUrl: href || undefined,
        avatarUrl,
        needsReplyFromList
      });
    }

    const visibleSetHash = rows.map((row) => row.stableKey).join("|");
    const bottomKey = rows.at(-1)?.stableKey ?? null;
    return {
      rows,
      trailingKey: bottomKey,
      threadListCount,
      threadItemCount: selectorItemCount,
      spinnerCount: await page.locator(linkedInLoadingSpinnerSelector).count().catch(() => 0),
      visibleSetHash,
      bottomKey
    };
  }

  async captureThreadRowsSnapshot(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{
    rows: LinkedInThreadSnapshot[];
    trailingKey: string | null;
    threadListCount: number;
    threadItemCount: number;
    spinnerCount: number;
    visibleSetHash: string;
    bottomKey: string | null;
  }> {
    return this.collectThreadCandidates(page, selectors);
  }

  async deepScrollThreadList(
    page: Page,
    selectors: SelectorRegistry,
    state: { bottomKey: string | null; visibleSetHash: string }
  ): Promise<{ didScroll: boolean; reachedBottom: boolean; moved: boolean }> {
    const listTarget = page.locator(selectors.thread_list).first();
    const listTargetCount = await listTarget.count().catch(() => 0);
    if (listTargetCount <= 0) {
      return { didScroll: false, reachedBottom: true, moved: false };
    }

    const rowRoots = page.locator(".msg-conversation-listitem");
    const beforeCount = await rowRoots.count().catch(() => 0);
    if (beforeCount > 0) {
      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "scroll_into_view",
        note: "row_tail_scroll",
        run: async () => {
          await rowRoots
            .nth(beforeCount - 1)
            .scrollIntoViewIfNeeded()
            .catch(() => undefined);
        }
      });
    } else {
      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "scroll_into_view",
        selector: selectors.thread_list,
        note: "container_scroll",
        run: async () => {
          await listTarget.scrollIntoViewIfNeeded().catch(() => undefined);
        }
      });
    }

    await this.tracedScrollContainer(page, selectors.thread_list, 840, {
      stage: "collect_threads",
      note: "primary_scroll"
    });
    await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "wait_for_timeout",
      note: "after_primary_scroll",
      details: {
        delayMs: Math.max(80, this.deps.scanScrollWaitMs)
      },
      run: async () => {
        await page.waitForTimeout(Math.max(80, this.deps.scanScrollWaitMs));
      }
    });

    let after = await this.collectThreadCandidates(page, selectors).catch(() => null);
    let moved = Boolean(after && after.bottomKey && after.bottomKey !== state.bottomKey);
    if (!moved) {
      await this.tracedScrollContainer(page, selectors.thread_list, 840, {
        stage: "collect_threads",
        note: "secondary_scroll"
      });
      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "wait_for_timeout",
        note: "after_secondary_scroll",
        details: {
          delayMs: Math.max(80, this.deps.scanScrollWaitMs)
        },
        run: async () => {
          await page.waitForTimeout(Math.max(80, this.deps.scanScrollWaitMs));
        }
      });
      after = await this.collectThreadCandidates(page, selectors).catch(() => null);
      moved = Boolean(after && after.bottomKey && after.bottomKey !== state.bottomKey);
    }

    return {
      didScroll: true,
      reachedBottom: !moved,
      moved
    };
  }

  async collectThreadRowsWithScroll(
    page: Page,
    selectors: SelectorRegistry,
    maxThreads: number,
    options?: LinkedInFullScanOptions
  ): Promise<{
    rows: ThreadStub[];
    rowsBeforeCapCount: number;
    iterations: number;
    stopReason: LinkedInCollectionStopReason;
    noProgressStreak: number;
    bottomRepeatStreak: number;
    scrollNoMoveStreak: number;
    scrollIterations: number;
  }> {
    const readiness = await this.waitForThreadListReadyOrClassified(page, selectors, 8_000);
    if (!readiness.ready) {
      if (readiness.reason === "login_required" || readiness.reason === "checkpoint_required") {
        throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
          kind: "AUTH_REQUIRED",
          stage: "collect_threads",
          platform: this.platform,
          details: {
            reason: readiness.reason,
            url: page.url()
          }
        });
      }
      if (readiness.reason === "rate_limited" || readiness.reason === "linkedin_error_overlay") {
        throw new AdapterFailure("LinkedIn unread thread list is blocked by an overlay.", {
          kind: "SELECTOR_MISMATCH",
          stage: "collect_threads",
          platform: this.platform,
          details: {
            reason: readiness.reason,
            url: page.url()
          }
        });
      }
      throw new Error("LinkedIn thread list is not ready for unread collection.");
    }

    if (readiness.empty) {
      return {
        rows: [],
        rowsBeforeCapCount: 0,
        iterations: 0,
        stopReason: "zero_threads_found",
        noProgressStreak: 0,
        bottomRepeatStreak: 0,
        scrollNoMoveStreak: 0,
        scrollIterations: 0
      };
    }

    const cappedMaxThreads = Math.max(1, options?.maxThreads ?? maxThreads);
    const stableIterationsTarget = Math.max(1, this.deps.scanStableIterations);
    const maxIterations = Math.max(20, Math.min(60, this.deps.scanMaxThreads * 3));
    const maxDurationMs = 45_000;
    const merged = new Map<string, ThreadStub>();
    const startedAt = Date.now();
    let scrollIterations = 0;

    let iterations = 0;
    let loadingWindowIterations = 0;
    let missingListIterations = 0;
    let noProgressStreak = 0;
    let bottomRepeatStreak = 0;
    let scrollNoMoveStreak = 0;
    let previousBottomKey: string | null = null;
    let stopReason: LinkedInCollectionStopReason = "max_iterations";

    this.logTraceEvent({
      stage: "collect_threads",
      action: "collection_start",
      details: {
        maxThreads: cappedMaxThreads,
        disableDeepScroll: options?.disableDeepScroll ?? false,
        stableIterationsTarget,
        maxIterations,
        maxDurationMs
      },
      page
    });

    while (iterations < maxIterations) {
      if (Date.now() - startedAt >= maxDurationMs) {
        stopReason = "max_duration";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to max duration",
          details: {
            maxDurationMs,
            elapsedMs: Date.now() - startedAt
          },
          level: "warn"
        });
        break;
      }

      iterations += 1;
      const snapshot = await retryWithBackoff({
        attempts: 3,
        baseDelayMs: 250,
        isRetryable: (error) => isRetryableLinkedInCollectError(error),
        run: async () => this.captureThreadRowsSnapshot(page, selectors)
      });
      this.logTraceEvent({
        stage: "collect_threads",
        action: "collection_iteration_snapshot",
        details: {
          iteration: iterations,
          threadListCount: snapshot.threadListCount,
          threadItemCount: snapshot.threadItemCount,
          spinnerCount: snapshot.spinnerCount,
          visibleCount: snapshot.rows.length
        },
        attempt: iterations,
        page
      });

      if (snapshot.threadItemCount === 0 && snapshot.spinnerCount > 0) {
        loadingWindowIterations += 1;
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Thread list still loading after unread filter",
          details: {
            loadingWindowIterations,
            spinnerCount: snapshot.spinnerCount
          },
          attempt: iterations
        });
        if (loadingWindowIterations >= 12) {
          throw new Error("LinkedIn thread list is still loading after unread filter activation.");
        }
        await this.runTracedPageAction({
          page,
          stage: "collect_threads",
          action: "wait_for_timeout",
          note: "loading_window_wait",
          details: {
            delayMs: this.deps.scanScrollWaitMs
          },
          attempt: iterations,
          run: async () => {
            await page.waitForTimeout(this.deps.scanScrollWaitMs);
          }
        });
        continue;
      }

      loadingWindowIterations = 0;
      if (snapshot.threadListCount <= 0) {
        missingListIterations += 1;
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Thread list container missing during collection",
          details: {
            missingListIterations
          },
          attempt: iterations
        });
        if (missingListIterations >= 6) {
          throw new Error("LinkedIn thread list container is missing while collecting unread threads.");
        }
        await this.runTracedPageAction({
          page,
          stage: "collect_threads",
          action: "wait_for_timeout",
          note: "missing_list_wait",
          details: {
            delayMs: this.deps.scanScrollWaitMs
          },
          attempt: iterations,
          run: async () => {
            await page.waitForTimeout(this.deps.scanScrollWaitMs);
          }
        });
        continue;
      }
      missingListIterations = 0;

      if (snapshot.threadItemCount === 0) {
        const overlayReason = await this.detectLinkedInOverlayReason(page);
        if (overlayReason === "login_required" || overlayReason === "checkpoint_required") {
          throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
            kind: "AUTH_REQUIRED",
            stage: "collect_threads",
            platform: this.platform,
            details: {
              reason: overlayReason,
              url: page.url()
            }
          });
        }
        if (overlayReason === "rate_limited" || overlayReason === "linkedin_error_overlay") {
          throw new AdapterFailure("LinkedIn unread thread list is blocked by an overlay.", {
            kind: "SELECTOR_MISMATCH",
            stage: "collect_threads",
            platform: this.platform,
            details: {
              reason: overlayReason,
              url: page.url()
            }
          });
        }
      }

      const previousCount = merged.size;
      for (const row of snapshot.rows) {
        if (merged.has(row.stableKey)) {
          continue;
        }
        merged.set(row.stableKey, {
          platformThreadId: row.platformThreadId ?? row.stableKey,
          displayName: row.displayName,
          unreadCount: row.unreadCount,
          lastMessagePreview: row.lastMessagePreview,
          lastMessageAt: row.lastMessageAt,
          threadUrl: row.threadUrl,
          avatarUrl: row.avatarUrl,
          needsReplyFromList: row.needsReplyFromList
        });
      }
      const nextCount = merged.size;
      const grew = nextCount > previousCount;
      const bottomRepeated = Boolean(snapshot.bottomKey && snapshot.bottomKey === previousBottomKey);

      if (grew) {
        noProgressStreak = 0;
      } else {
        noProgressStreak += 1;
      }
      bottomRepeatStreak = bottomRepeated ? bottomRepeatStreak + 1 : 0;

      previousBottomKey = snapshot.bottomKey;

      if (nextCount >= cappedMaxThreads) {
        stopReason = "max_threads";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection after hitting max thread cap",
          details: {
            nextCount,
            cappedMaxThreads
          }
        });
        break;
      }
      if (noProgressStreak >= stableIterationsTarget) {
        stopReason = "end_of_list_no_progress";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to no growth streak",
          details: {
            noProgressStreak,
            stableIterationsTarget
          }
        });
        break;
      }
      if (bottomRepeatStreak >= stableIterationsTarget) {
        stopReason = "end_of_list_reached";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to repeated bottom key",
          details: {
            bottomRepeatStreak,
            stableIterationsTarget
          }
        });
        break;
      }
      if (scrollNoMoveStreak >= stableIterationsTarget) {
        stopReason = "end_of_list_no_progress";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection due to repeated scroll no-move streak",
          details: {
            scrollNoMoveStreak,
            stableIterationsTarget
          }
        });
        break;
      }
      if (options?.disableDeepScroll) {
        stopReason = merged.size > 0 ? "end_of_list_reached" : "zero_threads_found";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection because deep scroll is disabled for this run",
          details: {
            mergedCount: merged.size,
            stopReason
          }
        });
        break;
      }

      const scrollOutcome = await this.deepScrollThreadList(page, selectors, {
        bottomKey: snapshot.bottomKey,
        visibleSetHash: snapshot.visibleSetHash
      });
      scrollIterations += 1;
      this.logTraceEvent({
        stage: "collect_threads",
        action: "scroll_iteration",
        details: {
          scrollIterations,
          moved: scrollOutcome.moved,
          reachedBottom: scrollOutcome.reachedBottom,
          didScroll: scrollOutcome.didScroll
        },
        attempt: iterations,
        page
      });
      if (!scrollOutcome.moved) {
        scrollNoMoveStreak += 1;
      } else {
        scrollNoMoveStreak = 0;
      }
      if (!scrollOutcome.didScroll || scrollOutcome.reachedBottom) {
        stopReason = merged.size > 0 ? "end_of_list_reached" : "zero_threads_found";
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Stopped collection because list reached bottom",
          details: {
            mergedCount: merged.size,
            stopReason
          }
        });
        break;
      }

      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "wait_for_timeout",
        note: "post_scroll_wait",
        details: {
          delayMs: this.deps.scanScrollWaitMs
        },
        run: async () => {
          await page.waitForTimeout(this.deps.scanScrollWaitMs);
        }
      });
    }

    if (merged.size <= 0 && stopReason !== "max_threads") {
      stopReason = "zero_threads_found";
    }

    this.logTraceEvent({
      stage: "collect_threads",
      action: "collection_complete",
      details: {
        iterations,
        stopReason,
        threadsCollectedTotal: merged.size,
        noProgressStreak,
        bottomRepeatStreak,
        scrollNoMoveStreak,
        scrollIterations
      },
      page
    });

    return {
      rows: Array.from(merged.values()).slice(0, cappedMaxThreads),
      rowsBeforeCapCount: merged.size,
      iterations,
      stopReason,
      noProgressStreak,
      bottomRepeatStreak,
      scrollNoMoveStreak,
      scrollIterations
    };
  }

  getLastCollectionMetrics(): {
    totalFound: number;
    unreadFound: number;
    iterations: number;
    stopReason: LinkedInCollectionStopReason;
  } | null {
    return this.lastCollectionMetrics;
  }

  private async resolveElementByScopedPath(
    root: ElementHandle<Element>,
    scopedPath: string | undefined
  ): Promise<ElementHandle<Element> | null> {
    if (!scopedPath) {
      return null;
    }
    const handle = await root.evaluateHandle((node, path) => {
      const parts = (path ?? "")
        .trim()
        .split(">")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (!parts.length) {
        return null;
      }
      let cursor: Element | null = node as Element;
      for (const part of parts) {
        const match = part.match(/^\*:nth-child\((\d+)\)$/i);
        if (!match?.[1] || !cursor) {
          return null;
        }
        const index = Number(match[1]) - 1;
        if (!Number.isFinite(index) || index < 0) {
          return null;
        }
        cursor = cursor.children.item(index);
      }
      return cursor;
    }, scopedPath);
    return handle.asElement();
  }

  private async probeResolverNodeHandle(handle: ElementHandle<Element>): Promise<LinkedInResolverNodeProbe> {
    return handle.evaluate((node) => {
      const asElement = node as HTMLElement;
      const style = window.getComputedStyle(asElement);
      const clientHeight = Math.max(0, Math.floor(asElement.clientHeight || 0));
      const scrollHeight = Math.max(clientHeight, Math.floor(asElement.scrollHeight || 0));
      const delta = Math.max(0, scrollHeight - clientHeight);
      const className = (asElement.className ?? "").toString().replace(/\s+/g, " ").trim();
      const outerHtmlSample = (asElement.outerHTML ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return {
        tag: asElement.tagName.toLowerCase(),
        class: className,
        id: (asElement.id ?? "").trim(),
        overflowY: (style.overflowY ?? "").toLowerCase(),
        clientHeight,
        scrollHeight,
        delta,
        outerHtmlSample
      };
    });
  }

  private dedupeResolverNodeProbes(candidates: LinkedInResolverNodeProbe[]): LinkedInResolverNodeProbe[] {
    const seen = new Set<string>();
    const deduped: LinkedInResolverNodeProbe[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.tag}|${candidate.id}|${candidate.class}|${candidate.clientHeight}|${candidate.scrollHeight}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deduped.push(candidate);
    }
    return deduped
      .sort((left, right) => right.delta - left.delta || right.scrollHeight - left.scrollHeight)
      .slice(0, 20);
  }

  private async collectScopeCounts(input: {
    page: Page;
    selectors: SelectorRegistry;
    shell?: ElementHandle<Element> | null;
  }): Promise<{ global: LinkedInSelectorScopeCounts; shell: LinkedInSelectorScopeCounts | null }> {
    const globalRowSignals: Record<string, number> = {};
    for (const selector of linkedInStreamingListRootValidationSelectors) {
      globalRowSignals[selector] = await input.page.locator(selector).count().catch(() => 0);
    }
    const globalCounts: LinkedInSelectorScopeCounts = {
      threadList: await input.page.locator(input.selectors.thread_list).count().catch(() => 0),
      threadItem: await input.page.locator(input.selectors.thread_item).count().catch(() => 0),
      rowSignals: globalRowSignals
    };

    if (!input.shell) {
      return {
        global: globalCounts,
        shell: null
      };
    }

    const shellCounts = await input.shell
      .evaluate((shellNode, payload) => {
        const rowSignals: Record<string, number> = {};
        for (const selector of payload.rowSignalSelectors) {
          rowSignals[selector] = shellNode.querySelectorAll(selector).length;
        }
        let threadList = 0;
        let threadItem = 0;
        try {
          threadList = shellNode.querySelectorAll(payload.threadListSelector).length;
        } catch {
          threadList = 0;
        }
        try {
          threadItem = shellNode.querySelectorAll(payload.threadItemSelector).length;
        } catch {
          threadItem = 0;
        }
        return {
          threadList,
          threadItem,
          rowSignals
        };
      }, {
        rowSignalSelectors: linkedInStreamingListRootValidationSelectors,
        threadListSelector: input.selectors.thread_list,
        threadItemSelector: input.selectors.thread_item
      })
      .catch(() => null);

    return {
      global: globalCounts,
      shell: shellCounts
    };
  }

  private async resolveConversationListRootFromConfiguredSelector(
    page: Page,
    selectors: SelectorRegistry,
    scope?: ElementHandle<Element> | null
  ): Promise<LinkedInResolverNodeResolution | null> {
    type ConfigSelectorEvalInput = {
      threadListSelector: string;
      threadItemSelector: string;
      rowSignalSelector: string;
    };
    type ConfigSelectorEvalResult = {
      selectedIndex: number;
      selectedScore: number;
      selectedProbe: LinkedInResolverNodeProbe | null;
      totalCount: number;
      probes: LinkedInResolverNodeProbe[];
    };
    const resolution = scope
      ? await scope
          .evaluate((shellNode, input: ConfigSelectorEvalInput): ConfigSelectorEvalResult => {
            const toProbe = (node: Element): LinkedInResolverNodeProbe => {
              const asElement = node as HTMLElement;
              const style = window.getComputedStyle(asElement);
              const clientHeight = Math.max(0, Math.floor(asElement.clientHeight || 0));
              const scrollHeight = Math.max(clientHeight, Math.floor(asElement.scrollHeight || 0));
              const delta = Math.max(0, scrollHeight - clientHeight);
              return {
                tag: asElement.tagName.toLowerCase(),
                class: (asElement.className ?? "").toString().replace(/\s+/g, " ").trim(),
                id: (asElement.id ?? "").trim(),
                overflowY: (style.overflowY ?? "").toLowerCase(),
                clientHeight,
                scrollHeight,
                delta,
                outerHtmlSample: (asElement.outerHTML ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
              };
            };
            let nodes: Element[] = [];
            try {
              nodes = Array.from(shellNode.querySelectorAll(input.threadListSelector));
            } catch {
              return {
                selectedIndex: -1,
                selectedScore: 0,
                selectedProbe: null,
                totalCount: 0,
                probes: []
              };
            }
            let selectedIndex = -1;
            let selectedScore = 0;
            let selectedProbe: LinkedInResolverNodeProbe | null = null;
            const probes: LinkedInResolverNodeProbe[] = [];
            for (let index = 0; index < nodes.length; index += 1) {
              const node = nodes[index];
              if (!node) {
                continue;
              }
              const probe = toProbe(node);
              probes.push(probe);
              let threadItemCount = 0;
              try {
                threadItemCount = node.querySelectorAll(input.threadItemSelector).length;
              } catch {
                threadItemCount = 0;
              }
              const rowSignalCount = node.querySelectorAll(input.rowSignalSelector).length;
              if (threadItemCount <= 0 && rowSignalCount <= 0) {
                continue;
              }
              const score = threadItemCount * 5 + rowSignalCount * 2 + (probe.tag === "ul" ? 2 : 0);
              if (score <= selectedScore) {
                continue;
              }
              selectedScore = score;
              selectedIndex = index;
              selectedProbe = probe;
            }
            return {
              selectedIndex,
              selectedScore,
              selectedProbe,
              totalCount: nodes.length,
              probes
            };
          }, {
            threadListSelector: selectors.thread_list,
            threadItemSelector: selectors.thread_item,
            rowSignalSelector: linkedInStreamingListRootValidationSelector
          })
          .catch(() => null)
      : await page
          .evaluate((input: ConfigSelectorEvalInput): ConfigSelectorEvalResult => {
            const toProbe = (node: Element): LinkedInResolverNodeProbe => {
              const asElement = node as HTMLElement;
              const style = window.getComputedStyle(asElement);
              const clientHeight = Math.max(0, Math.floor(asElement.clientHeight || 0));
              const scrollHeight = Math.max(clientHeight, Math.floor(asElement.scrollHeight || 0));
              const delta = Math.max(0, scrollHeight - clientHeight);
              return {
                tag: asElement.tagName.toLowerCase(),
                class: (asElement.className ?? "").toString().replace(/\s+/g, " ").trim(),
                id: (asElement.id ?? "").trim(),
                overflowY: (style.overflowY ?? "").toLowerCase(),
                clientHeight,
                scrollHeight,
                delta,
                outerHtmlSample: (asElement.outerHTML ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
              };
            };
            let nodes: Element[] = [];
            try {
              nodes = Array.from(document.querySelectorAll(input.threadListSelector));
            } catch {
              return {
                selectedIndex: -1,
                selectedScore: 0,
                selectedProbe: null,
                totalCount: 0,
                probes: []
              };
            }
            let selectedIndex = -1;
            let selectedScore = 0;
            let selectedProbe: LinkedInResolverNodeProbe | null = null;
            const probes: LinkedInResolverNodeProbe[] = [];
            for (let index = 0; index < nodes.length; index += 1) {
              const node = nodes[index];
              if (!node) {
                continue;
              }
              const probe = toProbe(node);
              probes.push(probe);
              let threadItemCount = 0;
              try {
                threadItemCount = node.querySelectorAll(input.threadItemSelector).length;
              } catch {
                threadItemCount = 0;
              }
              const rowSignalCount = node.querySelectorAll(input.rowSignalSelector).length;
              if (threadItemCount <= 0 && rowSignalCount <= 0) {
                continue;
              }
              const score = threadItemCount * 5 + rowSignalCount * 2 + (probe.tag === "ul" ? 2 : 0);
              if (score <= selectedScore) {
                continue;
              }
              selectedScore = score;
              selectedIndex = index;
              selectedProbe = probe;
            }
            return {
              selectedIndex,
              selectedScore,
              selectedProbe,
              totalCount: nodes.length,
              probes
            };
          }, {
            threadListSelector: selectors.thread_list,
            threadItemSelector: selectors.thread_item,
            rowSignalSelector: linkedInStreamingListRootValidationSelector
          })
          .catch(() => null);

    if (!resolution || resolution.selectedIndex < 0) {
      return null;
    }

    const handle = scope
      ? await scope
          .evaluateHandle(
            (shellNode, input: { selector: string; index: number }) =>
              (Array.from(shellNode.querySelectorAll(input.selector))[input.index] as Element | undefined) ?? null,
            {
              selector: selectors.thread_list,
              index: resolution.selectedIndex
            }
          )
          .then((value) => value.asElement())
          .catch(() => null)
      : await page.locator(selectors.thread_list).nth(resolution.selectedIndex).elementHandle().catch(() => null);
    if (!handle) {
      return null;
    }

    return {
      handle,
      selector: selectors.thread_list,
      index: resolution.selectedIndex,
      score: resolution.selectedScore,
      mode: "selector",
      triedSelectorCounts: {
        [selectors.thread_list]: resolution.totalCount
      },
      topCandidates: this.dedupeResolverNodeProbes(
        ((resolution.probes ?? []) as LinkedInResolverNodeProbe[]).concat(
          resolution.selectedProbe ? [resolution.selectedProbe as LinkedInResolverNodeProbe] : []
        )
      )
    };
  }

  private async findLowestCommonAncestor(
    listRootHandle: ElementHandle<Element>,
    messagePaneHandle: ElementHandle<Element>
  ): Promise<ElementHandle<Element> | null> {
    const handle = await listRootHandle.evaluateHandle((listRootNode, messagePaneNode) => {
      if (!(messagePaneNode instanceof Element)) {
        return null;
      }
      const listAncestors = new Set<Element>();
      let listCursor: Element | null = listRootNode;
      while (listCursor) {
        listAncestors.add(listCursor);
        listCursor = listCursor.parentElement;
      }
      let paneCursor: Element | null = messagePaneNode;
      while (paneCursor) {
        if (listAncestors.has(paneCursor)) {
          return paneCursor;
        }
        paneCursor = paneCursor.parentElement;
      }
      return null;
    }, messagePaneHandle);
    const element = handle.asElement();
    if (!element) {
      return null;
    }
    const tag = await element.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
    if (tag === "body" || tag === "html") {
      return null;
    }
    return element;
  }

  private async tryRevealConversationListFromNarrowLayout(input: {
    page: Page;
    selectors: SelectorRegistry;
    shell?: ElementHandle<Element> | null;
  }): Promise<{
    attempted: boolean;
    revealed: boolean;
    selector?: string;
    globalRowSignals: Record<string, number>;
    shellRowSignalCount: number | null;
  }> {
    const globalRowSignals: Record<string, number> = {};
    for (const selector of linkedInStreamingListRootValidationSelectors) {
      globalRowSignals[selector] = await input.page.locator(selector).count().catch(() => 0);
    }
    const globalSignalCount = Object.values(globalRowSignals).reduce((acc, count) => acc + count, 0);
    const shellRowSignalCount = input.shell
      ? await input.shell
          .evaluate((shellNode, rowSignalSelector) => shellNode.querySelectorAll(rowSignalSelector).length, linkedInStreamingListRootValidationSelector)
          .catch(() => 0)
      : null;

    const messagePaneCount = await input.page.locator(input.selectors.message_container).count().catch(() => 0);
    const listAbsentGlobal = globalSignalCount <= 0;
    const listAbsentShell = shellRowSignalCount === null ? true : shellRowSignalCount <= 0;
    if (!(listAbsentGlobal && listAbsentShell && messagePaneCount > 0)) {
      return {
        attempted: false,
        revealed: false,
        globalRowSignals,
        shellRowSignalCount
      };
    }

    for (const selector of linkedInStreamingBackControlSelectors) {
      const locator = input.page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count <= 0) {
        continue;
      }
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await locator
          .click({
            timeout: 2_000
          })
          .catch(() => undefined);
        await input.page.waitForTimeout(220).catch(() => undefined);
        const revealedCount = await input.page.locator(linkedInStreamingListRootValidationSelector).count().catch(() => 0);
        if (revealedCount > 0) {
          return {
            attempted: true,
            revealed: true,
            selector,
            globalRowSignals,
            shellRowSignalCount
          };
        }
      }
      return {
        attempted: true,
        revealed: false,
        selector,
        globalRowSignals,
        shellRowSignalCount
      };
    }

    return {
      attempted: false,
      revealed: false,
      globalRowSignals,
      shellRowSignalCount
    };
  }

  private async describeResolverHandle(handle: ElementHandle<Element>): Promise<LinkedInResolverNodeProbe | null> {
    return this.probeResolverNodeHandle(handle).catch(() => null);
  }

  private async waitForMessagingShellReady(
    page: Page,
    timeoutMs = 4_000
  ): Promise<{ ready: boolean; signal?: string | null }> {
    type MessagingShellReadyEvalInput = {
      selectors: string[];
      rowSignalSelector: string;
      rowClickSelector: string;
    };
    const deadline = Date.now() + Math.max(500, timeoutMs);
    while (Date.now() < deadline) {
      const signal = await page
        .evaluate((input: MessagingShellReadyEvalInput) => {
          const { selectors, rowSignalSelector, rowClickSelector } = input;
          for (const selector of selectors) {
            const nodes = Array.from(document.querySelectorAll(selector));
            for (const node of nodes) {
              const hasRows =
                node.querySelector(rowSignalSelector) !== null || node.querySelector(rowClickSelector) !== null;
              if (hasRows) {
                return selector;
              }
            }
          }

          const main = document.querySelector("main[role='main'], #main, main");
          if (main && (main.textContent ?? "").toLowerCase().includes("messaging")) {
            return "main_text_messaging";
          }

          return null;
        }, {
          selectors: linkedInStreamingShellReadySelectors,
          rowSignalSelector: linkedInStreamingListRootValidationSelector,
          rowClickSelector: linkedInStreamingRowClickTargetSelector
        })
        .catch(() => null);
      if (signal) {
        return {
          ready: true,
          signal
        };
      }
      await page.waitForTimeout(140).catch(() => undefined);
    }

    return {
      ready: false
    };
  }

  private async waitForThreadListHydratedOrEmptyOrBlocked(
    page: Page,
    selectors: SelectorRegistry,
    timeoutMs = 10_000
  ): Promise<
    | {
        status: "rows_ready";
        rowSignalCounts: Record<string, number>;
      }
    | {
        status: "empty_inbox";
        rowSignalCounts: Record<string, number>;
      }
    | {
        status: "blocked_by_modal";
        rowSignalCounts: Record<string, number>;
        blocker: LinkedInStreamingBlockerSignal;
      }
    | {
        status: "list_hydration_timeout";
        rowSignalCounts: Record<string, number>;
      }
  > {
    const deadline = Date.now() + Math.max(2_000, timeoutMs);
    while (Date.now() < deadline) {
      const blocker = await this.detectStreamingBlocker(page);
      const rowSignalCounts: Record<string, number> = {};
      for (const selector of linkedInStreamingHydrationRowSignalSelectors) {
        rowSignalCounts[selector] = await page.locator(selector).count().catch(() => 0);
      }
      const hasRows = Object.values(rowSignalCounts).some((count) => count > 0);
      if (blocker) {
        return {
          status: "blocked_by_modal",
          rowSignalCounts,
          blocker
        };
      }
      if (hasRows) {
        return {
          status: "rows_ready",
          rowSignalCounts
        };
      }

      const emptyStateCount = await page.locator(linkedInStreamingEmptyStateSelector).count().catch(() => 0);
      if (emptyStateCount > 0) {
        return {
          status: "empty_inbox",
          rowSignalCounts
        };
      }

      const revealResult = await this.tryRevealConversationListFromNarrowLayout({
        page,
        selectors
      });
      if (revealResult.attempted) {
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Narrow layout reveal attempt during hydration gate",
          details: {
            revealed: revealResult.revealed,
            selector: revealResult.selector ?? null,
            globalRowSignals: revealResult.globalRowSignals,
            shellRowSignalCount: revealResult.shellRowSignalCount
          }
        });
      }
      if (revealResult.revealed) {
        continue;
      }

      await this.runTracedPageAction({
        page,
        stage: "collect_threads",
        action: "wait_for_timeout",
        note: "stream_list_hydration_poll_wait",
        details: {
          delayMs: 250
        },
        run: async () => {
          await page.waitForTimeout(250);
        }
      });
    }

    const rowSignalCounts: Record<string, number> = {};
    for (const selector of linkedInStreamingHydrationRowSignalSelectors) {
      rowSignalCounts[selector] = await page.locator(selector).count().catch(() => 0);
    }
    return {
      status: "list_hydration_timeout",
      rowSignalCounts
    };
  }

  private async getFirstVisibleMessageFingerprint(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{ key: string; textSample: string } | null> {
    const node = page.locator(selectors.message_item).first();
    const exists = (await node.count().catch(() => 0)) > 0;
    if (!exists) {
      return null;
    }
    const key =
      (await node.getAttribute("data-event-urn").catch(() => null)) ??
      (await node.getAttribute("data-id").catch(() => null)) ??
      (await node.getAttribute("id").catch(() => null)) ??
      "";
    const textSample = cleanText(await node.innerText({ timeout: 0 }).catch(() => "")).slice(0, 240);
    return {
      key: key || "",
      textSample
    };
  }

  private async waitForStreamingThreadHydration(input: {
    page: Page;
    selectors: SelectorRegistry;
    beforeFingerprint: { key: string; textSample: string } | null;
    beforeDescriptor: ActiveThreadDescriptor;
    expectedUrlToken: string | null;
    alreadyActiveCandidate: boolean;
    candidateThreadToken: string | null;
    candidateDisplayName: string;
    timeoutMs?: number;
    rowKey: string;
  }): Promise<boolean> {
    const {
      page,
      selectors,
      beforeFingerprint,
      beforeDescriptor,
      expectedUrlToken,
      alreadyActiveCandidate,
      candidateThreadToken,
      candidateDisplayName,
      rowKey
    } = input;
    const deadline = Date.now() + Math.max(1_500, input.timeoutMs ?? 6_000);
    while (Date.now() < deadline) {
      const descriptor = await this.getActiveThreadDescriptor(page, selectors);
      const activeUrlToken = this.resolveCurrentActiveThreadToken(page);
      const changedDescriptor =
        this.normalizeIdentity(beforeDescriptor.activeKey) !== this.normalizeIdentity(descriptor.activeKey) ||
        this.normalizeIdentity(beforeDescriptor.displayName) !== this.normalizeIdentity(descriptor.displayName) ||
        this.normalizeThreadUrl(beforeDescriptor.threadUrl) !== this.normalizeThreadUrl(descriptor.threadUrl);
      const urlAligned =
        Boolean(activeUrlToken) &&
        (!expectedUrlToken || activeUrlToken === expectedUrlToken) &&
        this.normalizeIdentity(activeUrlToken ?? undefined) !== this.normalizeIdentity(this.resolveThreadUrlToken(beforeDescriptor.threadUrl));
      const activated = changedDescriptor || urlAligned;
      const tokenAligned =
        Boolean(candidateThreadToken) && Boolean(activeUrlToken) && candidateThreadToken === activeUrlToken;
      const tokenConflicts =
        Boolean(candidateThreadToken) && Boolean(activeUrlToken) && candidateThreadToken !== activeUrlToken;
      const nameAligned =
        this.normalizeIdentity(candidateDisplayName) &&
        this.normalizeIdentity(descriptor.displayName) &&
        (this.normalizeIdentity(descriptor.displayName).includes(this.normalizeIdentity(candidateDisplayName)) ||
          this.normalizeIdentity(candidateDisplayName).includes(this.normalizeIdentity(descriptor.displayName)));
      const correctThread =
        tokenAligned || (!activeUrlToken && Boolean(nameAligned)) || (!candidateThreadToken && Boolean(nameAligned));

      const containerVisible = await page
        .locator(selectors.message_container)
        .first()
        .isVisible({ timeout: 0 })
        .catch(() => false);
      if (!containerVisible) {
        await page.waitForTimeout(120).catch(() => undefined);
        continue;
      }

      const spinnerCount = await page
        .locator(selectors.message_container)
        .first()
        .locator(linkedInLoadingSpinnerSelector)
        .count()
        .catch(() => 0);
      const messageCount = await page.locator(selectors.message_item).count().catch(() => 0);
      const currentFingerprint = await this.getFirstVisibleMessageFingerprint(page, selectors);
      const fingerprintChanged =
        (beforeFingerprint?.key || "") !== (currentFingerprint?.key || "") ||
        (beforeFingerprint?.textSample || "") !== (currentFingerprint?.textSample || "");
      const emptyStateCount = await page
        .locator(
          `${selectors.message_container} [data-test-empty-state], ${selectors.message_container} .msg-s-message-list__empty-state, ${selectors.message_container} .msg-thread-empty-state`
        )
        .count()
        .catch(() => 0);

      const messageHydrated = spinnerCount <= 0 && messageCount > 0 && (fingerprintChanged || !beforeFingerprint);
      const emptyHydrated = spinnerCount <= 0 && emptyStateCount > 0;
      const hydrated = messageHydrated || emptyHydrated;

      if (alreadyActiveCandidate && correctThread && spinnerCount <= 0 && (messageCount > 0 || emptyStateCount > 0)) {
        return true;
      }

      // Some LinkedIn and fixture layouts do not immediately expose URL/active-row changes.
      // Accept message-driven hydration when data actually changed, while keeping descriptor/url alignment preferred.
      if (hydrated && (activated || fingerprintChanged || !beforeFingerprint) && !tokenConflicts) {
        return true;
      }

      await this.runTracedPageAction({
        page,
        stage: "open_thread",
        action: "wait_for_timeout",
        note: "stream_message_hydration_wait",
        details: {
          rowKey,
          alreadyActiveCandidate,
          tokenAligned,
          tokenConflicts,
          nameAligned: Boolean(nameAligned),
          correctThread,
          activated,
          spinnerCount,
          messageCount,
          emptyStateCount,
          fingerprintChanged
        },
        run: async () => {
          await page.waitForTimeout(180);
        }
      });
    }

    return false;
  }

  private async resolveMessagingShell(page: Page): Promise<LinkedInResolverNodeResolution | null> {
    type MessagingShellEvalInput = {
      selectorCandidates: string[];
      rowClickSelector: string;
      rowSignalSelector: string;
      filterPillSelector: string;
    };
    type MessagingShellEvalResult = {
      triedSelectorCounts: Record<string, number>;
      selected: { selector: string; index: number; score: number } | null;
      topCandidates: LinkedInResolverNodeProbe[];
    };
    const resolution = await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "resolve_messaging_shell",
      details: {
        selectors: linkedInStreamingShellSelectors
      },
      run: async () =>
        page.evaluate((input: MessagingShellEvalInput): MessagingShellEvalResult => {
          const { selectorCandidates, rowClickSelector, rowSignalSelector, filterPillSelector } = input;
          const triedSelectorCounts: Record<string, number> = {};
          const probes: Array<{
            selector: string;
            index: number;
            score: number;
            rowLinkCount: number;
            tag: string;
            class: string;
            id: string;
            overflowY: string;
            clientHeight: number;
            scrollHeight: number;
            delta: number;
            outerHtmlSample: string;
          }> = [];
          const seen = new Set<Element>();
          const allCandidates: Array<{ selector: string; node: Element }> = [];
          for (const selector of selectorCandidates) {
            const nodes = Array.from(document.querySelectorAll(selector));
            triedSelectorCounts[selector] = nodes.length;
            for (const node of nodes) {
              if (seen.has(node)) {
                continue;
              }
              seen.add(node);
              allCandidates.push({
                selector,
                node
              });
            }
          }
          for (const candidate of allCandidates) {
            const node = candidate.node as HTMLElement;
            const style = window.getComputedStyle(node);
            const clientHeight = Math.max(0, Math.floor(node.clientHeight || 0));
            const scrollHeight = Math.max(clientHeight, Math.floor(node.scrollHeight || 0));
            const delta = Math.max(0, scrollHeight - clientHeight);
            const rowLinkCount = node.querySelectorAll(rowClickSelector).length;
            const rowSignalCount = node.querySelectorAll(rowSignalSelector).length;
            const filterPillCount = node.querySelectorAll(filterPillSelector).length;
            const listRoleCount = node.querySelectorAll("[role='list'], [role='listbox']").length;
            const messagePaneCount = node.querySelectorAll(".msg-s-message-list, [class*='msg-s-message']").length;
            const score =
              (filterPillCount > 0 ? 4 : 0) +
              (rowLinkCount > 0 ? 4 : 0) +
              (rowSignalCount > 0 ? 4 : 0) +
              (listRoleCount > 0 ? 2 : 0) +
              (messagePaneCount > 0 ? 1 : 0) +
              Math.min(3, Math.max(rowLinkCount, rowSignalCount));
            probes.push({
              selector: candidate.selector,
              index: Array.from(document.querySelectorAll(candidate.selector)).indexOf(candidate.node),
              score,
              rowLinkCount,
              tag: node.tagName.toLowerCase(),
              class: (node.className ?? "").toString().replace(/\s+/g, " ").trim(),
              id: (node.id ?? "").trim(),
              overflowY: (style.overflowY ?? "").toLowerCase(),
              clientHeight,
              scrollHeight,
              delta,
              outerHtmlSample: (node.outerHTML ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
            });
          }

          probes.sort(
            (left, right) =>
              right.score - left.score ||
              right.rowLinkCount - left.rowLinkCount ||
              right.delta - left.delta ||
              right.scrollHeight - left.scrollHeight
          );
          const selected = probes.find((probe) => probe.score > 0 && probe.index >= 0) ?? null;
          return {
            triedSelectorCounts,
            selected: selected
              ? {
                  selector: selected.selector,
                  index: selected.index,
                  score: selected.score
                }
              : null,
            topCandidates: probes.slice(0, 12).map((probe) => ({
              tag: probe.tag,
              class: probe.class,
              id: probe.id,
              overflowY: probe.overflowY,
              clientHeight: probe.clientHeight,
              scrollHeight: probe.scrollHeight,
              delta: probe.delta,
              outerHtmlSample: probe.outerHtmlSample
            }))
          };
        }, {
          selectorCandidates: linkedInStreamingShellSelectors,
          rowClickSelector: linkedInStreamingRowClickTargetSelector,
          rowSignalSelector: linkedInStreamingListRootValidationSelector,
          filterPillSelector: linkedInSmokeFilterPillSelector
        })
    }).catch(() => null);

    if (!resolution?.selected?.selector || !Number.isFinite(resolution.selected.index)) {
      return null;
    }

    const locator = page.locator(resolution.selected.selector).nth(resolution.selected.index);
    const handle = await locator.elementHandle().catch(() => null);
    if (!handle) {
      return null;
    }

    return {
      handle,
      selector: resolution.selected.selector,
      index: resolution.selected.index,
      score: resolution.selected.score ?? 0,
      mode: "selector",
      triedSelectorCounts: resolution.triedSelectorCounts ?? {},
      topCandidates: this.dedupeResolverNodeProbes((resolution.topCandidates ?? []) as LinkedInResolverNodeProbe[])
    };
  }

  private async resolveConversationListRoot(
    page: Page,
    shell: ElementHandle<Element>
  ): Promise<LinkedInResolverNodeResolution | null> {
    type ListRootEvalInput = {
      selectorCandidates: string[];
      rowClickSelector: string;
      rowSignalSelector: string;
    };
    type ListRootEvalResult = {
      selected: { mode: "selector" | "fallback"; selector: string; index: number; score: number } | null;
      triedSelectorCounts: Record<string, number>;
      topCandidates: LinkedInResolverNodeProbe[];
    };
    const resolution = await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "resolve_list_root",
      details: {
        selectors: linkedInStreamingListRootSelectors
      },
      run: async () =>
        shell.evaluate((shellNode: Element, input: ListRootEvalInput): ListRootEvalResult => {
          const { selectorCandidates, rowClickSelector, rowSignalSelector } = input;
          const toProbe = (node: Element) => {
            const asElement = node as HTMLElement;
            const style = window.getComputedStyle(asElement);
            const clientHeight = Math.max(0, Math.floor(asElement.clientHeight || 0));
            const scrollHeight = Math.max(clientHeight, Math.floor(asElement.scrollHeight || 0));
            const delta = Math.max(0, scrollHeight - clientHeight);
            return {
              tag: asElement.tagName.toLowerCase(),
              class: (asElement.className ?? "").toString().replace(/\s+/g, " ").trim(),
              id: (asElement.id ?? "").trim(),
              overflowY: (style.overflowY ?? "").toLowerCase(),
              clientHeight,
              scrollHeight,
              delta,
              outerHtmlSample: (asElement.outerHTML ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
            };
          };
          const triedSelectorCounts: Record<string, number> = {};
          const probes: Array<{
            selector: string;
            index: number;
            score: number;
            rowSignalCount: number;
            probe: ReturnType<typeof toProbe>;
          }> = [];

          for (const selector of selectorCandidates) {
            const nodes = Array.from(shellNode.querySelectorAll(selector));
            triedSelectorCounts[selector] = nodes.length;
            for (let index = 0; index < nodes.length; index += 1) {
              const node = nodes[index];
              if (!node) {
                continue;
              }
              const rowSignalCount = node.querySelectorAll(rowSignalSelector).length;
              if (rowSignalCount <= 0) {
                continue;
              }
              const rowClickCount = node.querySelectorAll(rowClickSelector).length;
              const role = (node.getAttribute("role") ?? "").toLowerCase();
              const tag = node.tagName.toLowerCase();
              const score =
                (selector.includes("conversations-list") ? 5 : 0) +
                (tag === "ul" ? 2 : 0) +
                (role === "list" || role === "listbox" ? 2 : 0) +
                (rowClickCount > 0 ? 2 : 0) +
                Math.min(5, rowSignalCount);
              probes.push({
                selector,
                index,
                score,
                rowSignalCount,
                probe: toProbe(node)
              });
            }
          }

          probes.sort(
            (left, right) =>
              right.score - left.score ||
              right.rowSignalCount - left.rowSignalCount ||
              right.probe.delta - left.probe.delta
          );
          if (probes.length > 0) {
            const selected = probes[0];
            if (!selected) {
              return {
                selected: null,
                triedSelectorCounts,
                topCandidates: []
              };
            }
            return {
              selected: {
                mode: "selector",
                selector: selected.selector,
                index: selected.index,
                score: selected.score
              },
              triedSelectorCounts,
              topCandidates: probes.slice(0, 12).map((entry) => entry.probe)
            };
          }

          const fallbackSignal = shellNode.querySelector(rowSignalSelector) ?? shellNode.querySelector(rowClickSelector);
          if (!fallbackSignal) {
            return {
              selected: null,
              triedSelectorCounts,
              topCandidates: []
            };
          }

          const fallbackRoot =
            fallbackSignal.closest(
              "ul.msg-conversations-container__conversations-list, [class*='msg-conversations-container__conversations-list'], .msg-conversations-container, [data-test*='conversations'], [role='list'], [role='listbox']"
            ) ??
            fallbackSignal.parentElement ??
            shellNode;
          return {
            selected: {
              mode: "fallback",
              selector: "__fallback__",
              index: 0,
              score: 1
            },
            triedSelectorCounts,
            topCandidates: [toProbe(fallbackRoot)]
          };
        }, {
          selectorCandidates: linkedInStreamingListRootSelectors,
          rowClickSelector: linkedInStreamingRowClickTargetSelector,
          rowSignalSelector: linkedInStreamingListRootValidationSelector
        })
    }).catch(() => null);

    if (!resolution?.selected) {
      return null;
    }

    let handle: ElementHandle<Element> | null = null;
    if (resolution.selected.mode === "fallback") {
      const fallbackHandle = await shell.evaluateHandle(
        (
          shellNode,
          input: {
            rowSignalSelector: string;
            rowClickSelector: string;
          }
        ) => {
          const fallbackSignal =
            shellNode.querySelector(input.rowSignalSelector) ?? shellNode.querySelector(input.rowClickSelector);
          if (!fallbackSignal) {
            return null;
          }
          return (
            fallbackSignal.closest(
              "ul.msg-conversations-container__conversations-list, [class*='msg-conversations-container__conversations-list'], .msg-conversations-container, [data-test*='conversations'], [role='list'], [role='listbox']"
            ) ??
            fallbackSignal.parentElement ??
            null
          );
        },
        {
          rowSignalSelector: linkedInStreamingListRootValidationSelector,
          rowClickSelector: linkedInStreamingRowClickTargetSelector
        }
      );
      handle = fallbackHandle.asElement();
    } else {
      const scopedHandle = await shell.evaluateHandle((shellNode, selected) => {
        const nodes = Array.from(shellNode.querySelectorAll(selected.selector));
        return (nodes[selected.index] as Element | undefined) ?? null;
      }, resolution.selected);
      handle = scopedHandle.asElement();
    }

    if (!handle) {
      return null;
    }

    return {
      handle,
      selector: resolution.selected.selector,
      index: resolution.selected.index,
      score: resolution.selected.score ?? 0,
      mode: resolution.selected.mode === "fallback" ? "fallback" : "selector",
      triedSelectorCounts: resolution.triedSelectorCounts ?? {},
      topCandidates: this.dedupeResolverNodeProbes((resolution.topCandidates ?? []) as LinkedInResolverNodeProbe[])
    };
  }

  private async resolveScrollContainer(
    listRoot: ElementHandle<Element>,
    shell: ElementHandle<Element>
  ): Promise<LinkedInScrollContainerResolution | null> {
    type ScrollHeuristicInput = {
      rowClickSelector: string;
      rowSignalSelector: string;
      wrapperHints: string[];
    };
    type ScrollHeuristicResult = {
      selectedPath: string | null;
      topCandidates: LinkedInResolverNodeProbe[];
    };
    const ancestorHandles: Array<ElementHandle<Element>> = [];
    let cursor: ElementHandle<Element> | null = listRoot;
    for (let depth = 0; depth < 16 && cursor; depth += 1) {
      ancestorHandles.push(cursor);
      cursor = (await cursor.evaluateHandle((node: Element) => node.parentElement as Element | null)).asElement();
    }

    const ancestorProbes: Array<{ handle: ElementHandle<Element>; probe: LinkedInResolverNodeProbe }> = [];
    for (const handle of ancestorHandles) {
      const probe = await this.probeResolverNodeHandle(handle).catch(() => null);
      if (!probe) {
        continue;
      }
      ancestorProbes.push({
        handle,
        probe
      });
    }

    const withStandardOverflow = ancestorProbes.find(
      (entry) => entry.probe.delta > 8 && /(auto|scroll)/i.test(entry.probe.overflowY)
    );
    if (withStandardOverflow) {
      return {
        handle: withStandardOverflow.handle,
        mode: "ancestor_scrollable",
        topCandidates: this.dedupeResolverNodeProbes(ancestorProbes.map((entry) => entry.probe))
      };
    }

    const wrapperAncestor = ancestorProbes.find((entry) => {
      const className = entry.probe.class.toLowerCase();
      return linkedInStreamingWrapperClassHints.some((hint) => className.includes(hint)) && entry.probe.delta > 8;
    });
    if (wrapperAncestor) {
      return {
        handle: wrapperAncestor.handle,
        mode: "wrapper_ancestor",
        topCandidates: this.dedupeResolverNodeProbes(ancestorProbes.map((entry) => entry.probe))
      };
    }

    const shellHeuristic = await shell
      .evaluate((shellNode: Element, input: ScrollHeuristicInput): ScrollHeuristicResult => {
        const { rowClickSelector, rowSignalSelector, wrapperHints } = input;
        const toProbe = (node: Element) => {
          const asElement = node as HTMLElement;
          const style = window.getComputedStyle(asElement);
          const clientHeight = Math.max(0, Math.floor(asElement.clientHeight || 0));
          const scrollHeight = Math.max(clientHeight, Math.floor(asElement.scrollHeight || 0));
          const delta = Math.max(0, scrollHeight - clientHeight);
          return {
            tag: asElement.tagName.toLowerCase(),
            class: (asElement.className ?? "").toString().replace(/\s+/g, " ").trim(),
            id: (asElement.id ?? "").trim(),
            overflowY: (style.overflowY ?? "").toLowerCase(),
            clientHeight,
            scrollHeight,
            delta,
            outerHtmlSample: (asElement.outerHTML ?? "").replace(/\s+/g, " ").trim().slice(0, 200)
          };
        };
        const toPath = (node: Element, scopeRoot: Element): string | null => {
          const parts: string[] = [];
          let cursor: Element | null = node;
          while (cursor && cursor !== scopeRoot) {
            const parent = cursor.parentElement as Element | null;
            if (!parent) {
              return null;
            }
            const index = Array.from(parent.children).indexOf(cursor);
            if (index < 0) {
              return null;
            }
            parts.push(`*:nth-child(${index + 1})`);
            cursor = parent;
          }
          if (cursor !== scopeRoot) {
            return null;
          }
          return parts.reverse().join(" > ");
        };
        const candidates = [shellNode, ...Array.from(shellNode.querySelectorAll("*"))];
        const ranked: Array<{ path: string; score: number; probe: ReturnType<typeof toProbe> }> = [];
        for (const node of candidates) {
          const probe = toProbe(node);
          const className = probe.class.toLowerCase();
          const wrapperMatch = wrapperHints.some((hint) => className.includes(hint));
          const hasRows =
            node.querySelector(rowSignalSelector) !== null || node.querySelector(rowClickSelector) !== null;
          const overflowMatch = /(auto|scroll)/i.test(probe.overflowY);
          if (probe.delta <= 8) {
            continue;
          }
          if (!(overflowMatch || wrapperMatch)) {
            continue;
          }
          if (!hasRows) {
            continue;
          }
          const path = toPath(node, shellNode);
          if (!path) {
            continue;
          }
          const score = probe.delta + (overflowMatch ? 50 : 0) + (wrapperMatch ? 10 : 0);
          ranked.push({
            path,
            score,
            probe
          });
        }
        ranked.sort((left, right) => right.score - left.score);
        return {
          selectedPath: ranked[0]?.path ?? null,
          topCandidates: ranked.slice(0, 12).map((entry) => entry.probe)
        };
      }, {
        rowClickSelector: linkedInStreamingRowClickTargetSelector,
        rowSignalSelector: linkedInStreamingListRootValidationSelector,
        wrapperHints: linkedInStreamingWrapperClassHints
      })
      .catch(() => null);

    if (shellHeuristic?.selectedPath) {
      const heuristicHandle = await this.resolveElementByScopedPath(shell, shellHeuristic.selectedPath);
      if (heuristicHandle) {
        return {
          handle: heuristicHandle,
          mode: "shell_heuristic",
          topCandidates: this.dedupeResolverNodeProbes(
            ancestorProbes.map((entry) => entry.probe).concat(shellHeuristic.topCandidates as LinkedInResolverNodeProbe[])
          )
        };
      }
    }

    const permissiveFallback = ancestorProbes.find((entry) => entry.probe.delta > 8);
    if (permissiveFallback) {
      return {
        handle: permissiveFallback.handle,
        mode: "nonstandard_overflow_fallback",
        topCandidates: this.dedupeResolverNodeProbes(ancestorProbes.map((entry) => entry.probe))
      };
    }

    return null;
  }

  private async detectStreamingBlocker(page: Page): Promise<LinkedInStreamingBlockerSignal | null> {
    const selectorCandidates = [
      ...linkedInSmokeBlockedModalSelectors,
      ".artdeco-modal",
      ".artdeco-modal-overlay",
      "[role='dialog']",
      "[aria-modal='true']",
      ".msg-overlay-list-bubble--is-open"
    ];
    for (const selector of selectorCandidates) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(5, count); index += 1) {
        const node = locator.nth(index);
        const visible = await node.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }
        const box = await node.boundingBox().catch(() => null);
        if (!box || box.width < 180 || box.height < 120) {
          continue;
        }
        const modalTextSnippet = cleanText(await node.innerText({ timeout: 0 }).catch(() => "")).slice(0, 200);
        return {
          reason: "blocked_by_modal",
          signal: selector,
          modalTextSnippet: modalTextSnippet || undefined
        };
      }
    }

    const bodyText = cleanText(await page.locator("body").innerText().catch(() => "")).toLowerCase();
    const interstitialPatterns = [
      "verify your identity",
      "checkpoint",
      "upgrade to premium",
      "start free trial",
      "continue to linkedin premium",
      "confirm your account"
    ];
    const match = interstitialPatterns.find((pattern) => bodyText.includes(pattern));
    if (!match) {
      return null;
    }

    const dismissCount = await page
      .locator("button:has-text('Dismiss'), button:has-text('Close'), button:has-text('Not now'), [aria-label='Dismiss']")
      .count()
      .catch(() => 0);
    if (dismissCount <= 0) {
      return null;
    }
    return {
      reason: "blocked_by_modal",
      signal: "interstitial_text_match",
      modalTextSnippet: bodyText.slice(0, 200)
    };
  }

  private async captureVisibleRowsForStreaming(
    page: Page,
    listRoot: ElementHandle<Element>
  ): Promise<LinkedInVisibleRowSnapshot[]> {
    const rawRows = await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "visible_rows_snapshot",
      run: async () => this.snapshotStreamingRows(listRoot)
    }).catch(() => [] as LinkedInStreamingRowRawSnapshot[]);

    return this.mapStreamingRawRowsToSnapshots(rawRows, page.url());
  }

  private async snapshotStreamingRows(listRoot: ElementHandle<Element>): Promise<LinkedInStreamingRowRawSnapshot[]> {
    type StreamingSnapshotEvalInput = {
      rowRootSelector: string;
      rowClickSelector: string;
    };
    return listRoot.evaluate((root: Element, input: StreamingSnapshotEvalInput) => {
      const { rowRootSelector, rowClickSelector } = input;
      const clean = (value: string | null | undefined): string =>
        (value ?? "")
          .replace(/\s+/g, " ")
          .trim();
      const toPath = (node: Element, scopeRoot: Element): string | null => {
        const parts: string[] = [];
        let cursor: Element | null = node;
        while (cursor && cursor !== scopeRoot) {
          const parent = cursor.parentElement as Element | null;
          if (!parent) {
            return null;
          }
          const index = Array.from(parent.children).indexOf(cursor);
          if (index < 0) {
            return null;
          }
          parts.push(`*:nth-child(${index + 1})`);
          cursor = parent;
        }
        if (cursor !== scopeRoot) {
          return null;
        }
        return parts.reverse().join(" > ");
      };
      const rootRect = (root as HTMLElement).getBoundingClientRect();
      const rowNodesFromListItems = Array.from(root.querySelectorAll("li.msg-conversation-listitem"));
      const rowNodes = rowNodesFromListItems.length > 0 ? rowNodesFromListItems : Array.from(root.querySelectorAll(rowRootSelector));
      const resolvedRows =
        rowNodes.length > 0
          ? rowNodes
          : Array.from(root.querySelectorAll(rowClickSelector))
              .map((entry) =>
                entry.closest(
                  "li.msg-conversation-listitem, div.msg-conversation-listitem, [data-control-name*='conversation_item'], [role='option'], [role='listitem']"
                ) ?? entry
              )
              .filter((entry, index, all) => all.indexOf(entry) === index);

      return resolvedRows
        .map((row) => {
          const rect = (row as HTMLElement).getBoundingClientRect();
          const visible = rect.height > 1 && rect.bottom > rootRect.top && rect.top < rootRect.bottom;
          if (!visible) {
            return null;
          }
          const locatorPath = toPath(row, root);
          if (!locatorPath) {
            return null;
          }
          const readText = (selector: string): string => clean(row.querySelector(selector)?.textContent ?? "");
          const readAttr = (name: string): string => clean((row as HTMLElement).getAttribute(name));
          const linkNode = (row.querySelector(
            "a.msg-conversation-card__conversation-link, div.msg-conversation-listitem__link a[href*='/messaging/'], a[href*='/messaging/thread/'], a[href*='/messaging/']"
          ) ?? row.querySelector("a[href*='/messaging/']")) as HTMLAnchorElement | null;

          return {
            locatorPath,
            id: readAttr("id"),
            conversationUrn: readAttr("data-conversation-urn"),
            urn: readAttr("data-urn"),
            conversationId: readAttr("data-conversation-id"),
            dataId: readAttr("data-id"),
            controlId: readAttr("data-control-id"),
            displayName:
              readText(".msg-conversation-listitem__participant-names span.truncate") ||
              readText(".msg-conversation-listitem__participant-names") ||
              readText("h3 span.truncate") ||
              readText("h3"),
            previewSnippet:
              readText(".msg-conversation-card__message-snippet") || readText("p.msg-conversation-card__message-snippet"),
            listTimestamp: readText("time.msg-conversation-listitem__time-stamp") || readText("time"),
            unreadText:
              readText(".msg-conversation-card__unread-count .notification-badge__count") ||
              readText(".msg-conversation-card__unread-count"),
            unreadContainerPresent: row.querySelector(".msg-conversation-card__unread-count") !== null,
            pillText: readText(".msg-conversation-card__pill"),
            href: clean(linkNode?.getAttribute("href")),
            activeKey:
              readAttr("data-conversation-urn") ||
              readAttr("data-urn") ||
              readAttr("data-conversation-id") ||
              readAttr("data-id") ||
              readAttr("id")
          };
        })
        .filter((entry) => Boolean(entry)) as LinkedInStreamingRowRawSnapshot[];
    }, {
      rowRootSelector: linkedInStreamingRowRootSelector,
      rowClickSelector: linkedInStreamingRowClickTargetSelector
    });
  }

  private mapStreamingRawRowsToSnapshots(
    rawRows: LinkedInStreamingRowRawSnapshot[],
    pageUrl: string
  ): LinkedInVisibleRowSnapshot[] {
    const snapshots: LinkedInVisibleRowSnapshot[] = [];
    for (const row of rawRows) {
      const unreadMatch = row.unreadText.match(/\d+/);
      const unreadCount = unreadMatch ? Number(unreadMatch[0]) : row.unreadContainerPresent ? 1 : 0;
      const threadUrl = resolveSmokeThreadUrl(row.href ?? "", pageUrl);
      const rowKey = resolveLinkedInRowKey({
        id: row.id,
        conversationUrn: row.conversationUrn,
        urn: row.urn,
        conversationId: row.conversationId,
        dataId: row.dataId,
        controlId: row.controlId,
        displayName: row.displayName,
        previewSnippet: row.previewSnippet,
        listTimestamp: row.listTimestamp
      });
      snapshots.push({
        rowKey,
        displayName: cleanText(row.displayName),
        previewSnippet: cleanText(row.previewSnippet),
        listTimestamp: cleanText(row.listTimestamp),
        unreadCount,
        sponsored: isSponsoredPillText(row.pillText),
        needsReplyFromList: needsReplyFromPreview(row.previewSnippet),
        locatorPath: row.locatorPath,
        href: row.href || undefined,
        activeKey: row.activeKey || undefined,
        threadUrl
      });
    }
    return snapshots.filter((row) => Boolean(row.displayName));
  }

  private async findStreamingRowByKey(
    listRoot: ElementHandle<Element>,
    rowKey: string
  ): Promise<{ locatorPath: string } | null> {
    const rawRows = await this.snapshotStreamingRows(listRoot).catch(() => []);
    for (const row of rawRows) {
      const candidateRowKey = resolveLinkedInRowKey({
        id: row.id,
        conversationUrn: row.conversationUrn,
        urn: row.urn,
        conversationId: row.conversationId,
        dataId: row.dataId,
        controlId: row.controlId,
        displayName: row.displayName,
        previewSnippet: row.previewSnippet,
        listTimestamp: row.listTimestamp
      });
      if (candidateRowKey !== rowKey) {
        continue;
      }
      return {
        locatorPath: row.locatorPath
      };
    }
    return null;
  }

  private async triggerStreamingPointerFallback(target: ElementHandle<Element>): Promise<boolean> {
    return target
      .evaluate((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const dispatchMouse = (type: string, buttons: number) =>
          node.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              buttons
            })
          );
        if (typeof PointerEvent !== "undefined") {
          node.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              buttons: 1,
              pointerType: "mouse",
              isPrimary: true
            })
          );
        }
        dispatchMouse("mousedown", 1);
        if (typeof PointerEvent !== "undefined") {
          node.dispatchEvent(
            new PointerEvent("pointerup", {
              bubbles: true,
              cancelable: true,
              composed: true,
              button: 0,
              buttons: 0,
              pointerType: "mouse",
              isPrimary: true
            })
          );
        }
        dispatchMouse("mouseup", 0);
        dispatchMouse("click", 0);
        return true;
      })
      .catch(() => false);
  }

  private async triggerStreamingEnterFallback(target: ElementHandle<Element>): Promise<boolean> {
    return target
      .evaluate((node) => {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const isFocusable =
          node.tabIndex >= 0 ||
          node.hasAttribute("tabindex") ||
          /^(a|button|input|textarea|select)$/i.test(node.tagName);
        if (!isFocusable) {
          return false;
        }
        node.focus();
        const events = ["keydown", "keypress", "keyup"] as const;
        for (const eventName of events) {
          node.dispatchEvent(
            new KeyboardEvent(eventName, {
              bubbles: true,
              cancelable: true,
              composed: true,
              key: "Enter",
              code: "Enter"
            })
          );
        }
        return true;
      })
      .catch(() => false);
  }

  private async tryClickStreamingTarget(target: ElementHandle<Element>): Promise<boolean> {
    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    try {
      await target.click({
        timeout: 1_500,
        trial: true
      });
      await target.click({
        timeout: 2_500,
        force: true
      });
      return true;
    } catch {
      // fall through to pointer/keyboard fallback
    }

    const pointerDispatched = await this.triggerStreamingPointerFallback(target);
    if (pointerDispatched) {
      return true;
    }

    return this.triggerStreamingEnterFallback(target);
  }

  private async openVisibleRowForStreaming(
    page: Page,
    selectors: SelectorRegistry,
    listRoot: ElementHandle<Element>,
    row: LinkedInVisibleRowSnapshot
  ): Promise<{ ok: true; descriptor: ActiveThreadDescriptor } | { ok: false; reason: LinkedInStreamFailureReason }> {
    const before = await this.getActiveThreadDescriptor(page, selectors);
    const beforeMessageFingerprint = await this.getFirstVisibleMessageFingerprint(page, selectors);
    const expectedRowUrlToken = this.extractThreadTokenFromUrlLike(row.threadUrl ?? row.href);
    let missingAttempts = 0;
    let clickAttempts = 0;
    let clickFailures = 0;
    let waitedForContainer = false;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pathCandidate =
        attempt === 0 && row.locatorPath
          ? {
              locatorPath: row.locatorPath
            }
          : await this.findStreamingRowByKey(listRoot, row.rowKey);
      if (!pathCandidate?.locatorPath) {
        missingAttempts += 1;
        await this.runTracedPageAction({
          page,
          stage: "open_thread",
          action: "wait_for_timeout",
          note: "row_not_mounted_wait",
          details: {
            rowKey: row.rowKey,
            attempt: attempt + 1
          },
          run: async () => {
            await page.waitForTimeout(160);
          }
        });
        continue;
      }

      const rowHandle = await this.resolveElementByScopedPath(listRoot, pathCandidate.locatorPath);
      if (!rowHandle) {
        missingAttempts += 1;
        await page.waitForTimeout(140).catch(() => undefined);
        continue;
      }

      const candidateThreadToken = await this.extractCandidateRowToken(rowHandle, row);
      const currentThreadToken = this.resolveCurrentActiveThreadToken(page);
      const activeMarker = await this.isRowMarkedActive(rowHandle);
      const tokenMatch =
        Boolean(currentThreadToken) && Boolean(candidateThreadToken) && currentThreadToken === candidateThreadToken;
      const allowActiveMarkerFallback = !currentThreadToken && !candidateThreadToken;
      const alreadyActiveCandidate =
        tokenMatch ||
        (allowActiveMarkerFallback
          ? activeMarker
          : false);

      if (alreadyActiveCandidate) {
        const alreadyActiveHydrated = await this.waitForStreamingThreadHydration({
          page,
          selectors,
          beforeFingerprint: beforeMessageFingerprint,
          beforeDescriptor: before,
          expectedUrlToken: expectedRowUrlToken,
          alreadyActiveCandidate: true,
          candidateThreadToken,
          candidateDisplayName: row.displayName,
          timeoutMs: 1_500,
          rowKey: row.rowKey
        });
        if (alreadyActiveHydrated) {
          this.logTraceDecision({
            stage: "open_thread",
            decision: "Streaming row already active and hydrated; skipping click",
            details: {
              rowKey: row.rowKey,
              displayName: row.displayName,
              tokenMatch,
              allowActiveMarkerFallback,
              activeMarker,
              candidateThreadToken,
              currentThreadToken
            }
          });
          return {
            ok: true,
            descriptor: await this.getActiveThreadDescriptor(page, selectors)
          };
        }
      }

      const clickTargets: Array<ElementHandle<Element>> = [];
      const pushClickTarget = (target: ElementHandle<Element> | null | undefined): void => {
        if (!target) {
          return;
        }
        if (clickTargets.includes(target)) {
          return;
        }
        clickTargets.push(target);
      };
      pushClickTarget(await rowHandle.$("div.msg-conversation-listitem__link"));
      pushClickTarget(await rowHandle.$("a.msg-conversation-card__conversation-link"));
      pushClickTarget(await rowHandle.$("[data-control-name*='conversation_item']"));
      const rowListItemHandle = await rowHandle
        .evaluateHandle((node) =>
          node.matches("li.msg-conversation-listitem")
            ? node
            : node.closest("li.msg-conversation-listitem")
        )
        .then((handle) => handle.asElement())
        .catch(() => null);
      pushClickTarget(rowListItemHandle ?? rowHandle);

      clickAttempts += 1;
      const clicked = await this.runTracedPageAction({
        page,
        stage: "open_thread",
        action: "click",
        selector: linkedInStreamingRowClickTargetSelector,
        note: "stream_open_visible_row",
        details: {
          rowKey: row.rowKey,
          displayName: row.displayName,
          attempt: attempt + 1,
          clickTargetCount: clickTargets.length
        },
        run: async (): Promise<boolean> => {
          for (const clickTarget of clickTargets) {
            const clickedTarget = await this.tryClickStreamingTarget(clickTarget);
            if (clickedTarget) {
              return true;
            }
          }
          return false;
        }
      }).catch(() => false);
      if (!clicked) {
        clickFailures += 1;
        await this.runTracedPageAction({
          page,
          stage: "open_thread",
          action: "wait_for_timeout",
          note: "row_click_failed_wait",
          details: {
            rowKey: row.rowKey,
            attempt: attempt + 1
          },
          run: async () => {
            await page.waitForTimeout(140);
          }
        });
        continue;
      }

      waitedForContainer = true;
      const containerReady = await page
        .waitForSelector(selectors.message_container, {
          state: "visible",
          timeout: 8_000
        })
        .then(() => true)
        .catch(() => false);
      if (!containerReady) {
        continue;
      }

      const hydrated = await this.waitForStreamingThreadHydration({
        page,
        selectors,
        beforeFingerprint: beforeMessageFingerprint,
        beforeDescriptor: before,
        expectedUrlToken: expectedRowUrlToken,
        alreadyActiveCandidate: false,
        candidateThreadToken,
        candidateDisplayName: row.displayName,
        timeoutMs: 3_000,
        rowKey: row.rowKey
      });
      if (!hydrated) {
        await this.runTracedPageAction({
          page,
          stage: "open_thread",
          action: "wait_for_timeout",
          note: "stream_activation_retry_wait",
          details: {
            rowKey: row.rowKey,
            attempt: attempt + 1
          },
          run: async () => {
            await page.waitForTimeout(180);
          }
        });
        continue;
      }

      return {
        ok: true,
        descriptor: await this.getActiveThreadDescriptor(page, selectors)
      };
    }

    if (clickAttempts <= 0 && missingAttempts > 0) {
      return {
        ok: false,
        reason: missingAttempts === 1 ? "row_not_mounted" : "row_not_found_after_scroll"
      };
    }
    if (clickFailures > 0 && clickFailures === clickAttempts) {
      return {
        ok: false,
        reason: "open_click_failed"
      };
    }
    if (waitedForContainer) {
      return {
        ok: false,
        reason: "message_container_not_ready"
      };
    }
    return {
      ok: false,
      reason: "activation_mismatch"
    };
  }

  private async collectVisibleThreadMessages(
    page: Page,
    selectors: SelectorRegistry,
    limit: number
  ): Promise<LinkedInMessageSnapshot[]> {
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    const readText = async (locator: Locator): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.innerText({ timeout: 0 }).catch(() => null);
    };
    const readAttr = async (locator: Locator, name: string): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.getAttribute(name, { timeout: 0 }).catch(() => null);
    };
    const readMessageKey = async (root: Locator, index: number): Promise<string> =>
      (await readAttr(root, "data-event-urn")) ??
      (await readAttr(root, "data-id")) ??
      (await readAttr(root, "id")) ??
      `li-msg-${index}`;

    const messageNodes = page.locator(selectors.message_item);
    const count = await messageNodes.count().catch(() => 0);
    const parsed: LinkedInMessageSnapshot[] = [];
    for (let index = 0; index < count; index += 1) {
      const root = messageNodes.nth(index);
      const bubbleCount = await root.locator(".msg-s-event-listitem__message-bubble").count().catch(() => 0);
      if (bubbleCount <= 0) {
        continue;
      }
      const className = (await readAttr(root, "class")) ?? "";
      const inbound = className.includes("msg-s-event-listitem--other") || /other|received|incoming/i.test(className);
      const attachmentCount = await root
        .locator("img, video, svg, a[download], a[href*='attachment']")
        .count()
        .catch(() => 0);
      const rawBodyText = clean((await readText(root.locator(selectors.message_text).first())) ?? "");
      const text = rawBodyText || (attachmentCount > 0 ? "[non-text message]" : "[system event]");
      const senderName = clean(
        (await readText(root.locator(".msg-s-message-group__profile-link").first())) ??
          (await readText(root.locator(".msg-s-message-group__name").first())) ??
          ""
      );
      const timeLocator = root.locator("time").first();
      const timestamp = clean((await readAttr(timeLocator, "datetime")) ?? (await readText(timeLocator)) ?? "");
      const platformMessageKey = await readMessageKey(root, index);
      parsed.push({
        platformMessageKey,
        direction: inbound ? "IN" : "OUT",
        timestamp,
        text,
        senderName: senderName || undefined,
        raw: {
          className,
          hasTime: Boolean(timestamp),
          attachmentCount
        },
        attachments: attachmentCount
          ? [{ type: "attachment", manualReview: true, rawLabel: `${attachmentCount} attachment(s)` }]
          : []
      });
    }

    if (parsed.length <= limit) {
      return parsed;
    }
    return parsed.slice(parsed.length - limit);
  }

  private async scrollStreamingListContainer(
    page: Page,
    scrollContainer: ElementHandle<Element>,
    mode: LinkedInScrollContainerResolution["mode"]
  ): Promise<{ before: number; after: number; clientHeight: number; scrollHeight: number; moved: boolean }> {
    const result = await this.runTracedPageAction({
      page,
      stage: "collect_threads",
      action: "scroll_container",
      selector: "stream_scroll_container",
      note: "stream_scroll",
      details: {
        ratio: 0.78,
        mode
      },
      run: async () =>
        scrollContainer.evaluate((root) => {
          const node = root as HTMLElement;
          const before = node.scrollTop;
          const clientHeight = Math.max(1, Math.floor(node.clientHeight));
          const scrollHeight = Math.max(clientHeight, Math.floor(node.scrollHeight));
          const delta = Math.max(1, Math.floor(clientHeight * 0.78));
          node.scrollTop = before + delta;
          return {
            before,
            after: node.scrollTop,
            clientHeight,
            scrollHeight,
            moved: node.scrollTop !== before
          };
        })
    });
    return result;
  }

  private async writeStreamingResolverFailureArtifacts(input: {
    page: Page;
    requestId: string;
    reason: string;
    listRootFound: boolean;
    scrollContainerFound: boolean;
    shellTriedSelectors: Record<string, number>;
    listRootTriedSelectors: Record<string, number>;
    topCandidates: LinkedInResolverNodeProbe[];
    selectedPath?: Record<string, unknown>;
    blocker?: LinkedInStreamingBlockerSignal | null;
    rowSignalCounts?: Record<string, number>;
    effectiveSelectors?: Pick<SelectorRegistry, "thread_list" | "thread_item">;
    shellSummary?: LinkedInResolverNodeProbe | null;
    listRootSource?: "heuristic_shell" | "selector_shell" | "selector_global" | null;
    selectorScopeCounts?: {
      global: LinkedInSelectorScopeCounts;
      shell: LinkedInSelectorScopeCounts | null;
    } | null;
  }): Promise<{ diagnosticsJsonPath?: string; screenshotPath?: string; domPath?: string }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const diagnosticsJsonPath = join(
      this.runLogger?.enabled && this.runLogger.runDir ? this.runLogger.runDir : this.deps.domDumpDir,
      `linkedin-streaming-resolver-${stamp}.json`
    );
    const screenshotPath = join(this.deps.screenshotDir, `linkedin-streaming-resolver-${stamp}.png`);
    const domPath = join(this.deps.domDumpDir, `linkedin-streaming-resolver-${stamp}.html`);

    const payload = {
      generatedAt: new Date().toISOString(),
      requestId: input.requestId,
      reason: input.reason,
      url: input.page.url(),
      title: cleanText(await input.page.title().catch(() => "")),
      listRootFound: input.listRootFound,
      scrollContainerFound: input.scrollContainerFound,
      blocker: input.blocker
        ? {
            reason: input.blocker.reason,
            signal: input.blocker.signal,
            modalTextSnippet: input.blocker.modalTextSnippet ?? null
          }
        : null,
      triedSelectors: {
        shell: input.shellTriedSelectors,
        listRoot: input.listRootTriedSelectors,
        rowRoots: linkedInStreamingRowRootSelectors,
        rowClickTargets: linkedInStreamingRowClickTargetSelectors
      },
      rowSignalCounts: input.rowSignalCounts ?? null,
      effectiveSelectors: input.effectiveSelectors ?? null,
      shellSummary: input.shellSummary ?? null,
      listRootSource: input.listRootSource ?? null,
      selectorScopeCounts: input.selectorScopeCounts ?? null,
      routeContext: input.page.url().includes("/messaging/thread/")
        ? "thread_route"
        : input.page.url().includes("/messaging/")
          ? "messaging_route"
          : "other",
      selectedPath: input.selectedPath ?? null,
      topCandidates: this.dedupeResolverNodeProbes(input.topCandidates)
    };

    let savedDiagnostics: string | undefined;
    try {
      await writeFile(diagnosticsJsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      savedDiagnostics = diagnosticsJsonPath;
    } catch {
      savedDiagnostics = undefined;
    }

    let savedScreenshot: string | undefined;
    try {
      await this.tracedScreenshot(input.page, screenshotPath, {
        stage: "collect_threads",
        note: "streaming_resolver_failure"
      });
      savedScreenshot = screenshotPath;
    } catch {
      savedScreenshot = undefined;
    }

    let savedDom: string | undefined;
    try {
      await this.tracedDomDump(input.page, domPath, {
        stage: "collect_threads",
        note: "streaming_resolver_failure"
      });
      savedDom = domPath;
    } catch {
      savedDom = undefined;
    }

    if (this.runLogger?.enabled) {
      this.runLogger.copyFailureArtifacts({
        screenshotPath: savedScreenshot,
        domDumpPath: savedDom
      });
    }

    return {
      diagnosticsJsonPath: savedDiagnostics,
      screenshotPath: savedScreenshot,
      domPath: savedDom
    };
  }

  async scanInboxThreadsStream(options: LinkedInStreamScanOptions): Promise<LinkedInStreamScanMetrics> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.navigateInbox(selectors);
      const stopRunTracing = await this.startRunTracing(page);
      const metrics: LinkedInStreamScanMetrics = {
        stopReason: "max_iterations",
        iterations: 0,
        scrollIterations: 0,
        processedRows: 0,
        actionableRows: 0,
        openedRows: 0,
        skippedRows: 0,
        failures: 0
      };

      const maxThreads = Math.max(1, options.maxThreads ?? this.deps.scanMaxThreads);
      const maxOpens = Math.max(1, options.maxOpens ?? maxThreads);
      const maxIterations = Math.max(20, Math.min(140, maxThreads * 4));
      const maxDurationMs = 60_000;
      const processedRowKeys = new Set<string>();
      const startedAt = Date.now();

      let noNewRowKeysStreak = 0;
      let scrollTopStagnantStreak = 0;
      let shellResolution: LinkedInResolverNodeResolution | null = null;
      let listRootResolution: LinkedInResolverNodeResolution | null = null;
      let scrollResolution: LinkedInScrollContainerResolution | null = null;
      let listRootSource: "heuristic_shell" | "selector_shell" | "selector_global" | null = null;
      let shellRebased = false;
      let rebaseMode: "lca" | "skipped" | null = null;
      const resolverCandidateProbes: LinkedInResolverNodeProbe[] = [];

      this.activeStage = "collect_threads";
      try {
        await this.throwIfAuthRequired(page, "scanInboxThreadsStream:navigation");
        let readiness:
          | { ready: boolean; empty: boolean; reason?: LinkedInScanFailureReason | LinkedInCollectionStopReason }
          | null = null;
        try {
          readiness = await this.waitForThreadListReadyOrClassified(page, selectors, 3_500);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/Timed out waiting for LinkedIn thread list container to become ready/i.test(message)) {
            this.logTraceDecision({
              stage: "collect_threads",
              level: "warn",
              decision: "Legacy thread-list readiness timed out; continuing with streaming hydration gate",
              details: {
                reason: "thread_list_not_ready",
                message
              }
            });
          } else {
            throw error;
          }
        }
        if (readiness && !readiness.ready) {
          if (readiness.reason === "blocked_by_modal") {
            const blocker = await this.detectStreamingBlocker(page);
            const artifacts = await this.writeStreamingResolverFailureArtifacts({
              page,
              requestId: options.requestId,
              reason: "blocked_by_modal",
              listRootFound: false,
              scrollContainerFound: false,
              shellTriedSelectors: {},
              listRootTriedSelectors: {},
              topCandidates: [],
              blocker
            });
            throw await toStageFailure({
              platform: this.platform,
              stage: "collect_threads",
              message: "LinkedIn streaming scan blocked by modal/interstitial.",
              action: "streaming-resolver",
              error: new Error("blocked_by_modal"),
              kind: "SELECTOR_MISMATCH",
              page,
              screenshotDir: this.deps.screenshotDir,
              domDumpDir: this.deps.domDumpDir,
              details: {
                reason: "blocked_by_modal",
                diagnosticsJsonPath: artifacts.diagnosticsJsonPath ?? null
              }
            });
          }
          throw new Error(`LinkedIn thread list is not ready for stream scan (${readiness.reason ?? "unknown"}).`);
        }
        await this.ensureAllFilterActive(page);
        const shellReadiness = await this.waitForMessagingShellReady(page);
        if (!shellReadiness.ready || shellReadiness.signal === "main_text_messaging") {
          this.logTraceDecision({
            stage: "collect_threads",
            level: "warn",
            decision: "Messaging shell guard is weak/not-ready; hydration gate will decide resolver readiness",
            details: {
              timeoutMs: 4_000,
              signal: shellReadiness.signal ?? null
            }
          });
        } else {
          this.logTraceDecision({
            stage: "collect_threads",
            decision: "Messaging shell guard ready before resolver",
            details: {
              signal: shellReadiness.signal ?? null
            }
          });
        }

        const hydration = await this.waitForThreadListHydratedOrEmptyOrBlocked(page, selectors, 10_000);
        if (hydration.status === "blocked_by_modal") {
          const artifacts = await this.writeStreamingResolverFailureArtifacts({
            page,
            requestId: options.requestId,
            reason: "blocked_by_modal",
            listRootFound: false,
            scrollContainerFound: false,
            shellTriedSelectors: {},
            listRootTriedSelectors: {},
            topCandidates: [],
            blocker: hydration.blocker,
            rowSignalCounts: hydration.rowSignalCounts,
            effectiveSelectors: {
              thread_list: selectors.thread_list,
              thread_item: selectors.thread_item
            }
          });
          throw await toStageFailure({
            platform: this.platform,
            stage: "collect_threads",
            message: "LinkedIn streaming scan blocked by modal/interstitial.",
            action: "streaming-resolver",
            error: new Error("blocked_by_modal"),
            kind: "SELECTOR_MISMATCH",
            page,
            screenshotDir: this.deps.screenshotDir,
            domDumpDir: this.deps.domDumpDir,
            details: {
              reason: "blocked_by_modal",
              diagnosticsJsonPath: artifacts.diagnosticsJsonPath ?? null
            }
          });
        }
        if (hydration.status === "empty_inbox") {
          metrics.stopReason = "zero_threads_found";
          this.lastCollectionMetrics = {
            totalFound: 0,
            unreadFound: 0,
            iterations: 0,
            stopReason: metrics.stopReason
          };
          this.logTraceDecision({
            stage: "collect_threads",
            decision: "LinkedIn streaming collection ended with empty inbox before resolver",
            details: {
              stopReason: metrics.stopReason,
              rowSignalCounts: hydration.rowSignalCounts
            }
          });
          return metrics;
        }
        if (hydration.status === "list_hydration_timeout") {
          const artifacts = await this.writeStreamingResolverFailureArtifacts({
            page,
            requestId: options.requestId,
            reason: "list_hydration_timeout",
            listRootFound: false,
            scrollContainerFound: false,
            shellTriedSelectors: {},
            listRootTriedSelectors: {},
            topCandidates: [],
            rowSignalCounts: hydration.rowSignalCounts,
            effectiveSelectors: {
              thread_list: selectors.thread_list,
              thread_item: selectors.thread_item
            }
          });
          throw await toStageFailure({
            platform: this.platform,
            stage: "collect_threads",
            message: "LinkedIn streaming scan timed out waiting for list hydration.",
            action: "streaming-resolver",
            error: new Error("list_hydration_timeout"),
            kind: "SELECTOR_MISMATCH",
            page,
            screenshotDir: this.deps.screenshotDir,
            domDumpDir: this.deps.domDumpDir,
            details: {
              reason: "list_hydration_timeout",
              diagnosticsJsonPath: artifacts.diagnosticsJsonPath ?? null
            }
          });
        }

        const blocker = await this.detectStreamingBlocker(page);
        if (blocker) {
          const artifacts = await this.writeStreamingResolverFailureArtifacts({
            page,
            requestId: options.requestId,
            reason: "blocked_by_modal",
            listRootFound: false,
            scrollContainerFound: false,
            shellTriedSelectors: {},
            listRootTriedSelectors: {},
            topCandidates: [],
            blocker,
            rowSignalCounts: hydration.rowSignalCounts,
            effectiveSelectors: {
              thread_list: selectors.thread_list,
              thread_item: selectors.thread_item
            }
          });
          const line = `[LI][SCAN][req=${options.requestId}][collect_threads] listRootFound=false scrollContainerFound=false reason=blocked_by_modal url=${page.url()} title=${cleanText(await page.title().catch(() => ""))}`;
          options.runLogger?.headline({
            platform: "LI",
            requestId: options.requestId,
            stage: "collect_threads",
            message: line
          });
          this.logTraceDecision({
            stage: "collect_threads",
            level: "error",
            decision: line,
            details: {
              reason: blocker.reason,
              signal: blocker.signal,
              modalTextSnippet: blocker.modalTextSnippet ?? null,
              artifacts
            }
          });
          throw await toStageFailure({
            platform: this.platform,
            stage: "collect_threads",
            message: "LinkedIn streaming scan blocked by modal/interstitial.",
            action: "streaming-resolver",
            error: new Error("blocked_by_modal"),
            kind: "SELECTOR_MISMATCH",
            page,
            screenshotDir: this.deps.screenshotDir,
            domDumpDir: this.deps.domDumpDir,
            details: {
              reason: blocker.reason,
              signal: blocker.signal,
              modalTextSnippet: blocker.modalTextSnippet ?? null,
              diagnosticsJsonPath: artifacts.diagnosticsJsonPath ?? null
            }
          });
        }

        shellResolution = await this.resolveMessagingShell(page);
        if (shellResolution) {
          resolverCandidateProbes.push(...shellResolution.topCandidates);
        }

        listRootResolution = shellResolution ? await this.resolveConversationListRoot(page, shellResolution.handle) : null;
        if (listRootResolution) {
          listRootSource = "heuristic_shell";
          resolverCandidateProbes.push(...listRootResolution.topCandidates);
        } else if (shellResolution) {
          for (let retry = 0; retry < 3; retry += 1) {
            await page.waitForTimeout(180).catch(() => undefined);
            const retriedResolution = await this.resolveConversationListRoot(page, shellResolution.handle).catch(() => null);
            if (!retriedResolution) {
              continue;
            }
            listRootResolution = retriedResolution;
            listRootSource = "heuristic_shell";
            resolverCandidateProbes.push(...retriedResolution.topCandidates);
            this.logTraceDecision({
              stage: "collect_threads",
              decision: "Resolved list root after bounded retry",
              details: {
                retryAttempt: retry + 1,
                selector: retriedResolution.selector
              }
            });
            break;
          }
        }

        if (!listRootResolution && shellResolution) {
          const selectorShellResolution = await this.resolveConversationListRootFromConfiguredSelector(
            page,
            selectors,
            shellResolution.handle
          );
          if (selectorShellResolution) {
            listRootResolution = selectorShellResolution;
            listRootSource = "selector_shell";
            resolverCandidateProbes.push(...selectorShellResolution.topCandidates);
          }
        }

        if (!listRootResolution) {
          const selectorGlobalResolution = await this.resolveConversationListRootFromConfiguredSelector(page, selectors, null);
          if (selectorGlobalResolution) {
            listRootResolution = selectorGlobalResolution;
            listRootSource = "selector_global";
            resolverCandidateProbes.push(...selectorGlobalResolution.topCandidates);

            const messagePaneHandle = await page.locator(selectors.message_container).first().elementHandle().catch(() => null);
            if (messagePaneHandle) {
              const lcaShell = await this.findLowestCommonAncestor(selectorGlobalResolution.handle, messagePaneHandle);
              if (lcaShell) {
                const lcaSummary = await this.describeResolverHandle(lcaShell);
                shellResolution = {
                  handle: lcaShell,
                  selector: "__lca__",
                  index: 0,
                  score: lcaSummary?.delta ?? 0,
                  mode: "fallback",
                  triedSelectorCounts: shellResolution?.triedSelectorCounts ?? {},
                  topCandidates: this.dedupeResolverNodeProbes(
                    (shellResolution?.topCandidates ?? []).concat(lcaSummary ? [lcaSummary] : [])
                  )
                };
                shellRebased = true;
                rebaseMode = "lca";
              } else {
                rebaseMode = "skipped";
              }
            } else {
              rebaseMode = "skipped";
            }
          }
        }

        if (!listRootResolution) {
          const revealResult = await this.tryRevealConversationListFromNarrowLayout({
            page,
            selectors,
            shell: shellResolution?.handle ?? null
          });
          if (revealResult.attempted) {
            this.logTraceDecision({
              stage: "collect_threads",
              decision: "Narrow layout reveal attempt before resolver failure",
              details: {
                revealed: revealResult.revealed,
                selector: revealResult.selector ?? null,
                globalRowSignals: revealResult.globalRowSignals,
                shellRowSignalCount: revealResult.shellRowSignalCount
              }
            });
          }
          if (revealResult.revealed) {
            if (shellResolution) {
              listRootResolution = await this.resolveConversationListRoot(page, shellResolution.handle);
              if (listRootResolution) {
                listRootSource = "heuristic_shell";
                resolverCandidateProbes.push(...listRootResolution.topCandidates);
              }
            }
            if (!listRootResolution) {
              const selectorRetryResolution = await this.resolveConversationListRootFromConfiguredSelector(
                page,
                selectors,
                shellResolution?.handle ?? null
              );
              if (selectorRetryResolution) {
                listRootResolution = selectorRetryResolution;
                listRootSource = shellResolution ? "selector_shell" : "selector_global";
                resolverCandidateProbes.push(...selectorRetryResolution.topCandidates);
              }
            }
            if (!listRootResolution) {
              const selectorRetryGlobal = await this.resolveConversationListRootFromConfiguredSelector(page, selectors, null);
              if (selectorRetryGlobal) {
                listRootResolution = selectorRetryGlobal;
                listRootSource = "selector_global";
                resolverCandidateProbes.push(...selectorRetryGlobal.topCandidates);
              }
            }
          }
        }

        const shellForScroll = shellResolution?.handle ?? listRootResolution?.handle ?? null;
        scrollResolution =
          listRootResolution && shellForScroll
            ? await this.resolveScrollContainer(listRootResolution.handle, shellForScroll)
            : null;
        if (scrollResolution) {
          resolverCandidateProbes.push(...scrollResolution.topCandidates);
        }

        const selectorScopeCounts = await this.collectScopeCounts({
          page,
          selectors,
          shell: shellResolution?.handle ?? null
        });
        const shellSummary = shellResolution ? await this.describeResolverHandle(shellResolution.handle) : null;

        const resolverReason = !listRootResolution
          ? "list_root_not_found"
          : !scrollResolution
            ? "no_scroll_container"
            : "ok";
        const resolverLine = `[LI][SCAN][req=${options.requestId}][collect_threads] listRootFound=${Boolean(listRootResolution)} scrollContainerFound=${Boolean(scrollResolution)} reason=${resolverReason} listRootSource=${listRootSource ?? "none"} shellRebased=${shellRebased} rebaseMode=${rebaseMode ?? "none"} url=${page.url()} title=${cleanText(await page.title().catch(() => ""))}`;
        options.runLogger?.headline({
          platform: "LI",
          requestId: options.requestId,
          stage: "collect_threads",
          message: resolverLine
        });
        this.logTraceDecision({
          stage: "collect_threads",
          decision: resolverLine,
          details: {
            shellSelector: shellResolution?.selector ?? null,
            listRootSelector: listRootResolution?.selector ?? null,
            scrollResolutionMode: scrollResolution?.mode ?? null,
            listRootSource,
            shellRebased,
            rebaseMode,
            selectorScopeCounts,
            shellSummary
          }
        });

        if (!listRootResolution) {
          const artifacts = await this.writeStreamingResolverFailureArtifacts({
            page,
            requestId: options.requestId,
            reason: "list_root_not_found",
            listRootFound: false,
            scrollContainerFound: Boolean(scrollResolution),
            shellTriedSelectors: shellResolution?.triedSelectorCounts ?? {},
            listRootTriedSelectors: {},
            topCandidates: resolverCandidateProbes,
            rowSignalCounts: hydration.rowSignalCounts,
            effectiveSelectors: {
              thread_list: selectors.thread_list,
              thread_item: selectors.thread_item
            },
            shellSummary,
            listRootSource,
            selectorScopeCounts,
            selectedPath: {
              shellSelector: shellResolution?.selector ?? null,
              listRootSelector: null,
              scrollMode: scrollResolution?.mode ?? null,
              shellRebased,
              rebaseMode
            }
          });
          throw await toStageFailure({
            platform: this.platform,
            stage: "collect_threads",
            message: "LinkedIn streaming scan could not resolve a conversation list root.",
            action: "streaming-resolver",
            error: new Error("list_root_not_found"),
            kind: "SELECTOR_MISMATCH",
            page,
            screenshotDir: this.deps.screenshotDir,
            domDumpDir: this.deps.domDumpDir,
            details: {
              reason: "list_root_not_found",
              diagnosticsJsonPath: artifacts.diagnosticsJsonPath ?? null,
              shellSelector: shellResolution?.selector ?? null
            }
          });
        }

        const processVisibleRowsOnce = async (): Promise<{
          visibleRowCount: number;
          newRowsSeen: number;
          bottomRowKey: string | null;
        }> => {
          const visibleRows = await this.captureVisibleRowsForStreaming(page, listRootResolution!.handle).catch(() => []);
          const currentBottomRowKey = visibleRows.at(-1)?.rowKey ?? null;
          let newRowsSeen = 0;

          for (const row of visibleRows) {
            if (processedRowKeys.has(row.rowKey)) {
              continue;
            }
            processedRowKeys.add(row.rowKey);
            newRowsSeen += 1;
            metrics.processedRows += 1;

            const candidateSignals: LinkedInStreamCandidateSignals = {
              rowKey: row.rowKey,
              displayName: row.displayName,
              unreadCount: row.unreadCount,
              needsReplyFromList: row.needsReplyFromList,
              sponsored: row.sponsored
            };
            this.logTraceEvent({
              stage: "collect_threads",
              action: "stream_row_seen",
              details: {
                ...candidateSignals
              },
              page
            });

            if (row.sponsored) {
              metrics.skippedRows += 1;
              continue;
            }

            const actionable = row.unreadCount > 0 || row.needsReplyFromList;
            if (!actionable) {
              continue;
            }
            metrics.actionableRows += 1;

            if (metrics.openedRows >= maxOpens) {
              metrics.stopReason = "max_threads";
              break;
            }

            const openResult = await this.openVisibleRowForStreaming(page, selectors, listRootResolution!.handle, row);
            if (!openResult.ok) {
              metrics.failures += 1;
              metrics.skippedRows += 1;
              this.logTraceDecision({
                stage: "open_thread",
                level: "warn",
                decision: "Skipping stream candidate after open failure",
                details: {
                  rowKey: row.rowKey,
                  displayName: row.displayName,
                  reason: openResult.reason
                }
              });
              continue;
            }

            const canonicalFromUrl = normalizeCanonicalLinkedInThreadId({
              threadUrl: openResult.descriptor.threadUrl ?? page.url()
            });
            const canonicalFromActiveKey = normalizeCanonicalLinkedInThreadId({
              activeKey: openResult.descriptor.activeKey ?? row.activeKey
            });
            const canonicalPlatformThreadId = canonicalFromUrl ?? canonicalFromActiveKey;
            const identitySource = canonicalFromUrl ? "thread_url" : canonicalFromActiveKey ? "active_key" : "none";
            if (!canonicalPlatformThreadId) {
              metrics.failures += 1;
              metrics.skippedRows += 1;
              this.logTraceDecision({
                stage: "persist",
                level: "warn",
                decision: "Skipping stream candidate due to unresolved canonical identity after open",
                details: {
                  rowKey: row.rowKey,
                  displayName: row.displayName,
                  reason: "unresolved_thread_id_after_open",
                  identitySource
                }
              });
              continue;
            }

            const parsedMessages = await this.collectVisibleThreadMessages(page, selectors, 120);
            const baseTimestamp = Date.now() - parsedMessages.length * 1_000;
            const normalizedMessages: NormalizedMessage[] = parsedMessages.map((message, index) => ({
              ...message,
              direction: message.direction === "IN" ? "IN" : "OUT",
              timestamp: this.normalizeTimestamp(message.timestamp, new Date(baseTimestamp + index * 1_000).toISOString()),
              text: cleanText(message.text),
              senderName: message.senderName,
              raw: message.raw
            }));

            const thread: ThreadStub = {
              platformThreadId: canonicalPlatformThreadId,
              displayName: openResult.descriptor.displayName ?? row.displayName,
              unreadCount: row.unreadCount,
              lastMessagePreview: row.previewSnippet || cleanText(normalizedMessages.at(-1)?.text ?? ""),
              lastMessageAt: row.listTimestamp || undefined,
              threadUrl: openResult.descriptor.threadUrl ?? page.url(),
              needsReplyFromList: row.needsReplyFromList,
              isUnreadCandidate: true
            };

            this.logTraceEvent({
              stage: "read_thread",
              action: "stream_candidate_opened",
              details: {
                rowKey: row.rowKey,
                displayName: row.displayName,
                canonicalPlatformThreadId,
                identitySource,
                parsedMessages: normalizedMessages.length
              },
              page
            });

            await options.onThreadCandidate({
              rowKey: row.rowKey,
              thread,
              messages: normalizedMessages
            });
            metrics.openedRows += 1;
          }

          return {
            visibleRowCount: visibleRows.length,
            newRowsSeen,
            bottomRowKey: currentBottomRowKey
          };
        };

        while (metrics.iterations < maxIterations) {
          if (Date.now() - startedAt >= maxDurationMs) {
            metrics.stopReason = "max_duration";
            break;
          }

          metrics.iterations += 1;
          const rowPass = await processVisibleRowsOnce();

          if (metrics.stopReason === "max_threads") {
            break;
          }
          if (metrics.processedRows >= maxThreads) {
            metrics.stopReason = "max_threads";
            break;
          }

          noNewRowKeysStreak = rowPass.newRowsSeen > 0 ? 0 : noNewRowKeysStreak + 1;
          if (!scrollResolution) {
            metrics.stopReason = "no_scroll_container";
            this.logTraceEvent({
              stage: "collect_threads",
              action: "stream_scroll_iteration",
              details: {
                iteration: metrics.iterations,
                scrollTopBefore: null,
                scrollTopAfter: null,
                visibleRowCount: rowPass.visibleRowCount,
                newRowsSeen: rowPass.newRowsSeen,
                noNewRowKeysStreak,
                scrollTopStagnantStreak,
                stopReason: metrics.stopReason
              },
              page
            });
            break;
          }

          const scrollMetrics = await this.scrollStreamingListContainer(page, scrollResolution.handle, scrollResolution.mode)
            .then((result) => result)
            .catch(() => null);
          metrics.scrollIterations += 1;

          const moved = Boolean(scrollMetrics?.moved);
          scrollTopStagnantStreak = moved ? 0 : scrollTopStagnantStreak + 1;
          const shouldAttemptReresolve = !moved || metrics.scrollIterations % 5 === 0;
          if (shouldAttemptReresolve && shellResolution && listRootResolution) {
            const refreshedScroll = await this.resolveScrollContainer(listRootResolution.handle, shellResolution.handle).catch(
              () => null
            );
            if (refreshedScroll) {
              scrollResolution = refreshedScroll;
              resolverCandidateProbes.push(...refreshedScroll.topCandidates);
              this.logTraceDecision({
                stage: "collect_threads",
                decision: "Re-resolved streaming scroll container",
                details: {
                  iteration: metrics.iterations,
                  reason: moved ? "periodic_refresh" : "scroll_stall",
                  mode: refreshedScroll.mode
                }
              });
            }
          }

          this.logTraceEvent({
            stage: "collect_threads",
            action: "stream_scroll_iteration",
            details: {
              iteration: metrics.iterations,
              scrollTopBefore: scrollMetrics?.before ?? null,
              scrollTopAfter: scrollMetrics?.after ?? null,
              clientHeight: scrollMetrics?.clientHeight ?? null,
              scrollHeight: scrollMetrics?.scrollHeight ?? null,
              visibleRowCount: rowPass.visibleRowCount,
              newRowsSeen: rowPass.newRowsSeen,
              noNewRowKeysStreak,
              scrollTopStagnantStreak,
              bottomRowKey: rowPass.bottomRowKey,
              scrollResolutionMode: scrollResolution.mode
            },
            page
          });

          if (noNewRowKeysStreak >= 3 || scrollTopStagnantStreak >= 2) {
            metrics.stopReason = "end_of_list_no_progress";
            break;
          }

          await this.runTracedPageAction({
            page,
            stage: "collect_threads",
            action: "wait_for_timeout",
            note: "stream_post_scroll_wait",
            details: {
              delayMs: Math.max(80, this.deps.scanScrollWaitMs)
            },
            run: async () => {
              await page.waitForTimeout(Math.max(80, this.deps.scanScrollWaitMs));
            }
          });
        }

        if (metrics.processedRows <= 0 && metrics.stopReason === "max_iterations") {
          metrics.stopReason = "zero_threads_found";
        }

        this.lastCollectionMetrics = {
          totalFound: metrics.processedRows,
          unreadFound: metrics.actionableRows,
          iterations: metrics.iterations,
          stopReason: metrics.stopReason
        };
        this.logTraceDecision({
          stage: "collect_threads",
          decision: "Completed LinkedIn streaming collection",
          details: {
            ...metrics
          }
        });
        return metrics;
      } finally {
        this.activeStage = null;
        await stopRunTracing();
      }
    });
  }

  private async getActiveThreadDescriptor(page: Page, selectors: SelectorRegistry): Promise<ActiveThreadDescriptor> {
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    const readText = async (locator: Locator): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.innerText({ timeout: 0 }).catch(() => null);
    };
    const readAttr = async (locator: Locator, name: string): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.getAttribute(name, { timeout: 0 }).catch(() => null);
    };

    const primaryActive = page
      .locator(".msg-conversation-listitem .msg-conversations-container__convo-item-link--active")
      .first();
    const fallbackActive = page
      .locator(".msg-conversation-listitem .msg-conversation-listitem__link--active")
      .first();
    const activeNode = ((await primaryActive.count().catch(() => 0)) > 0 ? primaryActive : fallbackActive).first();

    const activeRowCandidate = activeNode
      .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' msg-conversation-listitem ')][1]")
      .first();
    const activeRow =
      (await activeRowCandidate.count().catch(() => 0)) > 0
        ? activeRowCandidate
        : page.locator(".msg-conversation-listitem").first();
    const activeRowExists = (await activeRow.count().catch(() => 0)) > 0;
    const scope = activeRowExists ? activeRow : activeNode;

    const hrefRaw =
      (await readAttr(scope.locator("a[href*='/messaging/']").first(), "href")) ??
      (await readAttr(page.locator(`${selectors.thread_item} a[href*='/messaging/']`).first(), "href")) ??
      "";
    let href = hrefRaw.trim();
    if (href) {
      try {
        href = new URL(href, page.url()).toString();
      } catch {
        href = href.trim();
      }
    }

    const displayName =
      clean(
        (await readText(scope.locator("h3 span.truncate").first())) ??
          (await readText(scope.locator("h3").first())) ??
          (await readAttr(scope.locator("span[title]").first(), "title")) ??
          (await readText(page.locator(".msg-thread__link-to-profile").first())) ??
          ""
      ) || undefined;

    const activeKey =
      (await readAttr(scope, "data-conversation-urn")) ??
      (await readAttr(scope, "data-urn")) ??
      (await readAttr(scope, "data-conversation-id")) ??
      (await readAttr(scope, "data-id")) ??
      (await readAttr(scope, "id")) ??
      href;

    return {
      threadUrl: href || undefined,
      activeKey: activeKey || undefined,
      displayName
    };
  }

  private isThreadDescriptorMatch(
    descriptor: ActiveThreadDescriptor,
    thread: ThreadStub,
    currentPageUrl: string
  ): boolean {
    const expectedName = this.normalizeIdentity(thread.displayName);
    const actualName = this.normalizeIdentity(descriptor.displayName);
    if (expectedName && actualName && expectedName === actualName) {
      return true;
    }

    const expectedKey = this.normalizeIdentity(thread.platformThreadId);
    const actualKey = this.normalizeIdentity(descriptor.activeKey);
    if (expectedKey && actualKey && expectedKey === actualKey) {
      return true;
    }

    const expectedToken = this.resolveThreadUrlToken(thread.threadUrl || thread.platformThreadId);
    const actualToken = this.resolveThreadUrlToken(descriptor.threadUrl || currentPageUrl);
    if (expectedToken && actualToken && (expectedToken.includes(actualToken) || actualToken.includes(expectedToken))) {
      return true;
    }

    return false;
  }

  private async openThreadAndWaitForActivation(
    page: Page,
    selectors: SelectorRegistry,
    thread: ThreadStub
  ): Promise<void> {
    const before = await this.getActiveThreadDescriptor(page, selectors);

    if (thread.threadUrl) {
      await this.tracedGoto(page, thread.threadUrl, {
        stage: "open_thread",
        note: "open_by_thread_url"
      });
    } else {
      await this.tracedGoto(page, selectors.inbox_url, {
        stage: "open_thread",
        note: "open_by_inbox_navigation"
      });
      await this.tracedWaitForVisible(page, selectors.thread_list, LinkedInAdapter.inboxReadyTimeoutMs, {
        stage: "open_thread",
        note: "wait_thread_list_before_click"
      });

      const rowRoot = page.locator(".msg-conversation-listitem").filter({ hasText: thread.displayName }).first();
      const fallbackRow = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
      const rowExists = (await rowRoot.count()) > 0;
      const clickTarget = rowExists
        ? rowRoot.locator(".msg-conversation-listitem__link").first()
        : fallbackRow;
      const clickTargetExists = (await clickTarget.count()) > 0;

      if (!rowExists && !clickTargetExists) {
        throw new AdapterFailure(`Unable to locate LinkedIn thread row for ${thread.displayName}`, {
          kind: "THREAD_FETCH_FAILED",
          platform: this.platform,
          stage: "open_thread",
          platformThreadId: thread.platformThreadId,
          details: {
            targetDisplayName: thread.displayName,
            platformThreadId: thread.platformThreadId
          }
        });
      }

      await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);
      await this.runTracedPageAction({
        page,
        stage: "open_thread",
        action: "click",
        selector: rowExists ? ".msg-conversation-listitem__link" : selectors.thread_item,
        note: "activate_thread_row",
        details: {
          targetDisplayName: thread.displayName
        },
        run: async () => {
          await clickTarget.click({ timeout: 10_000 });
        }
      });
    }

    await this.tracedWaitForVisible(page, selectors.message_container, 15_000, {
      stage: "open_thread",
      note: "wait_message_container_after_open"
    });

    const startedAt = Date.now();
    let lastDescriptor: ActiveThreadDescriptor | undefined;

    while (Date.now() - startedAt < 12_000) {
      await this.throwIfAuthRequired(page, "openThreadAndWaitForActivation");
      const descriptor = await this.getActiveThreadDescriptor(page, selectors);
      lastDescriptor = descriptor;

      const changed =
        this.normalizeIdentity(before.activeKey) !== this.normalizeIdentity(descriptor.activeKey) ||
        this.normalizeIdentity(before.displayName) !== this.normalizeIdentity(descriptor.displayName) ||
        this.normalizeThreadUrl(before.threadUrl) !== this.normalizeThreadUrl(descriptor.threadUrl);

      const matchesTarget = this.isThreadDescriptorMatch(descriptor, thread, page.url());
      if (matchesTarget || changed) {
        if (matchesTarget) {
          return;
        }
      }

      await this.runTracedPageAction({
        page,
        stage: "open_thread",
        action: "wait_for_timeout",
        note: "activation_poll_wait",
        details: {
          delayMs: 300
        },
        run: async () => {
          await page.waitForTimeout(300);
        }
      });
    }

    throw new AdapterFailure(`LinkedIn thread activation mismatch for ${thread.displayName}`, {
      kind: "THREAD_FETCH_FAILED",
      platform: this.platform,
      stage: "open_thread",
      platformThreadId: thread.platformThreadId,
      details: {
        targetDisplayName: thread.displayName,
        targetThreadUrl: thread.threadUrl ?? null,
        targetPlatformThreadId: thread.platformThreadId,
        actualDisplayName: lastDescriptor?.displayName ?? null,
        actualThreadUrl: lastDescriptor?.threadUrl ?? page.url(),
        actualKey: lastDescriptor?.activeKey ?? null
      }
    });
  }

  private async collectThreadMessagesWithBackfill(
    page: Page,
    selectors: SelectorRegistry,
    limit: number
  ): Promise<LinkedInMessageSnapshot[]> {
    const maxAttempts = Math.max(1, this.deps.messageBackfillAttempts);
    const merged = new Map<string, LinkedInMessageSnapshot>();
    const clean = (value: string | null | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();
    const readText = async (locator: Locator): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.innerText({ timeout: 0 }).catch(() => null);
    };
    const readAttr = async (locator: Locator, name: string): Promise<string | null> => {
      const first = locator.first();
      if ((await first.count().catch(() => 0)) <= 0) {
        return null;
      }
      return first.getAttribute(name, { timeout: 0 }).catch(() => null);
    };
    const readMessageKey = async (root: Locator, index: number): Promise<string> =>
      (await readAttr(root, "data-event-urn")) ??
      (await readAttr(root, "data-id")) ??
      (await readAttr(root, "id")) ??
      `li-msg-${index}`;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      this.logTraceEvent({
        stage: "read_thread",
        action: "message_backfill_attempt_start",
        details: {
          attempt: attempt + 1,
          maxAttempts,
          limit,
          mergedCount: merged.size
        },
        attempt: attempt + 1,
        page
      });
      const messageNodes = page.locator(selectors.message_item);
      const initialCount = await messageNodes.count().catch(() => 0);
      const beforeFirstKey = initialCount > 0 ? await readMessageKey(messageNodes.nth(0), 0) : "";

      const messages: LinkedInMessageSnapshot[] = [];
      for (let index = 0; index < initialCount; index += 1) {
        const root = messageNodes.nth(index);
        const className = (await readAttr(root, "class")) ?? "";
        const inbound = className.includes("msg-s-event-listitem--other") || /other|received|incoming/i.test(className);
        const attachmentCount = await root
          .locator("img, video, svg, a[download], a[href*='attachment']")
          .count()
          .catch(() => 0);
        const rawBodyText = clean((await readText(root.locator(selectors.message_text).first())) ?? "");
        const text = rawBodyText || (attachmentCount > 0 ? "[non-text message]" : "[system event]");
        const senderName = clean(
          (await readText(root.locator(".msg-s-message-group__profile-link").first())) ??
            (await readText(root.locator(".msg-s-message-group__name").first())) ??
            ""
        );
        const timeLocator = root.locator("time").first();
        const timestamp = clean((await readAttr(timeLocator, "datetime")) ?? (await readText(timeLocator)) ?? "");
        const platformMessageKey = await readMessageKey(root, index);
        messages.push({
          platformMessageKey,
          direction: inbound ? "IN" : "OUT",
          timestamp,
          text,
          senderName: senderName || undefined,
          raw: {
            className,
            hasTime: Boolean(timestamp),
            attachmentCount
          },
          attachments: attachmentCount
            ? [{ type: "attachment", manualReview: true, rawLabel: `${attachmentCount} attachment(s)` }]
            : []
        });
      }

      await this.runTracedPageAction({
        page,
        stage: "read_thread",
        action: "scroll_container",
        selector: selectors.message_container,
        note: "message_backfill_scroll_up",
        attempt: attempt + 1,
        details: {
          delta: -840
        },
        run: async () => {
          const container = page.locator(selectors.message_container).first();
          await container.hover({ force: true }).catch(() => undefined);
          await page.mouse.wheel(0, -840);
        }
      });
      await this.runTracedPageAction({
        page,
        stage: "read_thread",
        action: "wait_for_timeout",
        note: "message_backfill_post_scroll_wait",
        attempt: attempt + 1,
        details: {
          delayMs: 220
        },
        run: async () => {
          await page.waitForTimeout(220);
        }
      });

      const afterCount = await messageNodes.count().catch(() => 0);
      const afterFirstKey = afterCount > 0 ? await readMessageKey(messageNodes.nth(0), 0) : "";
      const didScrollUp = afterCount > initialCount || afterFirstKey !== beforeFirstKey;
      const snapshot = {
        messages,
        didScrollUp
      };

      for (const message of snapshot.messages) {
        merged.set(message.platformMessageKey, {
          ...message,
          direction: message.direction === "IN" ? "IN" : "OUT"
        });
      }
      this.logTraceEvent({
        stage: "read_thread",
        action: "message_backfill_attempt_end",
        details: {
          attempt: attempt + 1,
          collectedInAttempt: snapshot.messages.length,
          mergedCount: merged.size,
          didScrollUp: snapshot.didScrollUp
        },
        attempt: attempt + 1,
        page
      });

      if (merged.size >= limit || !snapshot.didScrollUp) {
        break;
      }

      await this.runTracedPageAction({
        page,
        stage: "read_thread",
        action: "wait_for_timeout",
        note: "message_backfill_wait",
        details: {
          delayMs: 350
        },
        attempt: attempt + 1,
        run: async () => {
          await page.waitForTimeout(350);
        }
      });
    }

    const rows = Array.from(merged.values());
    rows.sort((left, right) => {
      const leftTime = Date.parse(left.timestamp);
      const rightTime = Date.parse(right.timestamp);
      const safeLeft = Number.isNaN(leftTime) ? 0 : leftTime;
      const safeRight = Number.isNaN(rightTime) ? 0 : rightTime;
      return safeLeft - safeRight;
    });
    this.logTraceEvent({
      stage: "read_thread",
      action: "message_backfill_complete",
      details: {
        totalMessages: rows.length,
        returnedMessages: Math.min(rows.length, limit)
      },
      page
    });
    return rows.slice(-limit);
  }

  async ensureConnected(): Promise<void> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();

      let page: Page | null = null;
      try {
        this.activeStage = "connect";
        this.runLogger?.logStage({
          stage: "connect",
          phase: "start"
        });
        page = await this.navigateInbox(selectors);
        await this.throwIfAuthRequired(page, "ensureConnected:navigation");
        await this.tracedWaitForVisible(page, selectors.thread_list, LinkedInAdapter.inboxReadyTimeoutMs, {
          stage: "connect",
          note: "wait_thread_list_connected"
        });
        await this.throwIfAuthRequired(page, "ensureConnected:thread_list");
        this.runLogger?.logStage({
          stage: "connect",
          phase: "end"
        });
      } catch (error) {
        this.runLogger?.logError({
          component: "linkedin-adapter",
          stage: "connect",
          action: "ensure_connected_failed",
          error
        });
        if (page) {
          await this.captureRunFailureArtifacts(page);
        }
        if (error instanceof AdapterFailure) {
          throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);
        const currentUrl = page?.url();
        const suffix = currentUrl ? ` (url: ${currentUrl})` : "";
        throw await toStageFailure({
          platform: this.platform,
          stage: "connect",
          message: `LinkedIn connect failed (${reason})${suffix}`,
          action: "connect-failed",
          error,
          kind: this.classifyFailureKind(reason, "SELECTOR_MISMATCH"),
          page: page ?? undefined,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir,
          details: currentUrl ? { url: currentUrl } : undefined
        });
      } finally {
        this.activeStage = null;
      }
    });
  }

  async smokeUnreadIngest(input: {
    requestId: string;
    logDir: string;
    persist: (input: LinkedInSmokePersistInput) => Promise<{ updatedThreads: number; parsedMessages: number }>;
    logStep?: LinkedInSmokeStepLog;
    logLine?: (line: string) => Promise<void>;
    maxMessages?: number;
  }): Promise<LinkedInSmokeIngestResult> {
    const totalSteps = 8;
    const maxMessages = Math.max(1, Math.min(50, input.maxMessages ?? 12));
    const logStep = async (
      step: number,
      stepName: string,
      message: string,
      details?: Record<string, unknown>
    ): Promise<void> => {
      await input.logStep?.({
        step,
        totalSteps,
        stepName,
        message,
        details
      });
    };
    const fail = (
      stage: AdapterStage,
      reason: string,
      message: string,
      details?: Record<string, unknown>
    ): never => {
      throw new AdapterFailure(message, {
        kind: "SELECTOR_MISMATCH",
        platform: this.platform,
        stage,
        details: {
          requestId: input.requestId,
          reason,
          ...(details ?? {})
        }
      });
    };

    await this.ensureConnected();
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.getPage();
      const baseArtifacts: LinkedInSmokeProbeArtifacts = {
        listProbeJson: join(input.logDir, "list-probe.json"),
        listProbeHtml: join(input.logDir, "list-probe.html"),
        listProbePng: join(input.logDir, "list-probe.png")
      };
      let probeArtifacts: LinkedInSmokeProbeArtifacts = {
        ...baseArtifacts
      };
      let probeData: LinkedInUnreadListProbeData | null = null;

      try {
        const urlBefore = page.url();
        await page.goto(linkedInSmokeEntryUrl, { waitUntil: "domcontentloaded" }).catch(async (error: unknown) => {
          const readiness = await isLinkedInMessagingShellReady(page);
          const navigateArtifacts = await dumpLinkedInSmokeNavigateProbe({
            page,
            logDir: input.logDir,
            probe: readiness.details,
            reason: "smoke_entry_navigation_failed"
          });
          const counts = {
            searchInputCounts: readiness.details.searchInputCounts,
            listContainerCounts: readiness.details.listContainerCounts,
            filterPillCount: readiness.details.filterPillCount,
            visibleSearchInput: readiness.details.visibleSearchInput,
            visibleListContainer: readiness.details.visibleListContainer,
            visibleFilterPills: readiness.details.visibleFilterPills
          };
          await input.logLine?.(
            `[LI][SMOKE][req=${input.requestId}][navigate] url=${readiness.details.url} ` +
              `title=${readiness.details.title || "(untitled)"} ready=false ` +
              `counts=${JSON.stringify(counts)} reason=smoke_entry_navigation_failed`
          );
          fail("navigate", "smoke_entry_navigation_failed", "Unable to open LinkedIn messaging unread entry URL.", {
            error: error instanceof Error ? error.message : String(error),
            urlBefore,
            probe: readiness.details,
            signal: "goto_error",
            navigateProbeArtifacts: navigateArtifacts
          });
        });
        const urlAfterGoto = page.url();
        await page.waitForTimeout(1_000);
        const urlAfter1s = page.url();
        const shellWait = await waitForLinkedInShellReady(page, 15_000);

        if (shellWait.state !== "READY") {
          const reason = shellWait.state === "BLOCKED" ? shellWait.blocked.reason : "messaging_shell_not_ready";
          const navigateArtifacts = await dumpLinkedInSmokeNavigateProbe({
            page,
            logDir: input.logDir,
            probe: shellWait.probe,
            reason
          });
          const counts = {
            searchInputCounts: shellWait.probe.searchInputCounts,
            listContainerCounts: shellWait.probe.listContainerCounts,
            filterPillCount: shellWait.probe.filterPillCount,
            visibleSearchInput: shellWait.probe.visibleSearchInput,
            visibleListContainer: shellWait.probe.visibleListContainer,
            visibleFilterPills: shellWait.probe.visibleFilterPills
          };
          await input.logLine?.(
            `[LI][SMOKE][req=${input.requestId}][navigate] url=${shellWait.probe.url} ` +
              `title=${shellWait.probe.title || "(untitled)"} ready=false ` +
              `counts=${JSON.stringify(counts)} reason=${reason}` +
              (shellWait.state === "BLOCKED" && reason === "blocked_by_modal"
                ? ` modalSelector=${shellWait.blocked.signal} modalText="${shellWait.blocked.modalTextSnippet ?? ""}"`
                : "")
          );
          const failureMessage =
            reason === "login_required"
              ? "LinkedIn smoke navigate requires login."
              : reason === "checkpoint_required"
                ? "LinkedIn smoke navigate is blocked by a checkpoint/verification gate."
                : reason === "blocked_by_modal"
                  ? "LinkedIn smoke navigate is blocked by a modal or interstitial."
                  : "LinkedIn messaging shell did not become ready for smoke run.";
          fail("navigate", reason, failureMessage, {
            urlBefore,
            urlAfterGoto,
            urlAfter1s,
            probe: shellWait.probe,
            signal: shellWait.state === "BLOCKED" ? shellWait.blocked.signal : "timeout_waiting_for_shell",
            modalTextSnippet: shellWait.state === "BLOCKED" ? shellWait.blocked.modalTextSnippet : undefined,
            navigateProbeArtifacts: navigateArtifacts
          });
        }
        const shellReadiness = shellWait.probe;
        await input.logLine?.(`[LI][SMOKE][req=${input.requestId}][navigate] shellReady=true url=${shellReadiness.url}`);

        await logStep(1, "entry_url", "forced unread entry", {
          URL_BEFORE: urlBefore,
          URL_AFTER_GOTO: urlAfterGoto,
          URL_AFTER_1S: urlAfter1s,
          shellReady: true,
          title: shellReadiness.title,
          searchInputCounts: shellReadiness.searchInputCounts,
          listContainerCounts: shellReadiness.listContainerCounts,
          filterPillCount: shellReadiness.filterPillCount,
          visibleSearchInput: shellReadiness.visibleSearchInput,
          visibleListContainer: shellReadiness.visibleListContainer,
          visibleFilterPills: shellReadiness.visibleFilterPills
        });

        await logStep(2, "unread_filter", "activating Unread filter");
        const unreadPill = page.locator(linkedInUnreadPillSelector).first();
        const pillFound = (await unreadPill.count().catch(() => 0)) > 0;
        if (!pillFound) {
          fail("collect_threads", "unread_pill_missing", "LinkedIn Unread filter pill is missing.");
        }

        const activeBefore = isLinkedInUnreadPillActive({
          ariaPressed: await unreadPill.getAttribute("aria-pressed").catch(() => null),
          ariaChecked: await unreadPill.getAttribute("aria-checked").catch(() => null)
        });
        let clicked = false;
        if (!activeBefore) {
          await unreadPill.scrollIntoViewIfNeeded().catch(() => undefined);
          await unreadPill.click({ timeout: 5_000 }).catch((error: unknown) => {
            fail("collect_threads", "unread_pill_click_failed", "Failed to click LinkedIn Unread filter.", {
              error: error instanceof Error ? error.message : String(error)
            });
          });
          clicked = true;
        }

        const activationDeadline = Date.now() + 4_000;
        let activeAfter = activeBefore;
        while (Date.now() < activationDeadline) {
          activeAfter = isLinkedInUnreadPillActive({
            ariaPressed: await unreadPill.getAttribute("aria-pressed").catch(() => null),
            ariaChecked: await unreadPill.getAttribute("aria-checked").catch(() => null)
          });
          if (activeAfter) {
            break;
          }
          await page.waitForTimeout(120);
        }
        await logStep(2, "unread_filter", "Unread pill state", {
          activeBefore,
          activeAfter,
          clicked
        });
        await input.logLine?.(`[LI][SMOKE][req=${input.requestId}][unread] activeAfter=${activeAfter}`);
        if (!activeAfter) {
          fail("collect_threads", "unread_filter_not_active", "LinkedIn Unread filter did not become active.");
        }

        await logStep(3, "list_ready", "waiting for unread rows or empty state");
        const unreadWait = await waitUnreadRowsOrEmptyState(page, 12_000);
        const emptyStateDetected = unreadWait.state === "EMPTY_UNREAD";
        const emptyStateMatches = unreadWait.state === "EMPTY_UNREAD" ? unreadWait.matches : [];
        let rowDiscovery = unreadWait.discovery;
        if (unreadWait.state === "ROWS_READY") {
          rowDiscovery = unreadWait.discovery;
        } else if (unreadWait.state === "TIMEOUT") {
          rowDiscovery = await getConversationRowCandidates(page);
        }
        await input.logLine?.(
          `[LI][SMOKE][req=${input.requestId}][rows] rows=${rowDiscovery.candidates.length} emptyUnreadState=${emptyStateDetected}`
        );

        const probe = await dumpLinkedInUnreadListProbe({
          page,
          logDir: input.logDir,
          discovery: rowDiscovery,
          emptyStateMatches,
          unreadPillActive: activeAfter
        });
        probeArtifacts = {
          ...baseArtifacts,
          ...probe.artifacts
        };
        probeData = probe.data;

        const listContainerChildCount = probe.data.chosenContainer?.childCount ?? 0;
        const unreadCounterValues = probe.data.unreadCounterValues;
        const unreadCounterCounts = probe.data.unreadCounterProbes.map((entry) => ({
          selector: entry.selector,
          count: entry.count,
          samples: entry.samples.slice(0, 3)
        }));
        await logStep(3, "list_ready", "unread list settled", {
          containerSelector: probe.data.chosenContainer?.selector ?? null,
          containerChildCount: listContainerChildCount,
          namesCount: rowDiscovery.participantNamesCount,
          clickTargetsCount: rowDiscovery.candidates.length,
          directLiCount: rowDiscovery.directLiCount,
          realRowCount: rowDiscovery.candidates.length,
          unreadCounterCounts,
          unreadCounterValues: unreadCounterValues.slice(0, 5),
          emptyStateDetected
        });

        if (emptyStateDetected) {
          await logStep(8, "done", "SMOKE_OK_UNREAD_EMPTY", {
            unreadCount: 0
          });
          return {
            outcome: "UNREAD_EMPTY",
            unreadCount: 0,
            messagesParsed: 0,
            messages: [],
            summary: {
              name: null,
              listTimestamp: null,
              previewSnippet: null,
              unreadCount: 0
            },
            probeArtifacts,
            diagnostics: {
              namesCount: rowDiscovery.participantNamesCount,
              clickTargetsCount: rowDiscovery.candidates.length,
              primaryClickTargetsCount: rowDiscovery.linkCount,
              listContainerChildCount,
              unreadCounterValues,
              emptyStateDetected
            }
          };
        }

        if (rowDiscovery.candidates.length <= 0) {
          const mismatchMessage = linkedInSmokeRowMismatchMessage.replace(
            "X",
            String(rowDiscovery.directLiCount)
          );
          await input.logLine?.(
            `[LI][SMOKE][req=${input.requestId}] ${mismatchMessage}`
          );
          await logStep(3, "list_ready", mismatchMessage, {
            directLiCount: rowDiscovery.directLiCount,
            liWithParticipantAndLinkCount: rowDiscovery.liWithParticipantAndLinkCount
          });
          fail("collect_threads", "selector_mismatch_thread_rows", mismatchMessage, {
            directLiCount: rowDiscovery.directLiCount,
            liWithParticipantCount: rowDiscovery.liWithParticipantCount,
            liWithLinkCount: rowDiscovery.liWithLinkCount,
            liWithParticipantAndLinkCount: rowDiscovery.liWithParticipantAndLinkCount,
            participantNamesCount: rowDiscovery.participantNamesCount,
            linkCount: rowDiscovery.linkCount,
            listContainerChildCount,
            unreadCounterValues
          });
        }

        const discoveredHandles = await discoverLinkedInUnreadRowsWithHandles(page);
        if (!discoveredHandles.rows[0]) {
          const mismatchMessage = linkedInSmokeRowMismatchMessage.replace(
            "X",
            String(discoveredHandles.directLiCount)
          );
          fail("collect_threads", "selector_mismatch_thread_rows", mismatchMessage, {
            namesCount: discoveredHandles.namesCount,
            clickTargetsCount: discoveredHandles.clickTargetsCount,
            directLiCount: discoveredHandles.directLiCount,
            liWithParticipantAndLinkCount: discoveredHandles.liWithParticipantAndLinkCount
          });
        }
        const firstRow = discoveredHandles.rows[0]!;
        const topCandidates = rowDiscovery.candidates.slice(0, 3).map((candidate) => ({
          name: candidate.participantName,
          time: candidate.listTimestamp ?? "",
          preview: candidate.previewSnippet ?? ""
        }));
        await input.logLine?.(
          `[LI][SMOKE][req=${input.requestId}][candidates] n=${rowDiscovery.candidates.length} first="${firstRow.metadata.participantName}" time="${firstRow.metadata.listTimestamp ?? ""}"`
        );
        await input.logLine?.(
          `[LI][SMOKE][req=${input.requestId}][candidates] top3=${JSON.stringify(topCandidates)}`
        );

        const threadMeta = firstRow.metadata;
        await logStep(4, "thread_row_meta", "first thread metadata extracted", {
          participantName: threadMeta.participantName,
          listTimestamp: threadMeta.listTimestamp ?? null,
          previewSnippet: threadMeta.previewSnippet ?? null,
          unreadCount: threadMeta.unreadCount ?? null
        });

        await logStep(5, "open_thread", "opening first detected thread");
        await firstRow.clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);
        await firstRow.clickTarget.click({ timeout: 8_000 }).catch((error: unknown) => {
          fail("open_thread", "thread_open_click_failed", "Failed to open first LinkedIn thread row.", {
            error: error instanceof Error ? error.message : String(error)
          });
        });
        const messageContainerSelector = `${linkedInSmokeMessageContainerSelector}, ${selectors.message_container}`;
        await page
          .waitForSelector(messageContainerSelector, {
            state: "visible",
            timeout: 8_000
          })
          .catch(() => {
            fail("open_thread", "message_container_not_ready", "LinkedIn message container did not become ready.");
          });
        await logStep(5, "open_thread", "thread opened", {
          messageContainerSelector
        });
        const activeDescriptor = await this.getActiveThreadDescriptor(page, selectors);
        const canonicalPlatformThreadId = normalizeCanonicalLinkedInThreadId({
          platformThreadId: threadMeta.platformThreadId ?? threadMeta.stableKey,
          threadUrl: activeDescriptor.threadUrl ?? page.url(),
          activeKey: activeDescriptor.activeKey
        });
        if (!canonicalPlatformThreadId) {
          fail(
            "persist",
            "unresolved_thread_id_after_open",
            "LinkedIn smoke row did not resolve a canonical thread identity after open.",
            {
              participantName: threadMeta.participantName,
              candidateKey: threadMeta.stableKey,
              activeThreadUrl: activeDescriptor.threadUrl ?? page.url(),
              activeKey: activeDescriptor.activeKey ?? null
            }
          );
        }
        const resolvedThreadUrl = activeDescriptor.threadUrl ?? page.url();

        await logStep(6, "parse_messages", "parsing visible messages");
        const rawMessages = await extractLinkedInSmokeMessages(page, maxMessages);
        if (rawMessages.length <= 0) {
          fail("parse", "no_messages_parsed", "Smoke ingest could not parse visible message text.");
        }
        const baseTimestamp = Date.now() - rawMessages.length * 1_000;
        const messages: NormalizedMessage[] = rawMessages.map((message, index) => ({
          platformMessageKey: message.platformMessageKey,
          direction: message.direction,
          timestamp: this.normalizeTimestamp(message.timestamp, new Date(baseTimestamp + index * 1_000).toISOString()),
          text: cleanText(message.text),
          senderName: message.senderName,
          attachments: [],
          raw: {
            smoke: true
          }
        }));
        await logStep(6, "parse_messages", "messages parsed", {
          messagesParsed: messages.length
        });

        await logStep(7, "persist", "persisting thread and messages");
        const unreadCount = threadMeta.unreadCount ?? 1;
        const thread: ThreadStub = {
          platformThreadId: canonicalPlatformThreadId!,
          displayName: threadMeta.participantName,
          lastMessagePreview: threadMeta.previewSnippet ?? cleanText(messages.at(-1)?.text ?? ""),
          lastMessageAt: threadMeta.listTimestamp,
          threadUrl: resolvedThreadUrl,
          unreadCount,
          needsReplyFromList: threadMeta.needsReplyFromList,
          isUnreadCandidate: true
        };
        const persisted = await input.persist({
          thread,
          messages
        });
        await logStep(7, "persist", "persist complete", {
          updatedThreads: persisted.updatedThreads,
          parsedMessages: persisted.parsedMessages
        });

        await logStep(8, "done", "SMOKE_OK", {
          name: threadMeta.participantName,
          listTimestamp: threadMeta.listTimestamp ?? null,
          unreadCount,
          messagesParsed: messages.length
        });
        return {
          outcome: "INGESTED_ONE_THREAD",
          unreadCount,
          thread,
          messagesParsed: messages.length,
          messages,
          persisted,
          summary: {
            name: threadMeta.participantName,
            listTimestamp: threadMeta.listTimestamp ?? null,
            previewSnippet: threadMeta.previewSnippet ?? null,
            unreadCount
          },
          probeArtifacts,
          diagnostics: {
            namesCount: discoveredHandles.namesCount,
            clickTargetsCount: discoveredHandles.clickTargetsCount,
            primaryClickTargetsCount: discoveredHandles.primaryClickTargetsCount,
            listContainerChildCount,
            unreadCounterValues,
            emptyStateDetected
          }
        };
      } catch (error) {
        if (!probeData) {
          try {
            const discovery = await getConversationRowCandidates(page);
            const fallbackProbe = await dumpLinkedInUnreadListProbe({
              page,
              logDir: input.logDir,
              discovery,
              emptyStateMatches: [],
              unreadPillActive: false
            });
            probeArtifacts = {
              ...baseArtifacts,
              ...fallbackProbe.artifacts
            };
            probeData = fallbackProbe.data;
          } catch {
            // best effort
          }
        }
        const artifacts = await captureLinkedInSmokeFailureArtifacts({
          page,
          logDir: input.logDir
        });
        if (error instanceof AdapterFailure) {
          error.details = {
            ...(error.details ?? {}),
            probeArtifacts: {
              ...probeArtifacts,
              ...artifacts
            }
          };
        }
        throw error;
      }
    });
  }

  async scanUnreadThreads(options?: LinkedInFullScanOptions): Promise<ThreadStub[]> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.navigateInbox(selectors);
      const stageReceipts: LinkedInScanStageReceipt[] = [];
      let activeStage: LinkedInScanStageReceipt["stage"] = "navigate";
      let recoveryAttempts = 0;
      const runCounters: LinkedInRunCounters = {
        unreadViewActive: false,
        threadsVisibleCount: 0,
        threadsCollectedTotal: 0,
        threadsWithUnreadBadgeCount: 0,
        candidatesToOpenCount: 0,
        openedThreadsCount: 0,
        messagesParsedCount: 0,
        scrollIterations: 0,
        noProgressStreak: 0,
        recoveryAttemptsUsed: 0,
        reloadSuppressed: false
      };

      const stopRunTracing = await this.startRunTracing(page);
      const runStage = async <T>(
        stage: LinkedInScanStageReceipt["stage"],
        run: () => Promise<T>,
        details?: Record<string, unknown>
      ): Promise<T> => {
        activeStage = stage;
        this.activeStage = stage;
        const started = Date.now();
        const startedAt = new Date(started).toISOString();
        this.runLogger?.logStage({
          stage,
          phase: "start",
          details
        });
        try {
          const value = await run();
          const durationMs = Date.now() - started;
          stageReceipts.push({
            stage,
            status: "OK",
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            details
          });
          this.runLogger?.logStage({
            stage,
            phase: "end",
            details: {
              status: "OK",
              ...(details ?? {})
            },
            elapsedMs: durationMs
          });
          return value;
        } catch (error) {
          const durationMs = Date.now() - started;
          stageReceipts.push({
            stage,
            status: "FAIL",
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            details: {
              ...(details ?? {}),
              ...this.summarizeError(error)
            }
          });
          this.runLogger?.logStage({
            stage,
            phase: "end",
            details: {
              status: "FAIL",
              ...(details ?? {})
            },
            elapsedMs: durationMs
          });
          throw error;
        }
      };

      try {
        for (let attempt = 0; attempt <= 1; attempt += 1) {
          try {
            await runStage("navigate", async () => {
              const readiness = await this.waitForThreadListReadyOrClassified(page, selectors, 8_000);
              if (!readiness.ready) {
                if (readiness.reason === "login_required" || readiness.reason === "checkpoint_required") {
                  throw new AdapterFailure("LinkedIn auth required in personal profile. Open browser and sign in.", {
                    kind: "AUTH_REQUIRED",
                    platform: this.platform,
                    stage: "navigate",
                    details: {
                      reason: readiness.reason,
                      url: page.url()
                    }
                  });
                }
                if (readiness.reason === "rate_limited" || readiness.reason === "linkedin_error_overlay") {
                  throw new AdapterFailure("LinkedIn inbox is blocked by a LinkedIn overlay.", {
                    kind: "SELECTOR_MISMATCH",
                    platform: this.platform,
                    stage: "navigate",
                    details: {
                      reason: readiness.reason,
                      url: page.url()
                    }
                  });
                }
                throw new Error("LinkedIn thread list container not ready.");
              }
            }, {
              url: page.url()
            });

            await runStage("auth_check", async () => {
              await this.throwIfAuthRequired(page, "scanUnreadThreads:navigation");
              await this.throwIfAuthRequired(page, "scanUnreadThreads:thread_list");
            });

            const collected = await runStage(
              "collect_threads",
              async () => this.collectThreadRowsWithScroll(page, selectors, this.deps.scanMaxThreads, options),
              {
                attempt: attempt + 1,
                recoveryAttempts
              }
            );
            const latestReceipt = stageReceipts.at(-1);
            if (latestReceipt && latestReceipt.stage === "collect_threads") {
              latestReceipt.details = {
                ...(latestReceipt.details ?? {}),
                iterations: collected.iterations,
                stopReason: collected.stopReason,
                uniqueThreads: collected.rows.length,
                noProgressStreak: collected.noProgressStreak,
                bottomRepeatStreak: collected.bottomRepeatStreak,
                scrollNoMoveStreak: collected.scrollNoMoveStreak,
                scrollIterations: collected.scrollIterations
              };
            }

            const actionCandidates = collected.rows.filter(
              (thread) => (thread.unreadCount ?? 0) > 0 || Boolean(thread.needsReplyFromList)
            );
            const candidatesBeforeCap = collected.rowsBeforeCapCount;
            const candidatesAfterCap = actionCandidates.length;
            runCounters.unreadViewActive = false;
            runCounters.threadsVisibleCount = collected.rows.length;
            runCounters.threadsCollectedTotal = collected.rowsBeforeCapCount;
            runCounters.threadsWithUnreadBadgeCount = collected.rows.filter((thread) => (thread.unreadCount ?? 0) > 0).length;
            runCounters.candidatesToOpenCount = candidatesAfterCap;
            runCounters.scrollIterations = collected.scrollIterations;
            runCounters.noProgressStreak = collected.noProgressStreak;
            runCounters.stopReason = collected.stopReason;
            runCounters.recoveryAttemptsUsed = recoveryAttempts;
            this.runLogger?.mergeCounters({ ...runCounters });
            if (options?.runLogger && options.requestId) {
              options.runLogger.headline({
                platform: "LI",
                requestId: options.requestId,
                stage: "collect_threads",
                message: "LinkedIn adapter collection complete",
                details: {
                  candidatesBeforeCap,
                  candidatesAfterCap,
                  disableDeepScroll: options.disableDeepScroll ?? false,
                  stopReason: collected.stopReason
                }
              });
            }

            this.logTraceDecision({
              stage: "collect_threads",
              decision: "Candidate selection uses unread badge or preview-inbound signal",
              details: {
                threadsCollectedTotal: runCounters.threadsCollectedTotal,
                candidatesToOpenCount: runCounters.candidatesToOpenCount,
                unreadCount: runCounters.threadsWithUnreadBadgeCount
              }
            });

            this.lastCollectionMetrics = {
              totalFound: collected.rowsBeforeCapCount,
              unreadFound: runCounters.threadsWithUnreadBadgeCount,
              iterations: collected.iterations,
              stopReason: collected.stopReason
            };
            return actionCandidates.map((thread) => ({ ...thread, isUnreadCandidate: true }));
          } catch (error) {
            if (attempt === 0 && isRetryableLinkedInCollectError(error)) {
              this.logTraceDecision({
                stage: activeStage,
                level: "warn",
                decision: "Retryable collect error detected; automatic reload is disabled and manual refresh is required",
                details: {
                  attempt: attempt + 1,
                  message: error instanceof Error ? error.message : String(error)
                }
              });
              runCounters.reloadSuppressed = true;
              runCounters.recoveryAttemptsUsed = recoveryAttempts;
              this.runLogger?.mergeCounters({ ...runCounters });
              throw new AdapterFailure(
                "Manual refresh required: LinkedIn page became unstable. Refresh LinkedIn manually, then rerun scan. Automatic reload is disabled to preserve browser console diagnostics.",
                {
                  kind: "SELECTOR_MISMATCH",
                  platform: this.platform,
                  stage: activeStage,
                  details: {
                    reason: "manual_refresh_required",
                    requiresManualRefresh: true,
                    guidance: "Refresh LinkedIn manually and rerun scan.",
                    recoveryAttempts
                  }
                }
              );
            }

            const runtimeContext = await this.captureUnreadScanRuntimeContext(page, selectors).catch(() => undefined);
            const failureReason = resolveLinkedInScanFailureReason({
              message: error instanceof Error ? error.message : String(error),
              url: runtimeContext?.url ?? page.url(),
              overlayReason: runtimeContext?.overlayReason,
              threadListCount: runtimeContext?.threadListCount,
              threadItemCount: runtimeContext?.threadItemCount,
              spinnerCount: runtimeContext?.spinnerCount
            });
            runCounters.recoveryAttemptsUsed = recoveryAttempts;
            runCounters.stopReason = failureReason;
            this.runLogger?.mergeCounters({ ...runCounters });

            this.runLogger?.logError({
              component: "linkedin-adapter",
              stage: activeStage,
              action: "scan_unread_fail",
              error,
              details: {
                reason: failureReason,
                runtimeContext,
                recoveryAttempts
              },
              url: page.url(),
              pageId: this.getPageTraceId(page)
            });
            await this.captureRunFailureArtifacts(page);

            if (error instanceof AdapterFailure) {
              error.details = {
                ...(error.details ?? {}),
                stage: error.stage ?? activeStage,
                reason: failureReason,
                runtimeContext,
                stageReceipts,
                recoveryAttempts
              };
              throw error;
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            throw await toStageFailure({
              platform: this.platform,
              stage: activeStage,
              message: "Failed while scanning LinkedIn unread threads",
              action: "scan-unread",
              error,
              kind: this.classifyFailureKind(errorMessage, "SELECTOR_MISMATCH"),
              page,
              screenshotDir: this.deps.screenshotDir,
              domDumpDir: this.deps.domDumpDir,
              details: {
                stage: activeStage,
                reason: failureReason,
                message: errorMessage,
                runtimeContext,
                stageReceipts,
                recoveryAttempts
              }
            });
          }
        }

        throw new Error("LinkedIn unread scan exhausted retries.");
      } finally {
        runCounters.recoveryAttemptsUsed = recoveryAttempts;
        this.runLogger?.mergeCounters({ ...runCounters });
        this.activeStage = null;
        await stopRunTracing();
      }
    });
  }

  async fetchRecentThreads(limit: number, options?: LinkedInFullScanOptions): Promise<ThreadStub[]> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.navigateInbox(selectors);

      try {
        this.activeStage = "collect_threads";
        this.runLogger?.logStage({
          stage: "collect_threads",
          phase: "start",
          details: {
            mode: "recent",
            limit
          }
        });
        await this.throwIfAuthRequired(page, "fetchRecentThreads:navigation");
        await this.tracedWaitForVisible(page, selectors.thread_list, 10_000, {
          stage: "collect_threads",
          note: "wait_recent_thread_list"
        });
        await this.throwIfAuthRequired(page, "fetchRecentThreads:thread_list");
        const collected = await this.collectThreadRowsWithScroll(
          page,
          selectors,
          Math.max(limit, this.deps.scanMaxThreads),
          options
        );
        this.lastCollectionMetrics = {
          totalFound: collected.rowsBeforeCapCount,
          unreadFound: collected.rows.filter((thread) => (thread.unreadCount ?? 0) > 0).length,
          iterations: collected.iterations,
          stopReason: collected.stopReason
        };
        this.runLogger?.logStage({
          stage: "collect_threads",
          phase: "end",
          details: {
            mode: "recent",
            status: "OK",
            totalFound: collected.rows.length,
            stopReason: collected.stopReason
          }
        });
        return collected.rows.slice(0, limit).map((thread) => ({ ...thread, isRecentCandidate: true }));
      } catch (error) {
        const runtimeContext = await this.captureUnreadScanRuntimeContext(page, selectors).catch(() => undefined);
        const failureReason = resolveLinkedInScanFailureReason({
          message: error instanceof Error ? error.message : String(error),
          url: runtimeContext?.url ?? page.url(),
          overlayReason: runtimeContext?.overlayReason,
          threadListCount: runtimeContext?.threadListCount,
          threadItemCount: runtimeContext?.threadItemCount,
          spinnerCount: runtimeContext?.spinnerCount
        });
        this.runLogger?.logError({
          component: "linkedin-adapter",
          stage: "collect_threads",
          action: "scan_recent_fail",
          error,
          details: {
            reason: failureReason,
            runtimeContext
          }
        });
        await this.captureRunFailureArtifacts(page);

        if (isRetryableLinkedInCollectError(error)) {
          this.logTraceDecision({
            stage: "collect_threads",
            level: "warn",
            decision: "Recent-thread collection became unstable; automatic reload is disabled and manual refresh is required",
            details: {
              reason: failureReason,
              message: error instanceof Error ? error.message : String(error)
            }
          });
          this.runLogger?.mergeCounters({
            reloadSuppressed: true,
            stopReason: "manual_refresh_required"
          });
          throw new AdapterFailure(
            "Manual refresh required: LinkedIn page closed or context reset during recent-thread scan. Refresh LinkedIn manually, then rerun scan. Automatic reload is disabled to preserve browser console diagnostics.",
            {
              kind: "NAVIGATION_FAILED",
              platform: this.platform,
              stage: "collect_threads",
              details: {
                reason: "manual_refresh_required",
                requiresManualRefresh: true,
                guidance: "Refresh LinkedIn manually and rerun scan.",
                runtimeContext
              }
            }
          );
        }

        if (error instanceof AdapterFailure) {
          error.details = {
            ...(error.details ?? {}),
            reason: failureReason,
            runtimeContext
          };
          throw error;
        }

        const reason = error instanceof Error ? error.message : String(error);
        throw await toStageFailure({
          platform: this.platform,
          stage: "collect_threads",
          message: "Failed while scanning LinkedIn recent threads",
          action: "scan-recent",
          error,
          kind: this.classifyFailureKind(reason, "NAVIGATION_FAILED"),
          page,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir,
          details: {
            reason: failureReason,
            runtimeContext
          }
        });
      } finally {
        this.activeStage = null;
      }
    });
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.navigateInbox(selectors);

      try {
        this.activeStage = "read_thread";
        this.runLogger?.logStage({
          stage: "read_thread",
          phase: "start",
          details: {
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName,
            limit
          }
        });
        await this.throwIfAuthRequired(page, "fetchThreadMessages:navigation");
        await this.openThreadAndWaitForActivation(page, selectors, thread);
        await this.throwIfAuthRequired(page, "fetchThreadMessages:after_activation");
        const activeDescriptor = await this.getActiveThreadDescriptor(page, selectors);
        const canonicalPlatformThreadId = normalizeCanonicalLinkedInThreadId({
          platformThreadId: thread.platformThreadId,
          threadUrl: activeDescriptor.threadUrl ?? page.url(),
          activeKey: activeDescriptor.activeKey
        });
        if (canonicalPlatformThreadId) {
          thread.platformThreadId = canonicalPlatformThreadId;
        }
        if (activeDescriptor.threadUrl ?? page.url()) {
          thread.threadUrl = activeDescriptor.threadUrl ?? page.url();
        }
        if (activeDescriptor.displayName) {
          thread.displayName = activeDescriptor.displayName;
        }
        await this.tracedWaitForVisible(page, selectors.message_container, 15_000, {
          stage: "read_thread",
          note: "wait_message_container"
        });
        await this.throwIfAuthRequired(page, "fetchThreadMessages:after_container_wait");

        const messages = await this.collectThreadMessagesWithBackfill(page, selectors, limit);
        this.logTraceEvent({
          stage: "read_thread",
          action: "messages_parsed",
          details: {
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName,
            messagesParsedCount: messages.length
          },
          page
        });
        this.runLogger?.logStage({
          stage: "read_thread",
          phase: "end",
          details: {
            status: "OK",
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName,
            messagesParsedCount: messages.length
          }
        });
        const baseTimestamp = Date.now() - messages.length * 1_000;
        return messages.map((message, index) => ({
          ...message,
          direction: message.direction === "IN" ? "IN" : "OUT",
          timestamp: this.normalizeTimestamp(message.timestamp, new Date(baseTimestamp + index * 1_000).toISOString()),
          text: cleanText(message.text),
          senderName: message.senderName,
          raw: message.raw
        }));
      } catch (error) {
        this.runLogger?.logError({
          component: "linkedin-adapter",
          stage: "read_thread",
          action: "fetch_thread_messages_fail",
          error,
          details: {
            platformThreadId: thread.platformThreadId,
            displayName: thread.displayName
          }
        });
        await this.captureRunFailureArtifacts(page);
        if (error instanceof AdapterFailure) {
          throw error;
        }
        throw await toStageFailure({
          platform: this.platform,
          stage: "parse",
          message: `Failed to fetch LinkedIn thread messages for ${thread.displayName}`,
          action: "fetch-thread",
          error,
          kind: "THREAD_FETCH_FAILED",
          page,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir,
          platformThreadId: thread.platformThreadId,
          details: { threadDisplayName: thread.displayName, url: page.url() }
        });
      } finally {
        this.activeStage = null;
      }
    });
  }

  private async getLatestMessageSnapshot(
    page: Page,
    selectors: SelectorRegistry
  ): Promise<{ direction: "IN" | "OUT"; timestamp: number; text: string } | null> {
    const nodes = page.locator(selectors.message_item);
    const count = await nodes.count().catch(() => 0);
    if (count <= 0) {
      return null;
    }

    const last = nodes.nth(count - 1);
    const className = (await last.getAttribute("class", { timeout: 0 }).catch(() => null)) ?? "";
    const inbound = /other|received|incoming/i.test(className);
    const timeNode = last.locator("time").first();
    const timestampRaw =
      (await timeNode.getAttribute("datetime", { timeout: 0 }).catch(() => null)) ??
      (await timeNode.innerText({ timeout: 0 }).catch(() => null)) ??
      "";
    const parsed = Date.parse(timestampRaw);
    const text =
      (await last.locator(selectors.message_text).first().innerText({ timeout: 0 }).catch(() => null)) ??
      (await last.innerText({ timeout: 0 }).catch(() => null)) ??
      "";

    return {
      direction: inbound ? "IN" : "OUT",
      timestamp: Number.isNaN(parsed) ? Date.now() : parsed,
      text
    };
  }

  async sendMessage(thread: ThreadStub, text: string): Promise<SendReceipt> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.getPage();

      try {
        if (thread.threadUrl) {
          await page.goto(thread.threadUrl, { waitUntil: "domcontentloaded" });
        } else {
          await page.goto(selectors.inbox_url, { waitUntil: "domcontentloaded" });
          const rowRoot = page.locator(".msg-conversation-listitem").filter({ hasText: thread.displayName }).first();
          const fallbackRow = page.locator(selectors.thread_item).filter({ hasText: thread.displayName }).first();
          const rowExists = (await rowRoot.count()) > 0;
          const clickTarget = rowExists
            ? rowRoot.locator(".msg-conversation-listitem__link").first()
            : fallbackRow;
          if ((await clickTarget.count()) > 0) {
            await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);
            await clickTarget.click();
          }
        }

        await page.waitForSelector(selectors.message_container, { timeout: 12_000 });
        const preSend = await this.getLatestMessageSnapshot(page, selectors);

        const composer = page.locator(selectors.composer_input).first();
        await composer.click({ timeout: 10_000 });
        try {
          await composer.fill(text);
        } catch {
          await page.keyboard.press("Meta+A").catch(() => undefined);
          await page.keyboard.type(text, { delay: 12 });
        }

        await humanDelay(100, 300);
        await page.locator(selectors.send_button).first().click({ timeout: 10_000 });

        const start = Date.now();
        let verifiedBy: VerificationMethod = "best_effort";

        while (Date.now() - start < 10_000) {
          const last = await this.getLatestMessageSnapshot(page, selectors);
          if (!last) {
            await page.waitForTimeout(300);
            continue;
          }

          const timestampAdvanced = !preSend || last.timestamp > preSend.timestamp;
          const textMatch = cleanText(last.text).includes(cleanText(text));

          if (last.direction === "OUT" && timestampAdvanced && textMatch) {
            verifiedBy = "bubble_detected";
            break;
          }

          if (last.direction === "OUT" && timestampAdvanced) {
            verifiedBy = "timestamp_advanced";
            break;
          }

          await page.waitForTimeout(400);
        }

        return {
          sentAt: new Date().toISOString(),
          verifiedBy
        };
      } catch (error) {
        throw await toStageFailure({
          platform: this.platform,
          stage: "persist",
          message: `Failed to send LinkedIn message for ${thread.displayName}`,
          action: "send",
          error,
          kind: "THREAD_FETCH_FAILED",
          page,
          screenshotDir: this.deps.screenshotDir,
          domDumpDir: this.deps.domDumpDir,
          platformThreadId: thread.platformThreadId,
          details: {
            threadDisplayName: thread.displayName
          }
        });
      }
    });
  }

  async openThread(thread: ThreadStub): Promise<void> {
    return this.runWithPlatformLease(async () => {
      const selectors = await this.deps.resolveSelectors();
      const page = await this.getPage();
      await page.bringToFront();
      await this.openThreadAndWaitForActivation(page, selectors, thread);
    });
  }

  async closeSession(_reason?: string): Promise<void> {
    await this.deps.sessionManager.closePlatformPage({
      platform: this.platform,
      personKey: this.deps.personKey ?? "default"
    });
  }
}
