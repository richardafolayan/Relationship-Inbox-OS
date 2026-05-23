import type { AiErrorKind, AiProvider } from "@inbox-os/core";

export interface InboxRow {
  id: string;
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
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
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
   * AI one-line context — what would deepen this conversation / what the
   * contact is waiting on. Rendered as a proactive nudge on Today + inbox
   * rows and used as the body of new-message desktop notifications. Null
   * or absent until the thread has been summarised.
   */
  whatTheyWant?: string | null;
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
}

export interface InboxResponse {
  rows: InboxRow[];
  summary: {
    unreadThreads: number;
    atRiskThreads: number;
    averageReplyTimeHours: number | null;
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
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
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

export interface PeopleRow {
  id: string;
  name: string;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
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
    platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
    profileUrl: string | null;
    profileUrlSource: "auto" | "manual" | null;
    enrichedAt: string | null;
    enrichmentFailedReason: string | null;
    avatarUrl: string | null;
    tags: string[];
    notes: string | null;
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
}

export interface PlatformCard {
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
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
    platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
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
  platform?: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
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
}

export interface ThreadResponse {
  id: string;
  personId: string;
  personName: string;
  personAvatarUrl?: string | null;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
  riskLevel: "GREEN" | "AMBER" | "RED";
  riskReason?: string | null;
  /** ISO timestamp until which this thread is snoozed; null when active. */
  snoozedUntil?: string | null;
  unreadCount: number;
  needsReply: boolean;
  summary?: string;
  whatTheyWant?: string;
  openLoops: string[];
  dismissedOpenLoops: string[];
  toneNotes: string[];
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
      platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
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
  currentScanPlatform?: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE" | null;
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
    platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
    processedRows: number;
    total: number;
    percent: number;
    etaSeconds: number | null;
  };
}

// `AiProvider` is now imported from `@inbox-os/core` at the top of this
// file. Adding a new provider in core's union (openai/glm/<future>) flows
// straight through to AppSettings + AiSource without further edits here.

export interface AppSettings {
  scanIntervalSeconds: number;
  amberHours: number;
  redHours: number;
  headless: boolean;
  maxMessagesPerThread: number;
  enabledPlatforms: Array<"LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE">;
  demoMode: boolean;
  recentThreadSweepCount: number;
  aiProvider?: AiProvider;
  glmModel?: string;
  geminiModel?: string;
}

