// IMESSAGE landed first as a schema-only declaration on main (so prisma
// could read existing iMessage rows without throwing). The matching
// adapter dispatches iMessage operations for real. WHATSAPP is the
// library-driven foundation — no DOM scraping, full adapter stub
// landing in a follow-up. Removing either from this union without
// also removing the underlying DB rows would break the runner's
// prisma reads.
export type PlatformName = "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE" | "WHATSAPP";
export type RiskLevel = "GREEN" | "AMBER" | "RED";
export type Direction = "IN" | "OUT";
export type PlatformStatus = "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
export type RunnerStatus = "ONLINE" | "SCANNING" | "ERROR";

export type VerificationMethod = "bubble_detected" | "timestamp_advanced" | "best_effort";

export interface ThreadStub {
  platformThreadId: string;
  displayName: string;
  avatarUrl?: string;
  /**
   * Participant's profile URL (e.g. `https://www.linkedin.com/in/<slug>/`)
   * inferred from the avatar/name anchor inside the thread. Populated by
   * the LinkedIn adapter when the thread header exposes it; downstream
   * consumers persist it on Person.profileUrl with `profileUrlSource =
   * "auto"` so a manually-pasted URL is never overwritten.
   */
  profileUrl?: string;
  unreadCount?: number;
  lastMessagePreview: string;
  lastMessageAt?: string;
  threadUrl?: string;
  needsReplyFromList?: boolean;
  isUnreadCandidate?: boolean;
  isRecentCandidate?: boolean;
}

export interface AttachmentPlaceholder {
  type: string;
  manualReview: boolean;
  rawLabel?: string;
  /**
   * Stable platform-side identifier the dashboard can use to fetch the
   * actual file (e.g. iMessage attachment guid). Optional because most
   * platforms either don't expose this or aren't supported for inline
   * media yet.
   */
  guid?: string;
  /** Coarse media kind, when known. iMessage adapter populates this. */
  kind?: "voice_note" | "photo" | "video" | "audio" | "pdf" | "sticker" | "unknown";
  /** byte size, when known. Used by the dashboard to skip huge files. */
  byteSize?: number;
}

export interface NormalizedMessage {
  platformMessageKey?: string;
  direction: Direction;
  /**
   * The platform-reported send time as an ISO string. Adapters that
   * cannot parse the real per-message timestamp (currently beta IG/TikTok)
   * can omit this — scan-queue stamps new rows with first-seen time and
   * leaves existing rows untouched, so re-scrapes don't drift the timestamp.
   */
  timestamp?: string;
  text: string;
  senderName?: string;
  raw?: Record<string, unknown>;
  attachments: AttachmentPlaceholder[];
}

/**
 * A file the operator wants to send alongside (or instead of) the
 * message text. The runner stages the file on disk and passes the
 * absolute path to the adapter; the adapter is responsible for getting
 * it onto the platform (Messages.app via osascript today).
 */
export interface OutboundAttachment {
  absolutePath: string;
  displayName: string;
  mimeType?: string;
  kind?: "voice_note" | "photo" | "video" | "audio" | "pdf" | "unknown";
}

export interface SendReceipt {
  sentAt: string;
  screenshotFile?: string;
  verifiedBy: VerificationMethod;
  /**
   * The platform-side stable id of the newly-sent message, when the
   * adapter can recover it post-send (iMessage adapter polls chat.db
   * for the new row's guid). The send service uses this as the Message
   * row's `platformMessageKey` so that a subsequent scan, which writes
   * by the same guid, recognises the row as already-persisted and
   * updates it instead of inserting a duplicate.
   *
   * Optional: adapters that can't observe the real id (LinkedIn web UI,
   * group iMessage chats without a delivery-status poll path) leave it
   * unset, and the send service falls back to a stableHash key.
   */
  platformMessageKey?: string;
  /**
   * Attachments the platform actually persisted on the outbound message,
   * for adapters that send media (e.g. iMessage voice notes / photos).
   * The runner stores these on the Message row so the dashboard can
   * render them inline alongside the bubble. Optional — text-only
   * platforms (LinkedIn) leave this unset.
   */
  attachments?: AttachmentPlaceholder[];
}

