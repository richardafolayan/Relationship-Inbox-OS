import type { AiErrorKind, AiProvider, ReplyBrief } from "@inbox-os/core";
import type { RememberItem } from "./thread-remember";

export type { ReplyBrief, ReplyBriefPoint, ReplyBriefPointStatus } from "@inbox-os/core";

// Single source of truth for the platform union on the dashboard side.
// Mirrors the runner's PlatformName prisma enum — extend BOTH when a new
// platform lands (WhatsApp was missed everywhere because this union used to
// be repeated inline per interface).
export type PlatformName = "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE" | "WHATSAPP";

export interface InboxRow {
  id: string;
  /**
   * Platform-side stable id (e.g. iMessage chat guid, LinkedIn thread
   * URN). Optional because legacy rows persisted before this field was
   * surfaced still parse. Surfaced so the presenter demo can target
   * specific showcase rows by their stable demo platformThreadId.
   */
  platformThreadId?: string | null;
  personId?: string;
  personName: string;
  /**
   * Heuristic name guess from outbound greetings ("Hi Marianne") for
   * personas whose displayName is just a phone or email (iMessage). Null
   * when the displayName is already a real name. The inbox row renders
   * "Maybe …" with confirm / edit / dismiss actions.
   */
  personInferredName?: string | null;
  personAvatarUrl?: string | null;
  /**
   * Birthday for this row's contact, synced from the operator's macOS
   * Contacts. `personBirthday` is "MM-DD"; `personBirthYear` is the
   * four-digit year when the card carries one. Both null when no contact
   * matched - the row shows a quiet "birthday soon" marker off these.
   */
  personBirthday?: string | null;
  personBirthYear?: number | null;
  platform: PlatformName;
  preview: string;
  /**
   * "OUT" when the latest message was sent by the operator (preview should
   * be prefixed "You: "). "IN" when the latest is from the other party.
   * null on legacy rows that haven't been re-synced since Phase 2.
   */
  lastMessageDirection?: "IN" | "OUT" | null;
  unreadCount: number;
  riskLevel: "GREEN" | "AMBER" | "RED";
  needsReply: boolean;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  riskReason?: string | null;
  slaCountdown: string;
  identityWarning?: "unresolved_id" | null;
  messageCount?: number;
  /** "outreach" | "genuine" | null (Phase 3 categorization). */
  category?: string | null;
  /**
   * AI one-line context, what would deepen this conversation or what
   * the contact is waiting on. Rendered as a proactive nudge on Today +
   * inbox rows and used as the body of new-message desktop notifications.
   * Null or absent until the thread has been summarised.
   */
  whatTheyWant?: string | null;
  /**
   * AI verdict on whether the conversation has wrapped (issue #287 phase
   * 2.5). "closed" = last inbound is an acknowledgement / farewell with
   * no implicit ask, "open" = operator still owes a reply, null = not
   * yet classified or the AI provider was unavailable on the relevant
   * scan. The dashboard treats "closed" as a strong "set aside" signal
   * even when the lightweight heuristic does not flag it.
   */
  closedStatus?: "closed" | "open" | null;
  /**
   * One-line "why" caption explaining the closed / open verdict. Quoted
   * or paraphrased from the conversation itself. Rendered as a quiet
   * caption when the operator unhides a set-aside thread via Show all.
   * Null when the row was classified before reasons were introduced;
   * a follow-up scan or the Refresh closed verdicts trigger refills it.
   */
  closedStatusReason?: string | null;
  /**
   * AI reconnect-worthiness score (#287 phase 3.5), 0-100. Null until
   * the runner has scored this dormant LinkedIn thread, or when the AI
   * provider was unavailable. The Reconnect page falls back to a
   * deterministic relationship-signal score in that case.
   */
  reconnectScore?: number | null;
  /** Short one-line reason rendered on the Reconnect page alongside
   *  top-ranked candidates. Null when no AI score is available. */
  reconnectScoreReason?: string | null;
  archivedAt?: string | null;
  /**
   * ISO timestamp until which the operator has snoozed this thread. Active
   * inbox views filter rows where snoozedUntil is in the future; when set
   * the thread page renders an "Asleep until …" badge with an unsnooze
   * action. Null when the thread is not currently snoozed.
   */
  snoozedUntil?: string | null;
  /**
   * ISO timestamp of the earliest SCHEDULED outbound send for this thread,
   * or null when none. Today uses this to suppress threads the operator
   * has already queued a reply for; Inbox still lists them with the
   * existing scheduled pill.
   */
  scheduledSendAt?: string | null;
  /**
   * Number of inbox rows currently visible for the same person+platform.
   * 1 in the normal case. >1 when the contact has multiple distinct
   * conversations (typically LinkedIn recruiters pitching different
   * candidates in separate 1:1 threads). The dashboard shows a small
   * "N threads" badge so repeat names don't read as duplicates.
   */
  personThreadCount?: number;
  /**
   * True when the operator has favourited this contact (R-0066 / #483).
   * The Inbox floats favourited rows to the top of their section, can
   * filter to favourites only, and marks them with a star; Today
   * prioritises them within their risk bucket. Absent on legacy payloads.
   */
  personFavourite?: boolean;
  personGroups?: string[];
}

