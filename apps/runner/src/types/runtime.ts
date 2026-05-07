import type {
  AppSettings,
  PlatformName,
  PlatformStatus,
  RunnerEvent,
  SelectorOverrideStore,
  SelectorRegistry,
  SelectorTestReport,
  SummaryOutput,
  SuggestedRepliesOutput,
  ThreadStub
} from "@inbox-os/core";

export interface PlatformSnapshot {
  platform: PlatformName;
  status: PlatformStatus;
  lastScanAt?: string;
  lastError?: string;
  connectedAt?: string;
  degradedReason?: string;
}

export type RunnerEventInput = {
  [Type in RunnerEvent["type"]]: Omit<Extract<RunnerEvent, { type: Type }>, "eventId" | "at"> &
    Partial<Pick<Extract<RunnerEvent, { type: Type }>, "at">>;
}[RunnerEvent["type"]];

export interface DemoSeedManifest {
  seededAt: string;
  personIds: string[];
  threadIds: string[];
  logIds: string[];
  screenshotFiles: string[];
  domDumpFiles: string[];
}

export interface EventBus {
  nextEventId(): number;
  emit(event: RunnerEventInput): RunnerEvent;
  subscribe(listener: (event: RunnerEvent) => void): () => void;
  listSince(eventId?: number): RunnerEvent[];
  newestEventId(): number;
  oldestEventId(): number;
}

export interface SettingsStore {
  getSettings(): Promise<AppSettings>;
  updateSettings(partial: Partial<AppSettings>): Promise<AppSettings>;
  getSelectorOverrides(): Promise<SelectorOverrideStore>;
  saveSelectorOverride(platform: PlatformName, key: keyof SelectorRegistry, selector: string): Promise<void>;
  resetSelectorOverride(platform: PlatformName, key: keyof SelectorRegistry): Promise<void>;
  getDemoSeedManifest(): Promise<DemoSeedManifest | null>;
  setDemoSeedManifest(manifest: DemoSeedManifest | null): Promise<void>;
}

export interface AiService {
  updateThreadSummary(input: {
    displayName: string;
    previousSummary?: string;
    previousOpenLoops: string[];
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
  }): Promise<SummaryOutput>;
  generateSuggestedReplies(input: {
    summary: string;
    whatTheyWant: string;
    openLoops: string[];
    lastInboundMessage: string;
    /** When "outreach", reply C is a Polite decline instead of a Clarifying question. */
    category?: "outreach" | "genuine" | null;
  }): Promise<SuggestedRepliesOutput>;
  transformReply(input: {
    mode: "SHORTEN" | "MAKE_WARMER";
    text: string;
  }): Promise<string>;
  /**
   * Coarsely classify a thread as either "outreach" (cold pitches, sales,
   * recruitment, marketing, InMails) or "genuine" (peer chats, real
   * relationships). Returns null when the AI service is unavailable or the
   * classification isn't confident enough — callers should treat null as
   * "leave the column unset".
   */
  classifyThreadCategory(input: {
    displayName: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    /** Pass the thread's rollingSummary so classifier can spot a pivot pattern. */
    summary?: string | null;
    /** Pass the thread's whatTheyWant for additional intent signal. */
    whatTheyWant?: string | null;
  }): Promise<"outreach" | "genuine" | null>;
  /**
   * Short paragraph (2-3 sentences) that introduces a contact based on
   * their LinkedIn profile data and any obvious commonality with the
   * operator's own profile. Returns null when the AI service is
   * unavailable so callers can decide whether to surface a placeholder
   * or skip the section.
   */
  generateContactSummary(input: {
    contact: ContactProfileSnapshot;
    self: ContactProfileSnapshot | null;
  }): Promise<string | null>;
  /**
   * 2-3 short conversation openers grounded in real fields from the
   * contact's profile. Each opener cites which enrichment field it drew
   * from in `citedField`; the orchestration layer then verifies that
   * field is non-empty as an anti-hallucination check before persisting.
   */
  generateConversationStarters(input: {
    contact: ContactProfileSnapshot;
    self: ContactProfileSnapshot | null;
  }): Promise<ConversationStartersOutput | null>;
}

/**
 * Lightweight projection of a person's enrichment that the AI prompts
 * read. Defined here (rather than imported from `@inbox-os/core`) so the
 * AI surface stays decoupled from the Prisma row shape.
 */
export interface ContactProfileSnapshot {
  displayName?: string;
  headline?: string | null;
  about?: string | null;
  location?: string | null;
  currentCompany?: string | null;
  currentRole?: string | null;
  experience?: Array<{ title?: string | null; company?: string | null; dates?: string | null; description?: string | null }>;
  education?: Array<{ institution?: string | null; degree?: string | null; field?: string | null; dates?: string | null }>;
  skills?: string[];
  services?: string[];
  recentPosts?: Array<{ text?: string | null; postedAt?: string | null; hasImage?: boolean }>;
}

/**
 * Allowed values for `citedField`. Kept narrow on purpose — the runtime
 * citation check resolves these to enrichment fields before persisting.
 * If a model invents a value outside this set, the check drops the
 * starter.
 */
export type ConversationStarterCitedField =
  | "headline"
  | "about"
  | "experience"
  | "education"
  | "skills"
  | "services"
  | "recent_posts"
  | "location";

export interface ConversationStarterDraft {
  angle: string;
  citedField: ConversationStarterCitedField;
  text: string;
}

export interface ConversationStartersOutput {
  starters: ConversationStarterDraft[];
}

export interface PlatformDiagnosticsError extends Error {
  screenshotFile?: string;
  domDumpFile?: string;
}

export interface PlatformContext {
  resolveSelectors(platform: PlatformName): Promise<SelectorRegistry>;
  getSettings(): Promise<AppSettings>;
  onDegraded(input: {
    platform: PlatformName;
    reason: string;
    action: string;
    screenshotFile?: string;
    domDumpFile?: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  onAudit(input: {
    platform?: PlatformName;
    stage?: string;
    action: string;
    status: "OK" | "FAIL";
    details?: Record<string, unknown>;
    screenshotFile?: string;
    domDumpFile?: string;
  }): Promise<string>;
}

export interface ScanJobOutcome {
  jobId: string;
  updatedThreads: number;
}

export interface SelectorTestStore {
  setReport(report: SelectorTestReport): void;
  getLatestReport(platform: PlatformName): SelectorTestReport | undefined;
}

export interface OpenThreadTarget {
  threadId: string;
  platform: PlatformName;
  platformThreadId: string;
  threadUrl?: string;
  displayName: string;
}

export interface MergeableThreadStub extends ThreadStub {
  candidateReason: "UNREAD" | "RECENT";
}