export interface SelectorRegistry {
  inbox_url: string;
  thread_list: string;
  thread_item: string;
  unread_badge: string;
  thread_snippet?: string;
  message_container: string;
  message_item: string;
  message_text: string;
  composer_input: string;
  send_button: string;
}

export interface SelectorTestResult {
  key: keyof SelectorRegistry;
  selector: string;
  count: number;
  status: "PASS" | "FAIL";
  screenshotFile?: string;
}

export interface SelectorTestReport {
  reportId: string;
  platform: PlatformName;
  startedAt: string;
  completedAt: string;
  results: SelectorTestResult[];
}

export interface RunnerEventBase {
  eventId: number;
  jobId: string;
  at: string;
}

export type RunnerEvent =
  | (RunnerEventBase & { type: "SCAN_STARTED"; platform?: PlatformName })
  | (RunnerEventBase & { type: "SCAN_PROGRESS"; platform: PlatformName; stage: string })
  | (RunnerEventBase & { type: "SCAN_FINISHED"; platform?: PlatformName; updatedThreads: number })
  | (RunnerEventBase & {
      type: "SCAN_THREAD_STARTED";
      threadId: string;
      platform: PlatformName;
    })
  | (RunnerEventBase & {
      type: "SCAN_THREAD_PROGRESS";
      threadId: string;
      platform: PlatformName;
      stage: string;
    })
  | (RunnerEventBase & {
      type: "SCAN_THREAD_FINISHED";
      threadId: string;
      platform: PlatformName;
      updatedThreads: number;
      parsedMessages: number;
    })
  | (RunnerEventBase & { type: "THREAD_UPDATED"; threadId: string })
  | (RunnerEventBase & { type: "SUGGESTED_REPLIES_UPDATED"; threadId: string })
  | (RunnerEventBase & {
      type: "MESSAGE_SENT";
      threadId: string;
      platform: PlatformName;
      // The client-supplied id from the dashboard's POST. Lets the optimistic
      // UI match this event to a specific pending bubble in the timeline so
      // the right one gets cleared when the runner confirms delivery.
      clientSendId?: string;
    })
  | (RunnerEventBase & {
      type: "MESSAGE_SEND_FAILED";
      threadId: string;
      platform: PlatformName;
      logId: string;
      clientSendId?: string;
      errorMessage?: string;
      // Coarse classification of the failure so the dashboard can offer
      // a one-tap recovery action without parsing the error message.
      // Mirrors the categories in the README's troubleshooting table.
      errorKind?: "AUTH_REQUIRED" | "SELECTOR_FAIL" | "PROFILE_LOCKED" | "TRANSIENT" | "UNKNOWN";
    })
  | (RunnerEventBase & {
      // Fired when an async send is queued, started, or its position changes.
      // The dashboard's SystemStatusBar reacts to this in addition to its
      // 3-second poll, giving sub-second feedback when sends transition
      // PENDING -> in-flight -> SENT/FAILED.
      type: "SEND_QUEUE_UPDATED";
      activeCount: number;
    })
  | (RunnerEventBase & { type: "PLATFORM_STATUS_CHANGED"; platform: PlatformName; status: PlatformStatus })
  | (RunnerEventBase & { type: "SELECTOR_TEST_RESULT"; platform: PlatformName; reportId: string })
  | (RunnerEventBase & { type: "PERSONAL_PROFILE_FALLBACK"; platform: PlatformName; reason: string })
  | (RunnerEventBase & { type: "RESYNC_REQUIRED"; reason: string });

/**
 * A durable fact worth remembering about a contact — an exam, a trip, an
 * interview, a life event. Extracted by the AI summary alongside open loops,
 * but distinct from them: a loop is something to reply to now, a remember
 * item is context to carry forward.
 */
export interface RememberItem {
  /** Short third-person phrase, e.g. "Final exams", "Trip to Lagos". */
  note: string;
  /** ISO YYYY-MM-DD when a specific date is known, else null. */
  date: string | null;
}