export interface InboxResponse {
  rows: InboxRow[];
  summary: {
    unreadThreads: number;
    atRiskThreads: number;
    oldestPendingInboundAt: string | null;
    messagesSentToday: number;
  };
}

/**
 * One upcoming contact birthday, as served by /runner/data/birthdays. The
 * runner has already computed `daysUntil` and filtered to the horizon, so
 * the dashboard only formats and renders.
 */
export interface UpcomingBirthday {
  personId: string;
  personName: string;
  personAvatarUrl?: string | null;
  platform: PlatformName;
  /** Most-recent thread for this person, for one-click open. Null when none. */
  threadId: string | null;
  /** Birthday month/day as "MM-DD". */
  monthDay: string;
  /** Four-digit birth year, or null for a year-less contact card. */
  birthYear: number | null;
  /** Whole days until the next occurrence; 0 means today. */
  daysUntil: number;
}

export interface BirthdaysResponse {
  upcoming: UpcomingBirthday[];
}

/**
 * iMessage contact-name health, read from the runner's name-sync. Drives the
 * "this Mac has no saved contacts" hint (issue #676). Null until the first
 * sync tick completes, or on non-macOS hosts.
 */
export interface ImessageContactHealth {
  contactsLoaded: number;
  addressBookContactCount: number;
  unresolvedImessageHandleCount: number;
  shouldHintEmptyContacts: boolean;
  lastCheckedAt: string;
}

export interface PeopleRow {
  id: string;
  name: string;
  platform: PlatformName;
  avatarUrl?: string | null;
  notes?: string | null;
  tags: string[];
  lastInteractionAt?: string | null;
  risk: "GREEN" | "AMBER" | "RED";
  hasUnresolvedIdentityWarning?: boolean;
  unresolvedThreadCount?: number;
  /** Phase 2 enrichment metadata. Null when the contact has not been enriched. */
  enrichedAt?: string | null;
  enrichmentFailedReason?: string | null;
  headline?: string | null;
  currentRole?: string | null;
  currentCompany?: string | null;
  location?: string | null;
}

export interface PersonDetailResponse {
  person: {
    id: string;
    name: string;
    platform: PlatformName;
    profileUrl: string | null;
    profileUrlSource: "auto" | "manual" | null;
    enrichedAt: string | null;
    enrichmentFailedReason: string | null;
    avatarUrl: string | null;
    tags: string[];
    notes: string | null;
    /** True when the operator has favourited this contact (R-0066 / #483). */
    favourite: boolean;
  };
  enrichment: {
    headline: string | null;
    about: string | null;
    location: string | null;
    currentCompany: string | null;
    currentRole: string | null;
    mutualCount: number | null;
    followersCount: number | null;
    experience: Array<{ title?: string | null; company?: string | null; dates?: string | null; description?: string | null }>;
    education: Array<{ institution?: string | null; degree?: string | null; field?: string | null; dates?: string | null }>;
    skills: string[];
    services: string[];
    licenses: Array<{ name?: string | null; issuer?: string | null; dates?: string | null }>;
    recentPosts: Array<{ text?: string | null; postedAt?: string | null; hasImage?: boolean }>;
    recentComments: Array<{ text?: string | null; postedAt?: string | null; onPostBy?: string | null }>;
    recentReactions: Array<{ text?: string | null; postedAt?: string | null; reaction?: string | null; onPostBy?: string | null }>;
    mutualNames: string[];
  } | null;
  summary: string | null;
  starters: {
    starters: Array<{ angle: string; citedField: string; text: string }>;
    generatedAt: string;
    validatedCount: number;
  } | null;
}

