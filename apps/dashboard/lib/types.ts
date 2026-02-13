export interface InboxRow {
  id: string;
  personName: string;
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK";
  preview: string;
  unreadCount: number;
  riskLevel: "GREEN" | "AMBER" | "RED";
  needsReply: boolean;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  riskReason?: string | null;
  slaCountdown: string;
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
}

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
