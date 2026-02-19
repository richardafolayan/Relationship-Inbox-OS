import type { Locator, Page } from "playwright";
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
  displayName: string;
  unreadCount: number;
  lastMessagePreview: string;
  lastMessageAt?: string;
  threadUrl?: string;
  avatarUrl?: string;
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

const linkedInUnreadPillSelector = "button[data-test-messaging-inbox-filters__filter-pill='UNREAD']";
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
const linkedInSmokeBlockedModalSelectors = [
  "#onetrust-banner-sdk",
  ".artdeco-modal[role='dialog']",
  "[aria-modal='true']",
  "[data-test-modal]",
  ".msg-overlay-conversations-container--expanded",
  ".artdeco-global-alert",
  "#artdeco-global-alert-container"
];
const linkedInSmokeEmptyStatePatterns = [/no unread/i, /you're all caught up/i, /no messages match/i];
const linkedInSmokeSelectorMismatchError =
  "Selector mismatch: Unread view shows list structure/counters but 0 detectable conversation rows. See list-probe.* in LOG_DIR.";
const linkedInLoadingSpinnerSelector = [
  ".artdeco-loader",
  ".artdeco-spinner",
  ".msg-conversations-container__conversations-list-loader",
  ".msg-conversations-container__loading",
  "[aria-label*='Loading']"
].join(", ");

export interface LinkedInSmokeThreadRowMetadata {
  stableKey: string;
  participantName: string;
  listTimestamp?: string;
  previewSnippet?: string;
  unreadCount?: number;
  threadUrl?: string;
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
  participantNamesCount: number;
  convoItemLinkCount: number;
  conversationListItemCount: number;
  bodyTextSnippet: string;
}

export type LinkedInSmokeNavigateBlockedReason = "login_required" | "checkpoint_required" | "blocked_by_modal";

export type LinkedInSmokeNavigateState =
  | { blocked: false }
  | { blocked: true; reason: LinkedInSmokeNavigateBlockedReason; signal: string };

function cleanLocatorText(value: string | null | undefined): string {
  return cleanText(value ?? "");
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
  rows: LinkedInDiscoveredUnreadRowHandle[];
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

async function resolveRowScopeFromName(nameNode: Locator): Promise<Locator> {
  const liScope = nameNode.locator("xpath=ancestor::li[1]").first();
  if (await hasAny(liScope)) {
    return liScope;
  }

  const classScope = nameNode
    .locator(
      "xpath=ancestor::*[contains(@class,'msg-conversation-listitem') or contains(@class,'msg-conversations-container__convo-item-link') or contains(@class,'msg-conversation-listitem__link')][1]"
    )
    .first();
  if (await hasAny(classScope)) {
    return classScope;
  }

  return nameNode;
}

async function resolveClickTargetFromScope(input: {
  page: Page;
  nameNode: Locator;
  scope: Locator;
  index: number;
}): Promise<Locator | null> {
  const scopedClickable = input.scope
    .locator(
      ":scope :is(div,a,button)[class*='msg-conversation-listitem__link'], :scope :is(div,a,button)[class*='msg-conversations-container__convo-item-link'], :scope a[href*='/messaging/thread/'], :scope a[href*='/messaging/'], :scope [tabindex='0']"
    )
    .first();
  if (await hasAny(scopedClickable)) {
    return scopedClickable;
  }

  const ancestorClickable = input.nameNode
    .locator(
      "xpath=ancestor::*[@tabindex='0' or self::a or self::button or contains(@class,'msg-conversation-listitem__link') or contains(@class,'msg-conversations-container__convo-item-link')][1]"
    )
    .first();
  if (await hasAny(ancestorClickable)) {
    return ancestorClickable;
  }

  const marker = `li-smoke-target-${Date.now()}-${input.index}`;
  const marked = await input.nameNode
    .evaluate((node, markerValue) => {
      const element = node as HTMLElement;
      const clickable = element.closest(
        "[tabindex='0'],a,button,.msg-conversation-listitem__link,[class*='__convo-item-link']"
      ) as HTMLElement | null;
      if (!clickable) {
        return false;
      }
      clickable.setAttribute("data-li-smoke-click-target", markerValue);
      return true;
    }, marker)
    .catch(() => false);
  if (!marked) {
    return null;
  }

  const markerTarget = input.page.locator(`[data-li-smoke-click-target="${marker}"]`).first();
  return (await hasAny(markerTarget)) ? markerTarget : null;
}

async function discoverLinkedInUnreadRowsWithHandles(page: Page): Promise<LinkedInDiscoveredUnreadRowsWithHandles> {
  const namesLocator = page.locator(linkedInSmokeParticipantSelector);
  const rawNamesCount = await namesLocator.count().catch(() => 0);
  const primaryClickTargets = page.locator(
    ":is(div,a,button)[class*='msg-conversation-listitem__link'], :is(div,a,button)[class*='msg-conversations-container__convo-item-link']",
    { has: page.locator(linkedInSmokeParticipantSelector) }
  );
  const primaryClickTargetsCount = await primaryClickTargets.count().catch(() => 0);

  const rows: LinkedInDiscoveredUnreadRowHandle[] = [];
  for (let index = 0; index < rawNamesCount; index += 1) {
    const nameNode = namesLocator.nth(index);
    const participantName = await readText(nameNode);
    if (!participantName) {
      continue;
    }

    const scope = await resolveRowScopeFromName(nameNode);
    const clickTarget = await resolveClickTargetFromScope({
      page,
      nameNode,
      scope,
      index
    });
    if (!clickTarget) {
      continue;
    }

    const listTimestamp = await readText(scope.locator(linkedInSmokeListTimestampSelector));
    const previewSnippet = await readText(scope.locator(linkedInSmokePreviewSelector));
    const href = resolveSmokeThreadUrl(
      (await readAttr(clickTarget, "href")) || (await readAttr(scope.locator("a[href*='/messaging/']"), "href")),
      page.url()
    );
    const unreadCount = await readUnreadCountFromScope(scope);
    const stableToken = resolveSmokeThreadToken(href);
    const stableKey =
      stableToken ||
      `linkedin-smoke:${participantName.toLowerCase()}|${previewSnippet.toLowerCase()}|${listTimestamp.toLowerCase()}`;

    rows.push({
      metadata: {
        stableKey,
        participantName,
        listTimestamp: listTimestamp || undefined,
        previewSnippet: previewSnippet || undefined,
        unreadCount,
        threadUrl: href
      },
      clickTarget,
      scope
    });
  }

  return {
    namesCount: rawNamesCount,
    clickTargetsCount: rows.length,
    primaryClickTargetsCount,
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
  const participantNamesCount = await page.locator(linkedInSmokeParticipantSelector).count().catch(() => 0);
  const convoItemLinkCount = await page
    .locator("[class*='msg-conversations-container__convo-item-link']")
    .count()
    .catch(() => 0);
  const conversationListItemCount = await page.locator(".msg-conversation-listitem").count().catch(() => 0);
  const title = cleanText(await page.title().catch(() => ""));
  const rawBodyText = cleanText(await page.locator("body").innerText().catch(() => ""));
  const bodySnippet = rawBodyText.slice(0, 500);

  const details: LinkedInMessagingShellProbe = {
    url: page.url(),
    title,
    searchInputCounts,
    listContainerCounts,
    participantNamesCount,
    convoItemLinkCount,
    conversationListItemCount,
    bodyTextSnippet: redactSmokeBodySnippet(bodySnippet)
  };

  const searchPresent = hasAnySelectorMatch(searchInputCounts);
  const listPresent = hasAnySelectorMatch(listContainerCounts);
  const rowSignalPresent = participantNamesCount > 0 || convoItemLinkCount > 0 || conversationListItemCount > 0;

  return {
    ok: searchPresent && listPresent && rowSignalPresent,
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

  const modalCounts = await collectSelectorCounts(page, linkedInSmokeBlockedModalSelectors);
  const firstModalMatch = Object.entries(modalCounts).find(([, count]) => count > 0)?.[0];
  if (firstModalMatch) {
    return {
      blocked: true,
      reason: "blocked_by_modal",
      signal: firstModalMatch
    };
  }

  return {
    blocked: false
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
    participantNamesCount: input.probe.participantNamesCount,
    convoItemLinkCount: input.probe.convoItemLinkCount,
    conversationListItemCount: input.probe.conversationListItemCount,
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
  const panelLocator = page
    .locator(
      ".msg-conversations-container, ul.msg-conversations-container__conversations-list, [class*='msg-conversations-container']"
    )
    .first();
  const panelText = await readText(panelLocator.locator(":scope"));
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
  discoveredRows: LinkedInDiscoveredUnreadRowsResult;
  emptyStateMatches: string[];
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

  const sampleRows: LinkedInUnreadListProbeData["sampleRows"] = [];
  const sampleNameNodes = input.page.locator(linkedInSmokeParticipantSelector);
  const sampleNameCount = await sampleNameNodes.count().catch(() => 0);
  for (let index = 0; index < sampleNameCount && sampleRows.length < 10; index += 1) {
    const nameNode = sampleNameNodes.nth(index);
    const name = await readText(nameNode);
    if (!name) {
      continue;
    }
    const scope = await resolveRowScopeFromName(nameNode);
    sampleRows.push({
      name,
      listTimestamp: (await readText(scope.locator(linkedInSmokeListTimestampSelector))) || null,
      previewSnippet: (await readText(scope.locator(linkedInSmokePreviewSelector))) || null,
      unreadCount: (await readUnreadCountFromScope(scope)) ?? null
    });
  }
  if (sampleRows.length <= 0) {
    sampleRows.push(
      ...input.discoveredRows.rows.slice(0, 10).map((row) => ({
        name: row.participantName,
        listTimestamp: row.listTimestamp ?? null,
        previewSnippet: row.previewSnippet ?? null,
        unreadCount: row.unreadCount ?? null
      }))
    );
  }

  const listProbeJson = join(input.logDir, "list-probe.json");
  const listProbeHtml = join(input.logDir, "list-probe.html");
  const listProbePng = join(input.logDir, "list-probe.png");

  const data: LinkedInUnreadListProbeData = {
    url: input.page.url(),
    generatedAt: new Date().toISOString(),
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
    emptyStateTextMatches: input.emptyStateMatches
  };

  await writeFile(listProbeJson, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  const clickableCandidates = input.page.locator(
    ":is(div,a,button)[class*='msg-conversation-listitem__link'], :is(div,a,button)[class*='msg-conversations-container__convo-item-link'], a[href*='/messaging/thread/'], a[href*='/messaging/']"
  );
  const clickableCount = await clickableCandidates.count().catch(() => 0);
  const clickableHtml: string[] = [];
  for (let index = 0; index < Math.min(10, clickableCount); index += 1) {
    const node = clickableCandidates.nth(index);
    const html = await node
      .evaluate((el) => {
        const element = el as HTMLElement;
        const parent = element.parentElement;
        return parent ? parent.outerHTML : element.outerHTML;
      })
      .catch(() => "");
    if (html) {
      clickableHtml.push(truncateForLog(html, 1800));
    }
  }

  const probeHtml = [
    "<!doctype html>",
    "<html><head><meta charset='utf-8'><title>LinkedIn Smoke List Probe</title></head><body>",
    "<h1>LinkedIn Smoke List Probe</h1>",
    "<h2>Chosen Container</h2>",
    `<pre>${escapeHtml(data.chosenContainer?.outerHtmlExcerpt ?? "(none)")}</pre>`,
    "<h2>Candidate Clickable Row Nodes (parent outerHTML)</h2>",
    clickableHtml.length
      ? clickableHtml.map((entry, index) => `<h3>#${index + 1}</h3><pre>${escapeHtml(entry)}</pre>`).join("\n")
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
  | "thread_list_not_ready"
  | "page_closed_mid_stage"
  | "login_required"
  | "checkpoint_required"
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

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
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
      const listVisible = await listLocator.isVisible({ timeout: 0 }).catch(() => false);
      const threadCount = await this.tracedLocatorCount(page, selectors.thread_item, {
        stage: "collect_threads",
        note: "read_thread_item_count"
      }).catch(() => 0);
      if (listVisible || threadCount > 0) {
        return {
          ready: true,
          empty: false
        };
      }

      const emptyStateCount = await this.tracedLocatorCount(
        page,
        ".msg-conversations-container__no-results, .msg-conversations-container__empty-state, .msg-conversations-container__empty-convos, [data-test-empty-state]",
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
      const hrefToken = this.resolveThreadUrlToken(href);
      const fallbackKey = `linkedin-fallback:${displayName.toLowerCase()}|${preview.toLowerCase()}|${unreadCount}`;
      const stableKey =
        (hrefToken && `linkedin-href:${hrefToken}`) ||
        (urnToken && `linkedin-urn:${urnToken.toLowerCase()}`) ||
        fallbackKey;
      const avatarUrl = (await readAttr(scope.locator("img"), "src")) ?? undefined;

      rows.push({
        stableKey,
        displayName: displayName || `LinkedIn Thread ${index + 1}`,
        unreadCount,
        lastMessagePreview: preview,
        lastMessageAt: lastMessageAt || undefined,
        threadUrl: href || undefined,
        avatarUrl
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
    maxThreads: number
  ): Promise<{
    rows: ThreadStub[];
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
        iterations: 0,
        stopReason: "zero_threads_found",
        noProgressStreak: 0,
        bottomRepeatStreak: 0,
        scrollNoMoveStreak: 0,
        scrollIterations: 0
      };
    }

    const cappedMaxThreads = Math.max(1, maxThreads);
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
          platformThreadId: row.stableKey,
          displayName: row.displayName,
          unreadCount: row.unreadCount,
          lastMessagePreview: row.lastMessagePreview,
          lastMessageAt: row.lastMessageAt,
          threadUrl: row.threadUrl,
          avatarUrl: row.avatarUrl
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
      .locator("li.msg-conversation-listitem .msg-conversations-container__convo-item-link--active")
      .first();
    const fallbackActive = page
      .locator("li.msg-conversation-listitem .msg-conversation-listitem__link--active")
      .first();
    const activeNode = ((await primaryActive.count().catch(() => 0)) > 0 ? primaryActive : fallbackActive).first();

    const activeRowCandidate = activeNode.locator("xpath=ancestor::li[contains(@class,'msg-conversation-listitem')]").first();
    const activeRow =
      (await activeRowCandidate.count().catch(() => 0)) > 0
        ? activeRowCandidate
        : page.locator("li.msg-conversation-listitem").first();
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
            participantNamesCount: readiness.details.participantNamesCount,
            convoItemLinkCount: readiness.details.convoItemLinkCount,
            conversationListItemCount: readiness.details.conversationListItemCount
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
        const navigateDeadline = Date.now() + 15_000;
        let shellReadiness = await isLinkedInMessagingShellReady(page);
        let navigateState = await classifyLinkedInSmokeNavigateState(page, shellReadiness.details);
        while (Date.now() < navigateDeadline && !shellReadiness.ok && !navigateState.blocked) {
          await page.waitForTimeout(250);
          shellReadiness = await isLinkedInMessagingShellReady(page);
          navigateState = await classifyLinkedInSmokeNavigateState(page, shellReadiness.details);
        }

        if (!shellReadiness.ok) {
          const reason = navigateState.blocked ? navigateState.reason : "messaging_shell_not_ready";
          const navigateArtifacts = await dumpLinkedInSmokeNavigateProbe({
            page,
            logDir: input.logDir,
            probe: shellReadiness.details,
            reason
          });
          const counts = {
            searchInputCounts: shellReadiness.details.searchInputCounts,
            listContainerCounts: shellReadiness.details.listContainerCounts,
            participantNamesCount: shellReadiness.details.participantNamesCount,
            convoItemLinkCount: shellReadiness.details.convoItemLinkCount,
            conversationListItemCount: shellReadiness.details.conversationListItemCount
          };
          await input.logLine?.(
            `[LI][SMOKE][req=${input.requestId}][navigate] url=${shellReadiness.details.url} ` +
              `title=${shellReadiness.details.title || "(untitled)"} ready=false ` +
              `counts=${JSON.stringify(counts)} reason=${reason}`
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
            probe: shellReadiness.details,
            signal: navigateState.blocked ? navigateState.signal : "timeout_waiting_for_shell",
            navigateProbeArtifacts: navigateArtifacts
          });
        }

        await logStep(1, "entry_url", "forced unread entry", {
          URL_BEFORE: urlBefore,
          URL_AFTER_GOTO: urlAfterGoto,
          URL_AFTER_1S: urlAfter1s,
          shellReady: shellReadiness.ok,
          title: shellReadiness.details.title,
          searchInputCounts: shellReadiness.details.searchInputCounts,
          listContainerCounts: shellReadiness.details.listContainerCounts,
          participantNamesCount: shellReadiness.details.participantNamesCount,
          convoItemLinkCount: shellReadiness.details.convoItemLinkCount,
          conversationListItemCount: shellReadiness.details.conversationListItemCount
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
        if (!activeAfter) {
          fail("collect_threads", "unread_filter_not_active", "LinkedIn Unread filter did not become active.");
        }

        await logStep(3, "list_ready", "waiting for unread rows or empty state");
        const settleDeadline = Date.now() + 12_000;
        let emptyStateDetected = false;
        let emptyStateMatches: string[] = [];
        let settledRows: LinkedInDiscoveredUnreadRowsResult = {
          namesCount: 0,
          clickTargetsCount: 0,
          primaryClickTargetsCount: 0,
          rows: []
        };

        while (Date.now() < settleDeadline) {
          settledRows = await discoverLinkedInUnreadRows(page);
          if (settledRows.namesCount > 0 || settledRows.clickTargetsCount > 0) {
            break;
          }

          const emptyState = await detectLinkedInUnreadEmptyState(page);
          if (emptyState.detected) {
            emptyStateDetected = true;
            emptyStateMatches = emptyState.matches;
            break;
          }

          await page.waitForTimeout(220);
        }

        if (!emptyStateDetected && settledRows.namesCount <= 0 && settledRows.clickTargetsCount <= 0) {
          const emptyState = await detectLinkedInUnreadEmptyState(page);
          emptyStateDetected = emptyState.detected;
          emptyStateMatches = emptyState.matches;
        }

        const probe = await dumpLinkedInUnreadListProbe({
          page,
          logDir: input.logDir,
          discoveredRows: settledRows,
          emptyStateMatches
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
          namesCount: settledRows.namesCount,
          clickTargetsCount: settledRows.clickTargetsCount,
          unreadCounterCounts,
          unreadCounterValues: unreadCounterValues.slice(0, 5),
          emptyStateDetected
        });

        const classification = classifyLinkedInSmokeUnreadOutcome({
          emptyStateDetected,
          namesCount: settledRows.namesCount,
          clickTargetsCount: settledRows.clickTargetsCount,
          listContainerChildCount,
          unreadCounterValues
        });

        if (classification.outcome === "EMPTY") {
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
              namesCount: settledRows.namesCount,
              clickTargetsCount: settledRows.clickTargetsCount,
              primaryClickTargetsCount: settledRows.primaryClickTargetsCount,
              listContainerChildCount,
              unreadCounterValues,
              emptyStateDetected
            }
          };
        }

        if (classification.outcome === "MISMATCH") {
          await logStep(3, "list_ready", linkedInSmokeSelectorMismatchError, {
            namesCount: settledRows.namesCount,
            clickTargetsCount: settledRows.clickTargetsCount,
            listContainerChildCount,
            unreadCounterValues: unreadCounterValues.slice(0, 5)
          });
          fail("collect_threads", classification.reason ?? "selector_mismatch_thread_rows", linkedInSmokeSelectorMismatchError, {
            namesCount: settledRows.namesCount,
            clickTargetsCount: settledRows.clickTargetsCount,
            listContainerChildCount,
            unreadCounterValues
          });
        }

        const discoveredHandles = await discoverLinkedInUnreadRowsWithHandles(page);
        if (!discoveredHandles.rows[0]) {
          fail("collect_threads", "selector_mismatch_thread_rows", linkedInSmokeSelectorMismatchError, {
            namesCount: discoveredHandles.namesCount,
            clickTargetsCount: discoveredHandles.clickTargetsCount
          });
        }
        const firstRow = discoveredHandles.rows[0]!;

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
          platformThreadId: threadMeta.stableKey,
          displayName: threadMeta.participantName,
          lastMessagePreview: threadMeta.previewSnippet ?? cleanText(messages.at(-1)?.text ?? ""),
          lastMessageAt: threadMeta.listTimestamp,
          threadUrl: threadMeta.threadUrl,
          unreadCount,
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
            const discoveredRows = await discoverLinkedInUnreadRows(page);
            const fallbackProbe = await dumpLinkedInUnreadListProbe({
              page,
              logDir: input.logDir,
              discoveredRows,
              emptyStateMatches: []
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

  async scanUnreadThreads(): Promise<ThreadStub[]> {
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

            const unreadFilterResult = await runStage("unread_filter", async () => {
              return this.ensureUnreadFilterActive(page, selectors);
            });

            const collected = await runStage(
              "collect_threads",
              async () => this.collectThreadRowsWithScroll(page, selectors, this.deps.scanMaxThreads),
              {
                unreadFilterResult: { ...unreadFilterResult },
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

            const unreadCandidates = collected.rows.filter((thread) => (thread.unreadCount ?? 0) > 0);
            runCounters.unreadViewActive = unreadFilterResult.pillPresent && unreadFilterResult.waitReason !== "pill_missing";
            runCounters.threadsVisibleCount = collected.rows.length;
            runCounters.threadsCollectedTotal = collected.rows.length;
            runCounters.threadsWithUnreadBadgeCount = unreadCandidates.length;
            runCounters.candidatesToOpenCount = unreadCandidates.length;
            runCounters.scrollIterations = collected.scrollIterations;
            runCounters.noProgressStreak = collected.noProgressStreak;
            runCounters.stopReason = collected.stopReason;
            runCounters.recoveryAttemptsUsed = recoveryAttempts;
            this.runLogger?.mergeCounters({ ...runCounters });

            this.logTraceDecision({
              stage: "collect_threads",
              decision: runCounters.unreadViewActive
                ? "Unread pill active => unread badge filtering used"
                : "Unread badge filtering used",
              details: {
                threadsCollectedTotal: runCounters.threadsCollectedTotal,
                unreadCandidatesCount: runCounters.candidatesToOpenCount
              }
            });

            if (runCounters.candidatesToOpenCount === 0 && runCounters.unreadViewActive) {
              this.logTraceDecision({
                stage: "collect_threads",
                level: "warn",
                decision: "Candidate selection empty => failing with reason unread_candidates_empty_in_unread_view",
                details: {
                  reason: "unread_candidates_empty_in_unread_view",
                  threadsVisibleCount: runCounters.threadsVisibleCount
                }
              });
            }

            this.lastCollectionMetrics = {
              totalFound: collected.rows.length,
              unreadFound: unreadCandidates.length,
              iterations: collected.iterations,
              stopReason: collected.stopReason
            };
            return unreadCandidates.map((thread) => ({ ...thread, isUnreadCandidate: true }));
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

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
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
          Math.max(limit, this.deps.scanMaxThreads)
        );
        this.lastCollectionMetrics = {
          totalFound: collected.rows.length,
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
