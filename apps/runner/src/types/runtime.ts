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
  RememberItem,
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
  getOperatorProfile(): Promise<OperatorProfile>;
  updateOperatorProfile(partial: Partial<OperatorProfile>): Promise<OperatorProfile>;
}

/** Reply tone the operator picks during voice setup. "" = not chosen yet. */
export type ReplyStyle = "warm" | "direct" | "casual" | "thoughtful" | "concise";

/**
 * How much writing help the operator wants. Drives what the dashboard
 * surfaces — never disables summaries / open loops / action items.
 *   - memory_only:     context, summaries, things to address only
 *   - writing_support: + rewrite ("shorten" / "warmer") on the operator's draft
 *   - full_drafts:     + complete AI-suggested replies and compose-from-intent
 */
export type AiHelpLevel = "memory_only" | "writing_support" | "full_drafts";

/**
 * The operator's voice + identity profile. The AI prompts consume it so
 * suggested replies and voice rewrites sound like the current user (not a
 * hardcoded persona) and stay within their domain. Stored as a JSON
 * `Setting` row, so new fields need no schema migration. Distinct from the
 * LinkedIn-derived self snapshot (which lives behind `SelfProfileService`).
 *
 * All string fields default to "" meaning "not set" — an empty profile
 * makes the AI fall back to a plain, neutral voice rather than any persona.
 */
export interface OperatorProfile {
  /** What the operator is called — used for the Today greeting and AI voice. */
  displayName: string;
  /** Free-text description of how the operator usually messages people. */
  about: string;
  /** Things the operator cares about — keeps replies in-domain. */
  interests: string;
  /** Words / phrases the operator uses often (free text, newline-separated). */
  commonPhrases: string;
  /** Words / phrases the operator never uses (free text, newline-separated). */
  avoidedPhrases: string;
  /** Preferred reply tone. "" until the operator picks one. */
  preferredStyle: ReplyStyle | "";
  /** How much AI writing help to surface. Defaults conservative. */
  aiHelpLevel: AiHelpLevel;
  /** ISO timestamp the operator finished first-run setup. "" = not done. */
  setupCompletedAt: string;
}

export interface AiService {
  updateThreadSummary(input: {
    displayName: string;
    previousSummary?: string;
    previousOpenLoops: string[];
    /** Last persisted remember items — kept as the fallback if the AI call fails. */
    previousRemember: RememberItem[];
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    /** Drives mode-aware framing: when false, what_they_want and open_loops are reframed as reconnect hooks. */
    needsReply: boolean;
  }): Promise<SummaryOutput>;
  generateSuggestedReplies(input: {
    summary: string;
    whatTheyWant: string;
    openLoops: string[];
    /** Last ~6 turns oldest-first. Lets the model see the operator's own recent
     *  replies and respond to the actual conversational turn. Also calibrates
     *  voice register against the operator's recent OUT entries here. */
    recentMessages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    /** False = no pending reply; the prompt switches to "reopen mode" and
     *  generates conversation starters grounded in transcript details. */
    needsReply: boolean;
    /**
     * Drives the voice tier (LinkedIn → formal; everything else → casual)
     * so suggested replies sit in the right register. When omitted, the
     * generic SYSTEM_PROMPT is used without a voice-tier overlay.
     */
    platform?: PlatformName | null;
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
    /**
     * Free-text operator self-description from Settings. When present,
     * the model uses it to keep replies in-domain (don't promise things
     * the operator doesn't do; reference shared interests when relevant).
     */
    operatorProfile?: OperatorProfile | null;
    /**
     * Compressed snapshot of the contact's enrichment (headline, about,
     * recent posts, experience). When present, replies can ground in
     * something specific the contact has shared.
     */
    contact?: ContactProfileSnapshot | null;
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
    /** Drives prompt tier — LinkedIn uses InMail / recruiter / SaaS-pitch
     * patterns; casual platforms use bulk-broadcast / spam / cold-DM
     * patterns. Output enum stays the same across both tiers. */
    platform: PlatformName;
    displayName: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    /** Pass the thread's rollingSummary so classifier can spot a pivot pattern. */
    summary?: string | null;
    /** Pass the thread's whatTheyWant for additional intent signal. */
    whatTheyWant?: string | null;
  }): Promise<"outreach" | "genuine" | null>;
  /**
   * Conversation-end verdict (#287 phase 2.5). "closed" = last inbound
   * reads as a natural endpoint with no implicit ask, "open" = operator
   * still owes a reply. Null when the AI service is unavailable so the
   * dashboard heuristic stays in charge. Cheap to call (last 3 turns +
   * summary, ~150 tokens in); cache the verdict by last-inbound hash.
   */
  classifyThreadClosed(input: {
    displayName: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    summary?: string | null;
  }): Promise<"closed" | "open" | null>;
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
    /** Cold-opener generation is LinkedIn-only — non-formal tiers return
     * null (the People page hides the section). The underlying snapshot
     * fields are LinkedIn-shaped and PersonEnrichment is only populated
     * for LinkedIn anyway. */
    platform: PlatformName;
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
    /** Drives the voice tier (LinkedIn → formal; everything else → casual-DM). */
    platform: PlatformName;
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
    /**
     * Free-text operator self-description from Settings. Same purpose as
     * for generateSuggestedReplies — keeps the rewrite in-domain and
     * reflective of what the operator actually cares about.
     */
    operatorProfile?: OperatorProfile | null;
    /** Contact's enrichment snapshot — lets the rewrite reference the
     *  recipient's headline, recent posts, etc. when the operator's intent
     *  is light on detail. */
    contact?: ContactProfileSnapshot | null;
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
  /**
   * Per-person friendship summary - four sections covering how the
   * operator knows the contact, recent topics, inside jokes / running
   * threads, and the vibe of the relationship. Operates on the union of
   * messages across every thread the operator has with this person.
   * Used by the iMessage profile drawer.
   */
  summarisePersonForFriendship(input: {
    displayName: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
  }): Promise<FriendshipSummaryOutput>;
  /**
   * Free-form Q&A about a person. Grounded in messages, enrichment, and
   * operator notes / tags. Hard rule: only answers from provided context;
   * cites specific dates from message timestamps when relevant. Empty
   * question returns empty answer.
   */
  askAboutPerson(input: {
    displayName: string;
    question: string;
    messages: Array<{ direction: "IN" | "OUT"; text: string; timestamp: string }>;
    contact?: ContactProfileSnapshot | null;
    notes?: string | null;
    tags?: string[];
  }): Promise<{ answer: string }>;
  /**
   * Optional triage of a pilot bug / feedback report. Turns the tester's
   * own words plus safe metadata into a short developer summary, a likely
   * app area, a severity, and repro steps. Operates ONLY on the typed
   * report and metadata — never on screenshots or message content.
   * Returns null when the AI service is unavailable; the raw report is
   * always kept regardless.
   */
  summarisePilotReport(input: {
    type: string;
    title: string;
    description: string;
    expected: string;
    meta: Record<string, unknown>;
  }): Promise<PilotReportTriage | null>;
}

export interface PilotReportTriage {
  /** 1-2 sentence developer-facing summary. */
  summary: string;
  /** Likely area of the app, e.g. "Thread page" or "LinkedIn scan". */
  area: string;
  severity: "low" | "medium" | "high";
  /** Short ordered repro steps. Empty when the report is not a bug. */
  repro: string[];
}

export interface FriendshipSummaryOutput {
  how_you_know_each_other: string;
  recent_topics: string[];
  inside_jokes: string[];
  vibe: string;
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
