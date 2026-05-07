export type PlatformName = "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
export type RiskLevel = "GREEN" | "AMBER" | "RED";
export type Direction = "IN" | "OUT";
export type PlatformStatus = "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
export type RunnerStatus = "ONLINE" | "SCANNING" | "ERROR";

export type VerificationMethod = "bubble_detected" | "timestamp_advanced" | "best_effort";

export interface ThreadStub {
  platformThreadId: string;
  displayName: string;
  avatarUrl?: string;
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
}

export interface NormalizedMessage {
  platformMessageKey?: string;
  direction: Direction;
  timestamp: string;
  text: string;
  senderName?: string;
  raw?: Record<string, unknown>;
  attachments: AttachmentPlaceholder[];
}

export interface SendReceipt {
  sentAt: string;
  screenshotFile?: string;
  verifiedBy: VerificationMethod;
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
  | (RunnerEventBase & { type: "THREAD_UPDATED"; threadId: string })
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

export interface SummaryOutput {
  summary: string;
  what_they_want: string;
  open_loops: string[];
  tone_notes: string[];
  needs_reply: boolean;
  urgency_hint?: string;
}

export interface SuggestedReply {
  label: "A" | "B" | "C";
  intent: string;
  text: string;
}

export interface SuggestedRepliesOutput {
  replies: SuggestedReply[];
  needs_user_input: string[];
}

export type AiProvider = "openai" | "glm";

export interface AppSettings {
  scanIntervalSeconds: number;
  amberHours: number;
  redHours: number;
  headless: boolean;
  maxMessagesPerThread: number;
  enabledPlatforms: PlatformName[];
  demoMode: boolean;
  recentThreadSweepCount: number;
  // Optional so existing rows persisted before this field was added still
  // parse. When undefined, runner falls back to runnerConfig.aiProvider
  // (which is seeded from the AI_PROVIDER env var).
  aiProvider?: AiProvider;
  // Optional override for the GLM model id. When undefined, runner uses
  // runnerConfig.glmModel (Z_AI_MODEL env, default glm-4.7-flash).
  glmModel?: string;
}
