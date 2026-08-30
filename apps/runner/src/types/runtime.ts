import type {
  AiProvider,
  AppSettings,
  PlatformName,
  PlatformStatus,
  ReplyBrief,
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

/**
 * Shape every AI context builder accepts for the message log. The
 * legacy fields are unchanged so callers compile without touching the
 * type; `audioTranscription` is additive and optional and lets the
 * runner weave a voice-note transcript into prompts via the
 * renderMessageBody helper in services/ai.ts.
 */
export interface MessageForPrompt {
  direction: "IN" | "OUT";
  text: string;
  timestamp: string;
  /**
   * Group chats (#753): the resolved name of the specific sender of an IN
   * message, so prompt transcripts can attribute each group turn to the
   * right person instead of one generic contact label. Absent/null on 1:1
   * threads and on historical rows.
   */
  senderName?: string | null;
  audioTranscription?: {
    status: string;
    transcript: string | null;
  } | null;
  /**
   * iMessage tapbacks / reactions on this message, surfaced to the AI so
   * it knows when the operator reacted with ❤️ (etc.) instead of typing
   * a reply, or when the contact reacted to one of the operator's
   * messages. Optional — non-iMessage adapters and historical rows have
   * no reactions. The AI prompt builder (formatMessageForPrompt /
   * renderMessageBody in services/ai.ts) appends a "[operator reacted
   * ❤️]" annotation when present. See services/reaction-effects.ts for
   * the parser and helpers.
   */
  reactions?: Array<{
    direction: "IN" | "OUT";
    emoji: string;
    kind: "love" | "like" | "dislike" | "laugh" | "emphasis" | "question";
    timestamp?: string;
  }>;
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
  acknowledgeFocusWindowPerson(windowId: string, personId: string): Promise<boolean>;
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
/**
 * Who a focus window's acknowledgements cover. "favourites" (the safe
 * default) only ever touches starred contacts; "all_personal" widens to
 * any saved personal contact but still never to unknown numbers, spam, or
 * business/outreach threads. Mirrors the dashboard `FocusAudience`.
 */
export type FocusAudience = "favourites" | "all_personal";

/**
 * Focus Reply Buffer state. A single "heads-down" window the operator opens
 * from Today / the top bar / Settings: while it's active, a covered contact
 * who messages can get a one-tap acknowledgement ("seen this, I'll reply
 * properly after") so silence doesn't read as being ignored. A manually
 * started window may explicitly opt into sending that saved note once per
 * covered person. The note is the operator's own words with plain token
 * substitution; "Help me phrase this" can draft it in their voice on
 * explicit request, and it stays editable before use.
 * One window at a time; persisted in the operator profile JSON so every
 * dashboard surface (and a reload) reads the same state.
 */
export interface FocusWindowState {
  /** True while a window is open. The dashboard surfaces read this. */
  active: boolean;
  /** ISO timestamp the window started. "" when no window has run. Inbound
   *  messages newer than this on covered threads are "arrived during focus". */
  startedAt: string;
  /** ISO timestamp the operator chose to resurface. "" when unset. Fills
   *  the [until] token and the "active until …" copy. */
  endsAt: string;
  /** Optional short reason ("deep work", "lecture"). "" = none. */
  reason: string;
  /** Live note text shown in the setup sheet (close-tier base with tokens). */
  note: string;
  /** Per-window professional-tier note override ("Help me phrase this"
   *  writes one per register). "" = none, professional contacts fall back
   *  to the saved ackTemplates.professional. Added after the feature
   *  shipped, so older profile rows parse fine (coerced to ""). */
  professionalNote: string;
  /** Who this window covers. */
  audience: FocusAudience;
  /** Opaque id stamping this window, so per-window ack dedupe is unambiguous. */
  windowId: string;
  /** Person ids already acknowledged in this window (one note per person). */
  ackedPersonIds: string[];
  /** True only when the operator opted in for this specific window. */
  autoSendAcknowledgements: boolean;
  /** What opened this window. "manual" = the operator started it by hand;
   *  "calendar" = the calendar auto-focus service opened it for a live event
   *  (issue #786). Older profile rows have no field and coerce to "manual".
   *  The auto-focus service never touches a "manual" window, so a hand-started
   *  block always wins over the calendar. */
  source: FocusWindowSource;
  /** For a "calendar" window, a stable id for the specific event occurrence
   *  that opened it. Ending an auto-window stops it re-opening for THIS
   *  occurrence, while a later occurrence of the same event still triggers a
   *  fresh window. "" for manual windows. */
  sourceEventKey: string;
}

/** What opened a focus window: by hand, or by the calendar auto-focus service. */
export type FocusWindowSource = "manual" | "calendar";

/**
 * The operator's two acknowledgement note templates, in their own words.
 * The app only picks which tier fits a contact and fills [Name]/[until]/
 * [reason] — it never writes the words.
 */
export interface AckTemplates {
  /** Friends / family — casual. */
  close: string;
  /** Professional contacts — calmer, still the operator's voice. */
  professional: string;
}

/** Focus Reply Buffer preferences (not the live window). */
export interface FocusSettings {
  /** Include a reason word in the note so it reads as a real block. */
  reasonLabel: boolean;
  /** If someone messages twice in one window, only acknowledge once. */
  oneNotePerPerson: boolean;
  /** Default audience pre-selected when starting a new window. */
  audience: FocusAudience;
}

/**
 * Calendar auto-focus (issue #786, pilot R-0097). The operator pastes the
 * read-only "secret address in iCal format" URL that Google / Apple / Outlook
 * calendars all expose; the runner subscribes to that feed and auto-opens a
 * Focus window while an event is live, so heads-down blocks start on their
 * own. Read-only, no OAuth, no cloud project. An auto-opened window uses the
 * saved profile and keeps automatic acknowledgements off unless the active
 * window explicitly enables them.
 */
export interface CalendarSyncSettings {
  /** The first secret iCal (ICS) feed URL. "" = not configured. Kept as a
   *  scalar so profiles saved by the first calendar release still load. */
  url: string;
  /** Further calendar feeds. Google exposes one secret address per calendar,
   *  so operators with separate work / study / personal calendars can opt in
   *  only the calendars that should activate focus. */
  additionalUrls: string[];
  /** Master switch. Even with a URL saved, nothing runs until this is on. */
  enabled: boolean;
  /** Optional case-insensitive title filter. "" = every busy timed event
   *  triggers focus; otherwise only events whose title contains this word. */
  keyword: string;
  /** Audience an auto-opened window covers (same choices as a manual one). */
  audience: FocusAudience;
  /** Explicit opt-in to run the existing "Help me phrase this" composer with
   *  the live event title and save its two editable note variants on the
   *  window. Off by default: AI drafts remain optional. */
  phraseWithAi: boolean;
}

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
  /** Focus Reply Buffer: the live window state. Added after the voice
   *  fields, so a pre-existing profile row parses fine (defaults below). */
  focusWindow: FocusWindowState;
  /** Focus Reply Buffer: the operator's two note templates. */
  ackTemplates: AckTemplates;
  /** Focus Reply Buffer: preferences (reason label, one-note-per-person, audience). */
  focusSettings: FocusSettings;
  /** Calendar auto-focus subscription (issue #786). Added last, so older
   *  profile rows parse fine (coerced to the disabled default). */
  calendarSync: CalendarSyncSettings;
}

/**
 * The subset of OperatorProfile that reply-style analysis (issue #438) can
 * infer from the operator's own sent messages. Identity (displayName) and
 * the aiHelpLevel preference are deliberately excluded — analysis never
 * touches them.
 */
export type InferredReplyStyle = Pick<
  OperatorProfile,
  "about" | "preferredStyle" | "commonPhrases" | "avoidedPhrases" | "interests"
>;

/**
 * Observed writing style measured from a set of real messages (one
 * speaker's). Computed at runtime by `analyzeStyle` in services/style —
 * never hardcoded — and rendered into the draft prompts so suggestions
 * adapt to how the operator and each contact actually write (issue
 * #299). Distinct from `OperatorProfile`, which is operator-typed text.
 */
export interface StyleProfile {
  /** Non-empty messages the profile was measured from. */
  sampleCount: number;
  /** Mean words per message. */
  avgWords: number;
  /** Bucketed `avgWords` for prompt phrasing. */
  lengthLabel: "very short" | "short" | "medium" | "longer";
  /** Mean whole-emoji count per message. */
  emojiPerMessage: number;
  /** Most-used emoji, most frequent first, capped at 5. */
  topEmojis: string[];
  /** 0..1 share of messages that close a sentence with a full stop. */
  fullStopRate: number;
  /** 0..1 share of letter-leading messages whose first letter is lowercase. */
  lowercaseRate: number;
}

export interface DictationMessageFormatting {
  cleanedTranscript: string;
  messages: Array<{ id: string; text: string }>;
  warnings: Array<{ originalText: string; reason: string }>;
  source?: {
    providerId: AiProvider;
    providerDisplayName: string;
    model: string;
  };
}

export interface DictationVoiceProfile {
  displayName: string;
  about: string;
  commonPhrases: string;
  avoidedPhrases: string;
  preferredStyle: ReplyStyle | "";
  acceptedExamples: Array<{ messages: string[] }>;
}

export interface AiService {
  updateThreadSummary(input: {
    /** Group chat flags (#753). */
    isGroup?: boolean;
    groupName?: string | null;
    /** Contact's name (used in fallback summary text). */
    displayName: string;
    previousSummary?: string;
    previousOpenLoops: string[];
    /** Last persisted remember items — kept as the fallback if the AI call fails. */
    previousRemember: RememberItem[];
    messages: MessageForPrompt[];
    /** Drives mode-aware framing: when false, what_they_want and open_loops are reframed as reconnect hooks. */
    needsReply: boolean;
    /**
     * Race two providers and keep the first valid result (issue #382 —
     * pilot R-0029). Operator-initiated paths only — doubles provider
     * spend per raced call.
     */
    race?: boolean;
  }): Promise<SummaryOutput>;
  generateSuggestedReplies(input: {
    /** Group chat flags (#753). */
    isGroup?: boolean;
    groupName?: string | null;
    /** Contact's name — injected as the prompt's authoritative `Recipient:`
     *  line so the model names the contact instead of falling back to the
     *  CONTACT_NAME_DISCIPLINE example name. */
    displayName: string;
    summary: string;
    whatTheyWant: string;
    openLoops: string[];
    /** Last ~6 turns oldest-first. Lets the model see the operator's own recent
     *  replies and respond to the actual conversational turn. Also calibrates
     *  voice register against the operator's recent OUT entries here. */
    recentMessages: MessageForPrompt[];
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
    /**
     * Writing style measured from the operator's own recent messages on
     * THIS thread. Calibrates length, punctuation, capitalisation, and
     * emoji to how the operator actually writes to this contact. Null
     * when there isn't enough history (issue #299).
     */
    operatorStyle?: StyleProfile | null;
    /**
     * Writing style measured from the contact's own recent messages on
     * THIS thread. Reinforces the reciprocity rule with concrete numbers
     * to mirror. Null when there isn't enough history.
     */
    contactStyle?: StyleProfile | null;
    /**
     * The compressed reply brief from the most recent thread analysis.
     * When present, the prompt feeds the substance bullets (they_said)
     * and the obligation read (on_you) into the model so the generated
     * replies engage with every reply-relevant beat — not just the first
     * surface point. Null on cold paths (cache hit before brief
     * generation, or AI summary failed and synthesised fallback has no
     * substance to carry).
     */
    replyBrief?: ReplyBrief | null;
  }): Promise<SuggestedRepliesOutput>;
  formatDictationMessages(input: {
    transcript: string;
    contactName?: string | null;
    operatorProfile?: DictationVoiceProfile | null;
    recentInbound?: {
      messageCount: number;
      totalCharacters: number;
      averageCharacters: number;
    } | null;
  }): Promise<DictationMessageFormatting | null>;
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
    messages: MessageForPrompt[];
    /** Pass the thread's rollingSummary so classifier can spot a pivot pattern. */
    summary?: string | null;
    /** Pass the thread's whatTheyWant for additional intent signal. */
    whatTheyWant?: string | null;
    /**
     * Race two providers and keep the first valid classification (issue
     * #382 — pilot R-0029). Operator-initiated paths only.
     */
    race?: boolean;
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
    messages: MessageForPrompt[];
    summary?: string | null;
  }): Promise<{ status: "closed" | "open"; reason: string } | null>;
  /**
   * Reconnect-worthy scorer (#287 phase 3.5). Returns a 0-100 integer
   * plus a one-sentence reason for how worth it would feel to send the
   * LinkedIn dormant a deliberate "hey, been a while" message today.
   * Null when the AI provider was unavailable; the dashboard ranks
   * dormants by deterministic signals alone in that case.
   */
  scoreReconnectCandidate(input: {
    displayName: string;
    contactBlurb?: string | null;
    daysDormant: number;
    operatorOutboundCount: number;
    totalMessageCount: number;
    messages: MessageForPrompt[];
    summary?: string | null;
  }): Promise<{ score: number; reason: string } | null>;
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
   * they've previously written to this person. Runtime provider failures walk
   * the configured fallback chain before returning the intent unchanged.
   */
  composeInVoice(input: {
    /** Group chat flags (#753). */
    isGroup?: boolean;
    groupName?: string | null;
    intent: string;
    /** Drives the voice tier (LinkedIn → formal; everything else → casual-DM). */
    platform: PlatformName;
    displayName: string;
    /** Recent outbound messages from THIS thread, oldest first. Used as
     *  voice samples — register, warmth, vocabulary. */
    voiceSamples: string[];
    /** The full thread for context. Recent inbound message in particular
     *  drives whether the rewrite should reference / acknowledge anything. */
    threadMessages: MessageForPrompt[];
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
    /** Writing style measured from the operator's own recent messages on
     *  this thread — calibrates length, punctuation, capitalisation, and
     *  emoji to how the operator writes to this contact (issue #299). */
    operatorStyle?: StyleProfile | null;
    /** Writing style measured from the contact's own recent messages —
     *  concrete numbers for the reciprocity match. */
    contactStyle?: StyleProfile | null;
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
   * Issue #392. Parse a free-text "remind me to…" intent typed by the
   * operator into { remindAtIso, reminderText, confidence } so the
   * thread can be snoozed until the parsed time with the reminder note
   * attached. Returns { confidence: "low" } when the time hint is
   * ambiguous or missing — caller surfaces the parse back to the
   * operator rather than guessing.
   */
  parseReminderRequest(input: {
    intent: string;
    referenceTimeIso: string;
    displayName: string;
  }): Promise<{
    remindAtIso: string | null;
    reminderText: string;
    confidence: "high" | "low";
    reason?: string;
  }>;
  /**
   * Per-person friendship summary - four sections covering how the
   * operator knows the contact, recent topics, inside jokes / running
   * threads, and the vibe of the relationship. Operates on the union of
   * messages across every thread the operator has with this person.
   * Used by the iMessage profile drawer.
   */
  summarisePersonForFriendship(input: {
    /** Contact's name (the person being characterised). */
    displayName: string;
    messages: MessageForPrompt[];
  }): Promise<FriendshipSummaryOutput>;
  /**
   * Free-form Q&A about a person. Grounded in messages, enrichment, and
   * operator notes / tags. Hard rule: only answers from provided context;
   * cites specific dates from message timestamps when relevant. Empty
   * question returns empty answer.
   */
  askAboutPerson(input: {
    /** Contact's name (the person being asked about). */
    displayName: string;
    question: string;
    messages: MessageForPrompt[];
    contact?: ContactProfileSnapshot | null;
    notes?: string | null;
    tags?: string[];
    /** True when the message window hit its cap and older history was cut. */
    transcriptTruncated?: boolean;
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
  /**
   * Issue #331. Reads the operator's in-flight draft against the active
   * open loops and returns per-loop verdicts. "addressed" loops are the
   * ones the draft genuinely answers; "partial" loops are mentioned but
   * not actually answered, and carry a short `reason` naming what's
   * still missing. Loops the draft doesn't touch at all are omitted.
   * Returns an empty items array when the AI service is unavailable so
   * the UI never blocks on a failure.
   */
  checkDraftCoverage(input: {
    displayName: string;
    draft: string;
    openLoops: string[];
    recentMessages: MessageForPrompt[];
  }): Promise<{ items: Array<{ loop: string; status: "addressed" | "partial"; reason?: string }> }>;
  /**
   * Issue #438 (pilot R-0059). Infer the operator's reply-style fields from a
   * sample of their OWN sent messages so Settings can prefill the form.
   * `sampleTexts` are pre-filtered operator sends (see
   * services/reply-style-analysis). `aiRan` is false when no provider was
   * reachable, letting the caller tell "AI down" apart from "nothing to
   * suggest". Never saves — the dashboard reviews and saves.
   */
  inferReplyStyle(input: {
    sampleTexts: string[];
  }): Promise<{ suggestion: InferredReplyStyle; aiRan: boolean }>;
  /**
   * "Help me phrase this" for the Focus setup sheet: turn the operator's
   * own description of what they're doing ("driving back from London till
   * 9") into the two focus-note tiers in their voice, plus a short reason
   * label and, when the activity names an explicit clock time, the end
   * time. The notes keep [Name] and [until] as literal tokens — they fill
   * per-person at send time. Null when no provider produced a usable
   * result. Never sends, never saves — the sheet shows it for editing.
   */
  composeFocusNote(input: {
    activity: string;
    operatorProfile: OperatorProfile | null;
    voiceSampleTexts: string[];
  }): Promise<ComposedFocusNote | null>;
}

/** Result of AiService.composeFocusNote. */
export interface ComposedFocusNote {
  /** Casual note for close contacts, [Name]/[until] tokens literal. */
  close: string;
  /** Calmer note for professional contacts, same tokens literal. */
  professional: string;
  /** 1-3 word lowercase label for the window's reason chip. "" = none. */
  reason: string;
  /** "HH:MM" 24h end time, ONLY when the activity states one. Null else. */
  untilTime: string | null;
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
