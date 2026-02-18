import type { PlatformAdapter, PlatformName, ThreadStub } from "@inbox-os/core";
import { calculateRisk, stableHash } from "@inbox-os/core";
import { v4 as uuid } from "uuid";
import { prisma } from "../db";
import type { AiService, EventBus, ScanJobOutcome, SettingsStore } from "../types/runtime";
import { AdapterFailure, cleanText, humanDelay } from "../platforms/utils";
import { resolveAdapterFailureKind, shouldStopScanForFailureKind } from "./failure-routing";
import type { KeyedMutex } from "./keyed-mutex";

interface ScanQueueDeps {
  adapters: Record<PlatformName, PlatformAdapter>;
  eventBus: EventBus;
  settingsStore: SettingsStore;
  aiService: AiService;
  platformMutex: Pick<KeyedMutex, "runWithQueueOne" | "getQueueDepth">;
  personKey?: string;
  auditLog: (input: {
    platform?: PlatformName;
    stage?: string;
    action: string;
    status: "OK" | "FAIL";
    details?: Record<string, unknown>;
    screenshotFile?: string;
    domDumpFile?: string;
  }) => Promise<string>;
}

type ScanJob = {
  jobId: string;
  platform?: PlatformName;
};

const allPlatforms: PlatformName[] = ["LINKEDIN", "INSTAGRAM", "TIKTOK"];