export interface SummaryOutput {
  summary: string;
  what_they_want: string;
  open_loops: string[];
  /** Durable life facts worth remembering — events, milestones, deadlines. */
  remember: RememberItem[];
  tone_notes: string[];
  needs_reply: boolean;
  urgency_hint?: string;
  /**
   * Compressed Reply Brief that drives the thread right rail. Generated in
   * the same AI call as `summary`/`what_they_want`/`open_loops` so the
   * catch-up, the obligation read, and the classification stay internally
   * consistent. Optional so older AI runs / fallbacks still parse — when
   * absent, the dashboard derives a safe brief from the legacy fields.
   */
  reply_brief?: ReplyBrief | null;
}

/**
 * Classification of a point the AI extracted from the recent transcript.
 *
 * - required: the reply would feel incomplete if this point were ignored
 *   (direct question, request, decision the contact asked the operator
 *   to make, important news that deserves acknowledgement, multi-part
 *   inbound where parts still need a response). Mirrored into the legacy
 *   `open_loops` array so the existing checklist + draft-coverage flow
 *   keeps working.
 * - optional: a relationship-deepening or conversational move the AI
 *   suggests but the contact did not actually ask for. Never gates
 *   sending, never appears in the required list.
 * - handled: a point that no longer needs action (the contact answered
 *   themselves later, the operator already answered, the conversation
 *   moved on, rhetorical, or covered by the operator's current draft).
 */
export type ReplyBriefPointStatus = "required" | "optional" | "handled";

export interface ReplyBriefPoint {
  /** Stable id within this brief — short slug, used as a UI key. */
  id: string;
  /** Plain-English phrasing the operator can read in under a beat. */
  text: string;
  status: ReplyBriefPointStatus;
  /**
   * For `handled` points only: a short reason it's been dropped from the
   * required list (e.g. "you already answered this on Tuesday"). Optional;
   * surfaced only in the expanded "More" disclosure.
   */
  reason?: string;
}

/**
 * A single substance bullet pulled from the latest unanswered inbound. Used
 * to surface the reply-relevant details (decisions, constraints, reasons,
 * news, updates) in a scannable list so the operator can write a reply
 * without rereading the message. Distinct from `ReplyBriefPoint` — these
 * are NOT actions the operator should take, they're what the contact said.
 */
export interface ReplyBriefSubstancePoint {
  /** Stable id within this brief — short slug, used as a UI key. */
  id: string;
  /** One short line capturing a single reply-relevant detail. */
  text: string;
}

export interface ReplyBrief {
  /**
   * The compressed trace. Explains what the operator previously said
   * (only when it explains why the contact replied the way they did),
   * what the contact said back, and where the conversation has landed.
   * NOT a generic relationship summary — that lives in `summary` /
   * `fuller_context`. Plain British English, no abstract coaching.
   */
  where_it_stands: string;
  /**
   * The obligation read. States plainly whether the contact has asked
   * the operator for anything and what would close the loop. If nothing
   * is genuinely on the operator, says so directly (e.g. "He hasn't
   * asked you anything. Acknowledge the offer, ask what he's looking at
   * now, and you're done.").
   */
  on_you: string;
  required_points: ReplyBriefPoint[];
  optional_followups: ReplyBriefPoint[];
  handled_points?: ReplyBriefPoint[];
  /**
   * Substance bullets from the latest unanswered inbound message — the
   * reply-relevant details (decisions, constraints, reasons, news,
   * updates) the contact actually shared. Surfaced by default below
   * `where_it_stands` so the operator can write a thoughtful reply
   * without rereading the raw message. Empty array in reconnect mode
   * (no inbound is waiting on the operator).
   */
  they_said?: ReplyBriefSubstancePoint[] | null;
  /** Longer context for the expanded "More" section, when useful. */
  fuller_context?: string | null;
  /** Durable relationship context (who they are, how the operator knows them). */
  durable_context?: string | null;
  /** One short line on how to approach the reply (tone, register). */
  tone_steer?: string | null;
  /**
   * AI self-report: does the brief carry enough for the operator to write
   * a reply without scrolling up into the message history? Surface signal
   * only — the dashboard renders regardless.
   */
  enough_to_reply_without_scrolling: boolean;
}