/** Reply tone the user picks during voice setup. "" = not chosen yet. */
export type ReplyStyle = "warm" | "direct" | "casual" | "thoughtful" | "concise";

/**
 * How much AI writing help to surface. Mirrors runner-side `AiHelpLevel`.
 * Lower levels never disable summaries / open loops / things to address —
 * they only hide complete sendable drafts.
 */
export type AiHelpLevel = "memory_only" | "writing_support" | "full_drafts";

/**
 * Who a Focus Reply Buffer window's acknowledgements cover. "favourites" is
 * the safe default (starred contacts only); "all_personal" widens to saved
 * personal contacts but never to unknown numbers, spam, or business threads.
 */
export type FocusAudience = "favourites" | "all_personal";

/** Note tier chosen per contact: casual "close" vs calmer "professional". */
export type FocusTier = "close" | "professional";

/**
 * Focus Reply Buffer state — one "heads-down" window at a time, persisted in
 * the operator profile JSON so Today, Inbox, Thread and Settings (and a
 * reload) all read the same window. Mirrors runner-side `FocusWindowState`.
 */
export interface FocusWindowState {
  active: boolean;
  /** ISO start; covered inbound newer than this is "arrived during focus". */
  startedAt: string;
  /** ISO end the operator chose; fills the [until] token. */
  endsAt: string;
  reason: string;
  note: string;
  /**
   * Per-window professional-tier note override ("Help me phrase this" writes
   * one per register). Optional: older runner payloads omit it; ""/absent
   * means professional contacts read the saved ackTemplates.professional.
   */
  professionalNote?: string;
  audience: FocusAudience;
  windowId: string;
  /** Person ids already acknowledged this window (one note per person). */
  ackedPersonIds: string[];
}

/**
 * Response of POST /runner/control/focus/compose-note ("Help me phrase
 * this"). `reasonLabel` is the suggested reason chip; `untilTime` is a
 * 24-hour "HH:MM" ONLY when the operator stated an explicit end time —
 * surfaced as a tappable suggestion, never auto-applied.
 */
export interface ComposeFocusNoteResponse {
  ok: boolean;
  /** Failure kind when ok is false (e.g. "ai_unavailable"). */
  reason?: string;
  close?: string;
  professional?: string;
  reasonLabel?: string;
  untilTime?: string | null;
}

/** The operator's two acknowledgement note templates (their own words). */
export interface AckTemplates {
  close: string;
  professional: string;
}

/** Focus Reply Buffer preferences (not the live window). */
export interface FocusSettings {
  reasonLabel: boolean;
  oneNotePerPerson: boolean;
  audience: FocusAudience;
}

/**
 * The user's voice + identity profile used by the AI prompts and the Today
 * greeting. Matches runner-side `OperatorProfile`. String fields are stored
 * as plain strings; "" means "not set" (no opinion injected into prompts).
 */
export interface OperatorProfile {
  displayName: string;
  about: string;
  interests: string;
  commonPhrases: string;
  avoidedPhrases: string;
  preferredStyle: ReplyStyle | "";
  aiHelpLevel: AiHelpLevel;
  setupCompletedAt: string;
  /**
   * Focus Reply Buffer fields. Optional on the dashboard mirror so a profile
   * payload from a runner build that predates the feature still parses; the
   * focus helpers supply defaults when these are absent.
   */
  focusWindow?: FocusWindowState;
  ackTemplates?: AckTemplates;
  focusSettings?: FocusSettings;
}