export function createScanQueue(deps: ScanQueueDeps) {
  const queue: ScanJob[] = [];
  let processing = false;
  let scheduler: NodeJS.Timeout | undefined;
  let abortVersion = 0;
  let abortReason: string | null = null;

  const personKey = deps.personKey ?? "default";

  function lockKey(platform: PlatformName): string {
    return `${personKey}:${platform}`;
  }

  function triggerProcessNext(): void {
    void processNext().catch((error) => {
      void deps.auditLog({
        stage: "Scan",
        action: "SCAN_QUEUE_PROCESS_FAIL",
        status: "FAIL",
        details: {
          personKey,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        }
      });
    });
  }

  function getQueueDepth(): number {
    return queue.length + (processing ? 1 : 0) + deps.platformMutex.getQueueDepth();
  }

  async function setPlatformStatus(input: {
    platform: PlatformName;
    status: "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
    lastError?: string;
    connected?: boolean;
  }): Promise<void> {
    const resolvedLastError = input.status === "CONNECTED" ? null : input.lastError;

    await prisma.platform.upsert({
      where: { name: input.platform },
      update: {
        status: input.status,
        lastError: resolvedLastError,
        connectedAt: input.connected ? new Date() : undefined,
        lastScanAt: input.status === "CONNECTED" ? new Date() : undefined
      },
      create: {
        name: input.platform,
        status: input.status,
        lastError: resolvedLastError,
        connectedAt: input.connected ? new Date() : undefined,
        lastScanAt: input.status === "CONNECTED" ? new Date() : undefined
      }
    });

    deps.eventBus.emit({
      type: "PLATFORM_STATUS_CHANGED",
      jobId: uuid(),
      platform: input.platform,
      status: input.status
    });
  }

  async function ensurePlatformRows(): Promise<void> {
    for (const platform of allPlatforms) {
      await prisma.platform.upsert({
        where: { name: platform },
        update: {},
        create: {
          name: platform,
          status: "NOT_CONNECTED"
        }
      });
    }
  }

  function enqueueScan(platform?: PlatformName): { jobId: string; status: "queued" | "running" } {
    const job: ScanJob = {
      jobId: uuid(),
      platform
    };

    queue.push(job);
    triggerProcessNext();

    return {
      jobId: job.jobId,
      status: processing ? "queued" : "running"
    };
  }

  function startScheduler(): void {
    if (scheduler) {
      clearInterval(scheduler);
    }

    let lastRunAt = 0;

    scheduler = setInterval(() => {
      void (async () => {
        const settings = await deps.settingsStore.getSettings();
        if (settings.demoMode) {
          return;
        }

        const now = Date.now();
        const intervalMs = settings.scanIntervalSeconds * 1000;
        if (processing || now - lastRunAt < intervalMs) {
          return;
        }

        lastRunAt = now;
        enqueueScan();
      })().catch((error) => {
        void deps.auditLog({
          stage: "Scan",
          action: "SCHEDULER_TICK_FAIL",
          status: "FAIL",
          details: {
            personKey,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          }
        });
      });
    }, 1000);
  }

  async function processNext(): Promise<void> {
    if (processing) {
      return;
    }

    const next = queue.shift();
    if (!next) {
      return;
    }

    processing = true;

    try {
      await runJob(next);
    } finally {
      processing = false;
      if (queue.length > 0) {
        triggerProcessNext();
      }
    }
  }

  async function runJob(job: ScanJob): Promise<ScanJobOutcome> {
    deps.eventBus.emit({
      type: "SCAN_STARTED",
      jobId: job.jobId,
      platform: job.platform
    });

    await ensurePlatformRows();
    const settings = await deps.settingsStore.getSettings();
    const scanPlatforms = job.platform
      ? [job.platform]
      : settings.enabledPlatforms.filter((platform) => allPlatforms.includes(platform));

    let updatedThreads = 0;
    const jobAbortVersion = abortVersion;
    let aborted = false;

    const shouldAbort = (): boolean => abortVersion !== jobAbortVersion;
    const resolveAbortReason = (): string => abortReason ?? "session_preempt";

    const markAborted = async (
      checkpoint: string,
      platform?: PlatformName,
      thread?: ThreadStub
    ): Promise<boolean> => {
      if (!shouldAbort()) {
        return false;
      }
      if (aborted) {
        return true;
      }

      aborted = true;
      await deps.auditLog({
        platform,
        stage: "Scan",
        action: "SCAN_ABORTED",
        status: "OK",
        details: {
          reason: resolveAbortReason(),
          checkpoint,
          updatedThreads,
          threadDisplayName: thread?.displayName,
          platformThreadId: thread?.platformThreadId
        }
      });
      return true;
    };

    for (const platform of scanPlatforms) {
      await deps.platformMutex.runWithQueueOne(lockKey(platform), async () => {
        if (await markAborted("before_platform_loop", platform)) {
          return;
        }

        let platformUpdatedThreads = 0;
        let threadFailures = 0;
        const threadFailureKinds: Record<string, number> = {};
        let authInterrupted = false;

        deps.eventBus.emit({
          type: "SCAN_PROGRESS",
          jobId: job.jobId,
          platform,
          stage: "Connecting"
        });

        const adapter = deps.adapters[platform];

        try {
          if (await markAborted("before_connect", platform)) {
            return;
          }
          await adapter.ensureConnected();
          if (await markAborted("after_connect", platform)) {
            return;
          }
          await setPlatformStatus({ platform, status: "CONNECTED", connected: true });

          deps.eventBus.emit({
            type: "SCAN_PROGRESS",
            jobId: job.jobId,
            platform,
            stage: "Collecting candidates"
          });

          if (await markAborted("before_scan_unread", platform)) {
            return;
          }
          const unread = await adapter.scanUnreadThreads();
          if (await markAborted("after_scan_unread", platform)) {
            return;
          }
          if (await markAborted("before_scan_recent", platform)) {
            return;
          }
          const recent = await adapter.fetchRecentThreads(settings.recentThreadSweepCount);
          if (await markAborted("after_scan_recent", platform)) {
            return;
          }

          const merged = new Map<string, ThreadStub>();
          for (const thread of unread) {
            merged.set(thread.platformThreadId, thread);
          }
          for (const thread of recent) {
            if (!merged.has(thread.platformThreadId)) {
              merged.set(thread.platformThreadId, thread);
            }
          }
          const metricsProvider = adapter as unknown as {
            getLastCollectionMetrics?: () => Record<string, unknown> | null;
          };
          const collectionMetrics =
            typeof metricsProvider.getLastCollectionMetrics === "function"
              ? metricsProvider.getLastCollectionMetrics()
              : null;

          deps.eventBus.emit({
            type: "SCAN_PROGRESS",
            jobId: job.jobId,
            platform,
            stage: `Syncing ${merged.size} thread(s)`
          });

          for (const thread of merged.values()) {
            if (await markAborted("before_thread_sync", platform, thread)) {
              break;
            }

            try {
              const updated = await syncThread(platform, thread, settings.maxMessagesPerThread, job.jobId);
              updatedThreads += updated;
              platformUpdatedThreads += updated;
            } catch (error) {
              if (await markAborted("thread_sync_error", platform, thread)) {
                break;
              }

              const failureKind = resolveAdapterFailureKind(error);
              const message = error instanceof Error ? error.message : String(error);
              const resolvedFailureKind = failureKind ?? "UNKNOWN";
              const adapterError = error instanceof AdapterFailure ? error : undefined;

              if (shouldStopScanForFailureKind(failureKind)) {
                await setPlatformStatus({
                  platform,
                  status: "NOT_CONNECTED",
                  lastError: message
                });

                await deps.auditLog({
                  platform,
                  stage: "Scan",
                  action: "SCAN_AUTH_REQUIRED",
                  status: "FAIL",
                  details: {
                    jobId: job.jobId,
                    requestId: job.jobId,
                    stage: adapterError?.stage ?? "parse",
                    platform,
                    message,
                    failureKind: resolvedFailureKind,
                    threadDisplayName: thread.displayName,
                    platformThreadId: thread.platformThreadId,
                    errorStack: error instanceof Error ? error.stack : undefined
                  },
                  screenshotFile: adapterError?.screenshotFile,
                  domDumpFile: adapterError?.domDumpFile
                });

                authInterrupted = true;
                break;
              }

              threadFailures += 1;
              threadFailureKinds[resolvedFailureKind] = (threadFailureKinds[resolvedFailureKind] ?? 0) + 1;

              await deps.auditLog({
                platform,
                stage: "Scan",
                action: "THREAD_SYNC_FAIL",
                status: "FAIL",
                details: {
                  jobId: job.jobId,
                  requestId: job.jobId,
                  stage: adapterError?.stage ?? "parse",
                  platform,
                  message,
                  failureKind: resolvedFailureKind,
                  threadDisplayName: thread.displayName,
                  platformThreadId: thread.platformThreadId,
                  errorStack: error instanceof Error ? error.stack : undefined
                },
                screenshotFile: adapterError?.screenshotFile,
                domDumpFile: adapterError?.domDumpFile
              });
            }

            if (await markAborted("after_thread_sync", platform, thread)) {
              break;
            }

            await humanDelay();
          }

          if (aborted) {
            return;
          }

          if (authInterrupted) {
            return;
          }

          await prisma.platform.update({
            where: { name: platform },
            data: {
              status: "CONNECTED",
              lastScanAt: new Date(),
              lastError: null
            }
          });

          await deps.auditLog({
            platform,
            stage: "Scan",
            action: "SCAN_END",
            status: "OK",
            details: {
              jobId: job.jobId,
              requestId: job.jobId,
              stage: "persist",
              platform,
              updatedThreads: platformUpdatedThreads,
              processed: platformUpdatedThreads,
              skipped: Math.max(0, merged.size - platformUpdatedThreads),
              totalFound:
                typeof collectionMetrics?.totalFound === "number" ? (collectionMetrics.totalFound as number) : merged.size,
              unreadFound:
                typeof collectionMetrics?.unreadFound === "number"
                  ? (collectionMetrics.unreadFound as number)
                  : merged.size,
              iterations:
                typeof collectionMetrics?.iterations === "number" ? (collectionMetrics.iterations as number) : undefined,
              stopReason:
                typeof collectionMetrics?.stopReason === "string" ? (collectionMetrics.stopReason as string) : undefined,
              candidates: merged.size,
              threadFailures,
              threadFailureKinds
            }
          });
        } catch (error) {
          if (await markAborted("platform_error", platform)) {
            return;
          }

          if (error instanceof AdapterFailure) {
            const failureKind = resolveAdapterFailureKind(error);
            const resolvedFailureKind = failureKind ?? "UNKNOWN";

            if (shouldStopScanForFailureKind(failureKind)) {
              await setPlatformStatus({
                platform,
                status: "NOT_CONNECTED",
                lastError: error.message
              });

              await deps.auditLog({
                platform,
                stage: "Scan",
                action: "SCAN_AUTH_REQUIRED",
                status: "FAIL",
                details: {
                  jobId: job.jobId,
                  requestId: job.jobId,
                  stage: error.stage ?? "navigate",
                  platform,
                  message: error.message,
                  failureKind: resolvedFailureKind,
                  errorStack: error.stack
                },
                screenshotFile: error.screenshotFile,
                domDumpFile: error.domDumpFile
              });
              return;
            }

            await setPlatformStatus({
              platform,
              status: "DEGRADED",
              lastError: error.message
            });

            await deps.auditLog({
              platform,
              stage: "Scan",
              action: resolvedFailureKind === "SELECTOR_MISMATCH" ? "SELECTOR_FAIL" : "SCAN_FAIL",
              status: "FAIL",
              details: {
                jobId: job.jobId,
                requestId: job.jobId,
                stage: error.stage ?? "collect_threads",
                platform,
                message: error.message,
                failureKind: resolvedFailureKind,
                errorStack: error.stack
              },
              screenshotFile: error.screenshotFile,
              domDumpFile: error.domDumpFile
            });
          } else {
            await setPlatformStatus({
              platform,
              status: "ERROR",
              lastError: error instanceof Error ? error.message : "Unknown error"
            });

            await deps.auditLog({
              platform,
              stage: "Scan",
              action: "SCAN_FAIL",
              status: "FAIL",
              details: {
                jobId: job.jobId,
                requestId: job.jobId,
                stage: "collect_threads",
                platform,
                message: error instanceof Error ? error.message : String(error),
                errorStack: error instanceof Error ? error.stack : undefined
              }
            });
          }
        }
      });

      if (aborted) {
        break;
      }
    }

    if (aborted) {
      clearAbort();
    }

    deps.eventBus.emit({
      type: "SCAN_FINISHED",
      jobId: job.jobId,
      platform: job.platform,
      updatedThreads
    });

    return {
      jobId: job.jobId,
      updatedThreads
    };
  }

  async function syncThread(
    platform: PlatformName,
    candidate: ThreadStub,
    maxMessages: number,
    jobId: string
  ): Promise<number> {
    const person =
      (await prisma.person.findFirst({ where: { displayName: candidate.displayName, platform } })) ??
      (await prisma.person.create({
        data: {
          displayName: candidate.displayName,
          platform
        }
      }));

    const existing = await prisma.thread.findUnique({
      where: {
        platform_platformThreadId: {
          platform,
          platformThreadId: candidate.platformThreadId
        }
      }
    });

    const thread =
      existing ??
      (await prisma.thread.create({
        data: {
          platform,
          platformThreadId: candidate.platformThreadId,
          personId: person.id,
          threadUrl: candidate.threadUrl,
          unreadCount: candidate.unreadCount ?? 0,
          lastMessagePreview: cleanText(candidate.lastMessagePreview ?? "")
        }
      }));

    const adapter = deps.adapters[platform];
    await deps.auditLog({
      platform,
      stage: "Parse",
      action: "THREAD_PARSE_START",
      status: "OK",
      details: {
        requestId: jobId,
        jobId,
        stage: "parse",
        threadId: thread.id,
        platformThreadId: candidate.platformThreadId
      }
    });
    const messages = await adapter.fetchThreadMessages(candidate, maxMessages);
    await deps.auditLog({
      platform,
      stage: "Parse",
      action: "THREAD_PARSE_COLLECTED",
      status: "OK",
      details: {
        requestId: jobId,
        jobId,
        stage: "parse",
        threadId: thread.id,
        platformThreadId: candidate.platformThreadId,
        collectedCount: messages.length
      }
    });

    for (const message of messages) {
      const parsedTimestamp = new Date(message.timestamp);
      const safeTimestamp = Number.isNaN(parsedTimestamp.getTime()) ? new Date() : parsedTimestamp;
      const key =
        message.platformMessageKey ??
        stableHash(`${thread.id}|${message.timestamp}|${message.direction}|${cleanText(message.text)}`);

      await prisma.message.upsert({
        where: {
          threadId_platformMessageKey: {
            threadId: thread.id,
            platformMessageKey: key
          }
        },
        update: {
          text: cleanText(message.text),
          direction: message.direction,
          timestamp: safeTimestamp,
          attachmentsJson: message.attachments.length ? JSON.stringify(message.attachments) : null,
          senderName: message.senderName ?? null,
          rawJson: message.raw ? JSON.stringify(message.raw) : null
        },
        create: {
          threadId: thread.id,
          platformMessageKey: key,
          direction: message.direction,
          timestamp: safeTimestamp,
          text: cleanText(message.text),
          attachmentsJson: message.attachments.length ? JSON.stringify(message.attachments) : null,
          senderName: message.senderName ?? null,
          rawJson: message.raw ? JSON.stringify(message.raw) : null
        }
      });
    }

    const latestMessages = await prisma.message.findMany({
      where: { threadId: thread.id },
      orderBy: { timestamp: "asc" },
      take: maxMessages
    });

    const lastMessage = latestMessages[latestMessages.length - 1];
    const lastInbound = [...latestMessages].reverse().find((msg) => msg.direction === "IN");
    const lastOutbound = [...latestMessages].reverse().find((msg) => msg.direction === "OUT");
    const resolvedLastMessagePreview = cleanText(
      candidate.lastMessagePreview ?? lastMessage?.text ?? thread.lastMessagePreview ?? ""
    );

    const settings = await deps.settingsStore.getSettings();
    const risk = calculateRisk({
      lastInboundAt: lastInbound?.timestamp,
      lastOutboundAt: lastOutbound?.timestamp,
      amberHours: settings.amberHours,
      redHours: settings.redHours
    });

    const lastInboundHash = lastInbound
      ? stableHash(`${lastInbound.timestamp.toISOString()}|${cleanText(lastInbound.text)}`)
      : null;

    const shouldRefreshSummary = !!lastInboundHash && lastInboundHash !== thread.lastInboundHash;

    let summary = thread.rollingSummary;
    let whatTheyWant = thread.whatTheyWant;
    let openLoopsJson = thread.openLoopsJson;
    let toneNotesJson = thread.toneNotesJson;

    if (shouldRefreshSummary) {
      const aiSummary = await deps.aiService.updateThreadSummary({
        displayName: person.displayName,
        previousSummary: thread.rollingSummary ?? undefined,
        previousOpenLoops: thread.openLoopsJson ? (JSON.parse(thread.openLoopsJson) as string[]) : [],
        messages: latestMessages.map((message) => ({
          direction: message.direction,
          text: message.text,
          timestamp: message.timestamp.toISOString()
        }))
      });

      summary = aiSummary.summary;
      whatTheyWant = aiSummary.what_they_want;
      openLoopsJson = JSON.stringify(aiSummary.open_loops);
      toneNotesJson = JSON.stringify(aiSummary.tone_notes);
    }

    await prisma.thread.update({
      where: { id: thread.id },
      data: {
        personId: person.id,
        threadUrl: candidate.threadUrl ?? thread.threadUrl,
        unreadCount: candidate.unreadCount ?? thread.unreadCount,
        lastMessagePreview: resolvedLastMessagePreview || null,
        lastMessageAt: lastMessage?.timestamp,
        lastInboundAt: lastInbound?.timestamp,
        lastOutboundAt: lastOutbound?.timestamp,
        lastInboundHash,
        riskLevel: risk.level,
        slaDueAt: risk.slaDueAt,
        riskReason: risk.riskReason,
        needsReply: risk.needsReply,
        rollingSummary: summary,
        whatTheyWant,
        openLoopsJson,
        toneNotesJson
      }
    });

    deps.eventBus.emit({
      type: "THREAD_UPDATED",
      jobId,
      threadId: thread.id
    });

    await deps.auditLog({
      platform,
      stage: "Parse",
      action: "THREAD_UPDATED",
      status: "OK",
      details: {
        requestId: jobId,
        jobId,
        stage: "persist",
        threadId: thread.id,
        platformThreadId: candidate.platformThreadId,
        messageCount: latestMessages.length,
        needsReply: risk.needsReply
      }
    });

    return 1;
  }

  return {
    enqueueScan,
    processNext,
    getQueueDepth,
    isScanning: () => processing,
    startScheduler,
    runJob,
    requestAbort: (reason: string) => {
      abortVersion += 1;
      abortReason = reason;
      queue.length = 0;
    },
    clearAbort
  };

  function clearAbort(): void {
    abortReason = null;
  }
}
