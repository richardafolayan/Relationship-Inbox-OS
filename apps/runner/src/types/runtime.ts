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
    /**
     * ISO timestamps of the most recent inbound + outbound messages.
     * When the operator is replying late (gap ≥ 14d, inbound newer than
     * outbound), the prompt injects an acknowledgement instruction so
     * the suggested replies open with "Sorry it's been ages…" rather
     * than ignoring the elephant in the room.
     */
    lastInboundAt?: string | null;
    lastOutboundAt?: string | null;
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
  /**
   * Take a brief operator-supplied intent ("ask about availability next
   * week", "decline politely", "say I'm interested") and rewrite it as
   * a sendable message in the operator's voice — calibrated against the
   * outbound history of THIS thread so register and warmth match how
   * they've previously written to this person. The fallback returns the
   * intent unchanged so the composer never goes empty.
   */
  composeInVoice(input: {
    intent: string;
    displayName: string;
    /** Recent outbound messages from THIS thread, oldest first. Used as
     *  voice samples — register, warmth, vocabulary. */
    voiceSamples: string[];
    /** The full thread for context. Recent inbound message in particular
     *  drives whether the rewrite should reference / acknowledge anything. */
    threadMessages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    /**
     * Cross-thread context for the same Person. Drives "don't repeat
     * questions answered elsewhere" and "match the warmth you've used
     * with them before". Optional — composeInVoice falls back to
     * thread-only context when omitted.
     */
    relationshipContext?: {
      otherThreadCount: number;
      recentExchanges: Array<{
        platform: string;
        lastMessageAt: string | null;
        preview: string | null;
        whatTheyWant: string | null;
      }>;
      notes: string | null;
      tags: string[];
    };
  }): Promise<string>;
  /**
   * Suggest up to 3 snooze targets grounded in the conversation. Picks
   * up explicit time hints in the latest inbound ("let's chat next
   * Tuesday", "I'm OOO until the 15th") and turns them into a snooze
   * duration. Returns an empty list when no time hint is present —
   * never fabricates a hint.
   */
  suggestSnoozeTimings(input: {
    displayName: string;
    lastInboundText: string;
    lastInboundAt: string | null;
    summary?: string | null;
    whatTheyWant?: string | null;
  }): Promise<SnoozeSuggestionsOutput>;
}

export interface SnoozeSuggestion {
  /** Operator-friendly label for the chip, e.g. "Tue 9am" or "Mon morning". */
  label: string;
  /** Snooze duration in hours. Snapped to the nearest hour by the route. */
  hours: number;
  /** Why the AI picked this duration — surfaced in receipts + tooltip. */
  reason: string;
}

export interface SnoozeSuggestionsOutput {
  suggestions: SnoozeSuggestion[];
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