export interface PlatformCard {
  platform: PlatformName;
  status: "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
  lastScanAt: string | null;
  connectedAt: string | null;
  lastError: string | null;
  enabled: boolean;
  profileDir: string;
  browserProfileMode?: "isolated" | "personal";
  browserProfileSyncMode?: "smart" | "always" | "never" | null;
  browserProfileSourceUserDataDir?: string | null;
  browserProfileLaunchUserDataDir?: string | null;
  browserProfileDirectory?: string | null;
  browserProfileName?: string | null;
  browserProfileResolutionStrategy?:
    | "empty_configured"
    | "directory_exact"
    | "directory_case_insensitive"
    | "name_exact"
    | "name_case_insensitive"
    | "raw_configured"
    | "local_state_missing"
    | "local_state_unreadable"
    | null;
  latestSelectorReport?: {
    reportId: string;
    platform: PlatformName;
    startedAt: string;
    completedAt: string;
    results: Array<{
      key: string;
      selector: string;
      count: number;
      status: "PASS" | "FAIL";
      screenshotFile?: string;
    }>;
  };
  lastScanFailure?: {
    requestId: string;
    stage: string;
    reason?: string;
    errorSummary: string;
    timestamp: string;
    screenshotFile?: string;
    domDumpFile?: string;
  };
}

export interface AuditLogRow {
  id: string;
  timestamp: string;
  platform?: PlatformName;
  stage?: string;
  action: string;
  status: "OK" | "FAIL";
  details?: Record<string, unknown> | null;
  screenshotFile?: string;
  domDumpFile?: string;
}

export interface ThreadMessage {
  id: string;
  /**
   * Platform-side stable id (iMessage guid, LinkedIn message id). Sent
   * alongside the internal cuid so the timeline can resolve cross-message
   * references — today's only consumer is iMessage threaded replies,
   * where a child's `raw.replyToGuid` matches another row's
   * `platformMessageKey`.
   */
  platformMessageKey?: string;
  /**
   * App-level threading. When the operator sent this message from the
   * dashboard's focused-thread composer, it carries the parent's
   * `Message.id` (cuid). Preferred over `raw.replyToGuid` (the
   * Apple-native field, captured for inbound replies) when both are
   * present.
   */
  replyToMessageId?: string | null;
  direction: "IN" | "OUT";
  timestamp: string;
  text: string;
  senderName?: string | null;
  /**
   * Provenance of an OUT message. "automation" when this runner sent it
   * via the send service. Null on inbound messages and on OUT messages
   * that were only observed via scan (could have been sent from the
   * platform's web UI, another device, etc.) - those should not surface
   * a "Sent via automation" claim.
   */
  sentVia?: "automation" | string | null;
  raw?: Record<string, unknown> | null;
  attachments: Array<{
    type: string;
    manualReview: boolean;
    rawLabel?: string;
    /** Stable platform-side id used to fetch the binary (iMessage). */
    guid?: string;
    /** Coarse media kind so the dashboard knows which element to render. */
    kind?: "voice_note" | "photo" | "video" | "audio" | "pdf" | "sticker" | "unknown";
    byteSize?: number;
  }>;
  /**
   * Audio-transcription summary for messages that carry a voice / audio
   * attachment. Populated when AUDIO_TRANSCRIPTION_ENABLED is on and the
   * runner has finished a /v1/audio/transcriptions call. Null when no
   * audio attachment exists or transcription is disabled. The thread
   * page renders a calm one-line transcript / status hint under the
   * existing audio control.
   */
  audioTranscription?: {
    status: "pending" | "transcribed" | "failed" | "skipped" | string;
    transcript: string | null;
    /**
     * Stable error / skip reason. The dashboard checks for `missing_file`
     * to render a calm "Voice message unavailable" line instead of the
     * transcribe button, since retrying audio that's gone from disk is
     * pointless.
     */
    errorMessage?: string | null;
    /**
     * Tier that produced the currently visible transcript. `null` for
     * rows written before progressive mode (single-model behaviour).
     */
    selectedTier?: "fast" | "standard" | "max" | "refinement" | null;
    /**
     * GPT-5-nano refinement confidence, when refinement was applied.
     * Drives the optional "Refined from local transcript" tooltip on
     * the transcript bubble.
     */
    refinementConfidence?: "low" | "medium" | "high" | null;
    /**
     * Truth-based pending-tier flag. The runner reports `true` only
     * when a higher-tier transcription task is ACTUALLY queued or
     * running for this message (read from the service's in-memory
     * `pendingTiersByMessage` map, not derived from timestamps). The
     * dashboard renders `Improving transcript...` iff this is true.
     * When all configured tiers finish (or none are queued), the next
     * poll returns `false` and the hint disappears.
     */
    isImproving?: boolean;
  } | null;
  /**
   * Server-resolved snippet of the parent message this one replies to,
   * if any. Resolves across sibling iMessage threads and outside the
   * loaded window, so the dashboard can render the actual parent text
   * even when the parent isn't in the current paginated batch. `null`
   * when this message has no reply pointer at all; carries a generic
   * "Earlier message no longer available" snippet when the parent guid
   * cited by iMessage can't be located in the DB.
   */
  replyTo?: {
    messageId?: string;
    snippet: string;
    direction?: "IN" | "OUT";
  } | null;
}

