export interface InboxRow {
  id: string;
  personId?: string;
  personName: string;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
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
  archivedAt?: string | null;
}

export interface InboxResponse {
  rows: InboxRow[];
  summary: {
    unreadThreads: number;
    atRiskThreads: number;
    averageReplyTimeHours: number;
    oldestPendingInboundAt: string | null;
    messagesSentToday: number;
  };
}

export interface PeopleRow {
  id: string;
  name: string;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  notes?: string | null;
  tags: string[];
  lastInteractionAt?: string | null;
  risk: "GREEN" | "AMBER" | "RED";
  hasUnresolvedIdentityWarning?: boolean;
  unresolvedThreadCount?: number;
}

export interface PlatformCard {
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
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
    platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
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

export interface ScanControlQueuedResponse {
  ok: true;
  jobId: string;
  status: "queued" | "running";
  requestId: string;
  platform?: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
}

export interface ScanControlBlockedResponse {
  ok: false;
  blocked: true;
  reason: "cooldown_active" | "in_flight";
  retryAfterSeconds: number;
  requestId: string;
  platform?: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
}

export interface ScanControlRequest {
  platform?: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  maxThreads?: number | null;
  maxOpens?: number | null;
  forceFallback?: boolean | null;
}

export type ScanControlResponse = ScanControlQueuedResponse | ScanControlBlockedResponse;

export interface AuditLogRow {
  id: string;
  timestamp: string;
  platform?: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  stage?: string;
  action: string;
  status: "OK" | "FAIL";
  details?: Record<string, unknown> | null;
  screenshotFile?: string;
  domDumpFile?: string;
}

export interface ThreadMessage {
  id: string;
  direction: "IN" | "OUT";
  timestamp: string;
  text: string;
  senderName?: string | null;
  raw?: Record<string, unknown> | null;
  attachments: Array<{ type: string; manualReview: boolean; rawLabel?: string }>;
}

export interface ThreadResponse {
  id: string;
  personName: string;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  riskLevel: "GREEN" | "AMBER" | "RED";
  riskReason?: string | null;
  unreadCount: number;
  needsReply: boolean;
  summary?: string;
  whatTheyWant?: string;
  openLoops: string[];
  toneNotes: string[];
  draft: string;
  contextUpdatedAt: string;
  messages: ThreadMessage[];
  suggestedReplies: {
    replies: Array<{
      label: "A" | "B" | "C";
      intent: string;
      text: string;
    }>;
    needs_user_input: string[];
  };
  receipts: AuditLogRow[];
}

export interface HealthResponse {
  runnerStatus: "ONLINE" | "SCANNING" | "ERROR";
  lastScanAt: string | null;
  queueDepth: number;
  connectedPlatforms: number;
}

export interface AppSettings {
  scanIntervalSeconds: number;
  amberHours: number;
  redHours: number;
  headless: boolean;
  maxMessagesPerThread: number;
  enabledPlatforms: Array<"LINKEDIN" | "INSTAGRAM" | "TIKTOK">;
  demoMode: boolean;
  recentThreadSweepCount: number;
}

export interface SelectorTestReceipt {
  stage: "connect" | "navigate" | "auth_check" | "open_thread" | "evaluate" | "screenshot" | "persist";
  status: "OK" | "FAIL";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface SelectorTestFailurePayload {
  ok: false;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  stage: SelectorTestReceipt["stage"];
  error: string;
  requestId: string;
  reason?: string;
  receipts?: SelectorTestReceipt[];
  artifacts?: {
    screenshot?: string;
    domDump?: string;
  };
}

export interface SelectorTestSuccessPayload {
  ok: true;
  reportId: string;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  startedAt: string;
  completedAt: string;
  results: Array<{
    key: string;
    selector: string;
    count: number;
    status: "PASS" | "FAIL";
    screenshotFile?: string;
  }>;
  receipts?: SelectorTestReceipt[];
}
