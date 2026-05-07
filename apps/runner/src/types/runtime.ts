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
  }): Promise<"outreach" | "genuine" | null>;
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