export interface ThreadResponse {
  id: string;
  personId: string;
  personName: string;
  personAvatarUrl?: string | null;
  /**
   * Group chat flag straight from the Thread row (#753). Optional so the
   * dashboard keeps working against an older runner - when absent, the
   * page falls back to inferring group-ness from distinct inbound sender
   * names.
   */
  isGroup?: boolean;
  /** Operator-visible group name when set (chat.db display name). */
  groupName?: string | null;
  /** True when the operator has favourited this contact (R-0066 / #483).
   *  Drives the favourite star toggle in the thread header. */
  personFavourite?: boolean;
  /**
   * Issue #412. Contact birthday as "MM-DD" (year-less). Optional —
   * threads on contacts without a captured birthday omit the field.
   * The thread page renders a "🎂 birthday in N days" pill when the
   * birthday falls within the next ~30 days.
   */
  personBirthday?: string | null;
  /** Birth year if known; lets the rail render "turns 30" when surfacing the birthday pill. */
  personBirthYear?: number | null;
  platform: PlatformName;
  /**
   * Thread ids in this Person's sibling cohort. For an iMessage contact split
   * across handle-specific chats (phone + Apple-ID email) this lists every
   * sibling row; for every other thread it is just `[id]`. The thread page
   * matches SSE THREAD_UPDATED / SUGGESTED_REPLIES_UPDATED / SCAN_THREAD_*
   * events against this cohort so a new inbound on the OTHER handle refetches
   * the open view. Optional so a dashboard talking to a runner build that
   * predates the field still parses (the page degrades to exact-id matching).
   */
  siblingIds?: string[];
  riskLevel: "GREEN" | "AMBER" | "RED";
  riskReason?: string | null;
  /** ISO timestamp until which this thread is snoozed; null when active. */
  snoozedUntil?: string | null;
  /**
   * #776. ISO timestamp the thread was archived; null when active. Drives the
   * header's Archive / Unarchive toggle so an already-archived thread offers
   * to come back instead of re-archiving.
   */
  archivedAt?: string | null;
  /**
   * Issue #392. Operator-supplied "remind me to…" text attached to a
   * snooze. The thread page surfaces it as a "Reminder: <text>" banner
   * when present, so the operator remembers WHY the thread was snoozed
   * when it returns. Never sent to the contact. Cleared on unsnooze.
   */
  reminderText?: string | null;
  unreadCount: number;
  needsReply: boolean;
  summary?: string;
  whatTheyWant?: string;
  openLoops: string[];
  dismissedOpenLoops: string[];
  toneNotes: string[];
  /**
   * AI-extracted durable facts worth remembering — exams, trips, life events.
   * Optional so older runner builds that predate the field still parse.
   */
  remember?: RememberItem[];
  /**
   * Compressed Reply Brief that drives the thread right rail (Where it
   * stands + On you + collapsed More disclosure). The runner persists a
   * brief alongside the rolling summary; older threads / fallback paths
   * surface a synthesised brief derived from the legacy fields. Optional
   * so dashboards talking to a runner build that predates this field
   * still parse cleanly.
   */
  replyBrief?: ReplyBrief | null;
  draft: string;
  contextUpdatedAt: string;
  messages: ThreadMessage[];
  messagePage: {
    hasOlder: boolean;
    olderCursor: string | null;
    limit: number;
  };
  suggestedReplies: {
    replies: Array<{
      label: "A" | "B" | "C";
      intent: string;
      text: string;
    }>;
    needs_user_input: string[];
    /**
     * Provenance of the most recent generation. Set when fallback was
     * needed (e.g. Z.AI overloaded → fell back to OpenAI). Absent on
     * legacy cached rows. The kind/provider literals are imported from
     * `@inbox-os/core` so adding a new provider in the runner registry
     * doesn't silently break this type.
     */
    source?: {
      providerId: AiProvider | null;
      providerDisplayName: string | null;
      fellBackFromProviderId: AiProvider | null;
      fellBackFromProviderDisplayName: string | null;
      fellBackReason: AiErrorKind | null;
      fellBackMessage: string | null;
    } | null;
  };
  suggestedRepliesStatus?: "ready" | "generating";
  /**
   * Pending scheduled sends for this thread. Surfaced so the composer can
   * render a "scheduled for X - cancel" pill above the timeline without a
   * second fetch. Empty array when nothing is scheduled.
   */
  scheduledSends?: Array<{
    clientSendId: string;
    text: string;
    scheduledFor: string | null;
    createdAt: string;
  }>;
  /**
   * Cross-thread context for the same Person - last message from each
   * other active thread plus the Person's notes/tags. Surfaced as a
   * "memory chip" on the composer so operators see at a glance whether
   * AI / their own draft has historical context to lean on.
   */
  relationshipMemory?: {
    otherThreadCount: number;
    recentExchanges: Array<{
      threadId: string;
      platform: PlatformName;
      lastMessageAt: string | null;
      preview: string | null;
      whatTheyWant: string | null;
    }>;
    notes: string | null;
    tags: string[];
  };
  receipts: AuditLogRow[];
}