export interface SuggestedReply {
  label: "A" | "B" | "C";
  intent: string;
  text: string;
}

/**
 * Provenance for an AI-generated payload. When the active provider
 * (operator's choice) failed and the runner walked the fallback chain to
 * produce the result, `fellBackFromProviderId` is set so the dashboard
 * can show a small notice ("via OpenAI — Z.AI was overloaded") without
 * the operator having to dig through runner logs to figure out why their
 * selected provider didn't run.
 */
export interface AiSource {
  /** Provider that actually produced the output. `null` if every provider in the chain failed. */
  providerId: AiProvider | null;
  providerDisplayName: string | null;
  /** When non-null, generation fell back from this provider. */
  fellBackFromProviderId: AiProvider | null;
  /**
   * Human display name for the active provider that was skipped — set
   * alongside `fellBackFromProviderId` so the dashboard never has to map
   * provider ids to display strings (and stays correct as new providers
   * are added to the registry).
   */
  fellBackFromProviderDisplayName: string | null;
  /** Stable error-kind tag from the active provider's failure. */
  fellBackReason: AiErrorKind | null;
  /** One-line human explanation for logs / tooltip. */
  fellBackMessage: string | null;
}

export interface SuggestedRepliesOutput {
  replies: SuggestedReply[];
  needs_user_input: string[];
  /** Set on freshly-generated outputs; absent on legacy cached rows. */
  source?: AiSource | null;
}

export type AiProvider = "openai" | "glm" | "gemini";

export type AiErrorKind =
  | "balance"
  | "rate_limit"
  | "service_overloaded"
  | "auth"
  | "model_not_found"
  | "empty_content"
  | "unknown";

/**
 * Presenter / demo mode for the full-presenter-demo flow.
 *  - "off":     normal app, no demo seeding or guards.
 *  - "sandbox": seeded showcase threads, mutations scoped to manifest,
 *               all real platform adapters bypassed (sends route through
 *               demoSendAdapter).
 *  - "live":    real threads visible, every mutation intercepted + 403'd
 *               server-side. Used together with presenterReadOnly=true.
 *
 * Optional so settings rows persisted before this field was added still
 * parse — undefined is treated as "off".
 */
export type PresenterDemoMode = "off" | "sandbox" | "live";

export interface AppSettings {
  scanIntervalSeconds: number;
  amberHours: number;
  redHours: number;
  headless: boolean;
  maxMessagesPerThread: number;
  enabledPlatforms: PlatformName[];
  demoMode: boolean;
  /**
   * Full-presenter-demo mode. See PresenterDemoMode. Optional so old rows
   * still parse; undefined == "off".
   */
  presenterDemoMode?: PresenterDemoMode;
  /**
   * Live-demo read-only flag. When true, the runner rejects every
   * mutation listed in the presenter-guard table with a 403 so a stray
   * client request cannot accidentally archive / send / snooze a real
   * thread during a presentation. Always cleared via
   * POST /control/presenter-demo/reset.
   */
  presenterReadOnly?: boolean;
  recentThreadSweepCount: number;
  // Optional so existing rows persisted before this field was added still
  // parse. When undefined, runner falls back to runnerConfig.aiProvider
  // (which is seeded from the AI_PROVIDER env var).
  aiProvider?: AiProvider;
  // Optional override for the GLM model id. When undefined, runner uses
  // runnerConfig.glmModel (Z_AI_MODEL env, default glm-4.7-flash).
  glmModel?: string;
  // Optional override for the Gemini model id. When undefined, runner uses
  // runnerConfig.geminiModel (GEMINI_MODEL env, default gemma-4-31b-it).
  // Gemma works through Google's OpenAI-compat endpoint once the
  // thinking_level=MINIMAL extra is set; see services/ai.ts:geminiExtraBody.
  geminiModel?: string;
}