export interface HealthResponse {
  runnerStatus: "ONLINE" | "SCANNING" | "ERROR";
  lastScanAt: string | null;
  queueDepth: number;
  connectedPlatforms: number;
  /**
   * Platform currently being scanned. Used by the status bar so the
   * "Scanning …" label names the actual platform (LinkedIn, iMessage)
   * instead of always claiming linkedin. Optional so older runner builds
   * still parse cleanly.
   */
  currentScanPlatform?: PlatformName | null;
  /**
   * Background enrichment queue depth. Drives the status bar's
   * "Enriching N profiles" indicator while a Scan-all bulk run drains.
   * `total` is `pending + running`. Optional so older runner builds
   * still parse cleanly.
   */
  enrichmentQueue?: {
    pending: number;
    running: number;
    total: number;
  };
  /**
   * Live snapshot of the in-flight platform scan. Drives the system status
   * bar's determinate progress bar. `total` is the row cap the loop will
   * stop at; `percent` is clamped to [0, 99] until the scan completes (so
   * the bar never claims 100% before the runner actually finishes), and
   * `etaSeconds` is `null` when no prior run-time exists to estimate from.
   * Optional so older runner builds still parse cleanly.
   */
  scanProgress?: {
    platform: PlatformName;
    /**
     * #338/#362: scan scope drives the progress copy. "update" mode reads
     * "Checking <platform> · N checked · M updated" (no denominator —
     * incremental walks don't visit the whole inbox). "full" mode keeps
     * the "Full <platform> scan · N/total" denominator that's meaningful
     * for a true sweep. Optional so older runner builds parse cleanly.
     */
    scope?: "update" | "full";
    processedRows: number;
    /**
     * Threads the scan actually opened (i.e. rows that had new content
     * worth a closer look). Drives the "updated" count in update-mode
     * progress copy. Optional so older runner builds parse cleanly.
     */
    openedRows?: number;
    total: number;
    percent: number;
    etaSeconds: number | null;
  };
}

// `AiProvider` is now imported from `@inbox-os/core` at the top of this
// file. Adding a new provider in core's union (openai/glm/<future>) flows
// straight through to AppSettings + AiSource without further edits here.

export type PresenterDemoMode = "off" | "sandbox" | "live";

export interface AppSettings {
  scanIntervalSeconds: number;
  amberHours: number;
  redHours: number;
  headless: boolean;
  maxMessagesPerThread: number;
  enabledPlatforms: Array<PlatformName>;
  demoMode: boolean;
  presenterDemoMode?: PresenterDemoMode;
  presenterReadOnly?: boolean;
  recentThreadSweepCount: number;
  aiProvider?: AiProvider;
  glmModel?: string;
  geminiModel?: string;
}
