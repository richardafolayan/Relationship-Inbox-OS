import type { PlatformAdapter, PlatformName } from "@inbox-os/core";

export type SessionPreemptTriggerAction = "CONNECT" | "SCAN" | "OPEN_BROWSER" | "TEST_SELECTORS";

export interface SessionPreemptSummary {
  triggerAction: SessionPreemptTriggerAction;
  requestedPlatform?: PlatformName;
  closedPlatforms: PlatformName[];
  failedPlatforms: Array<{ platform: PlatformName; reason: string }>;
  preemptDurationMs: number;
  abortReason: string;
}

interface SessionCoordinatorDeps {
  adapters: Record<PlatformName, PlatformAdapter>;
  scanQueue: {
    requestAbort: (reason: string) => void;
  };
  auditLog: (input: {
    platform?: PlatformName;
    stage?: string;
    action: string;
    status: "OK" | "FAIL";
    details?: Record<string, unknown>;
  }) => Promise<string>;
}

function stageForTriggerAction(action: SessionPreemptTriggerAction): "Connect" | "Scan" {
  if (action === "SCAN" || action === "TEST_SELECTORS") {
    return "Scan";
  }
  return "Connect";
}

export function createSessionCoordinator(deps: SessionCoordinatorDeps) {
  let lock = Promise.resolve();

  async function runLocked<T>(work: () => Promise<T>): Promise<T> {
    const previous = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release?.();
    }
  }

  async function preemptAll(input: {
    triggerAction: SessionPreemptTriggerAction;
    platform?: PlatformName;
  }): Promise<SessionPreemptSummary> {
    return runLocked(async () => {
      const startedAt = Date.now();
      const stage = stageForTriggerAction(input.triggerAction);
      const abortReason = `session_preempt:${input.triggerAction.toLowerCase()}`;

      await deps.auditLog({
        platform: input.platform,
        stage,
        action: "SESSION_PREEMPT_START",
        status: "OK",
        details: {
          triggerAction: input.triggerAction,
          requestedPlatform: input.platform ?? null,
          abortReason
        }
      });

      deps.scanQueue.requestAbort(abortReason);

      const platforms = Object.keys(deps.adapters) as PlatformName[];
      const closeResults = await Promise.allSettled(
        platforms.map(async (platform) => {
          await deps.adapters[platform].closeSession(abortReason);
          return platform;
        })
      );

      const closedPlatforms: PlatformName[] = [];
      const failedPlatforms: Array<{ platform: PlatformName; reason: string }> = [];

      closeResults.forEach((result, index) => {
        const platform = platforms[index];
        if (!platform) {
          return;
        }
        if (result.status === "fulfilled") {
          closedPlatforms.push(platform);
          return;
        }

        failedPlatforms.push({
          platform,
          reason: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      });

      const preemptDurationMs = Date.now() - startedAt;
      const action = failedPlatforms.length > 0 ? "SESSION_PREEMPT_FAIL" : "SESSION_PREEMPT_OK";

      await deps.auditLog({
        platform: input.platform,
        stage,
        action,
        status: failedPlatforms.length > 0 ? "FAIL" : "OK",
        details: {
          triggerAction: input.triggerAction,
          requestedPlatform: input.platform ?? null,
          closedPlatforms,
          failedPlatforms,
          preemptDurationMs,
          abortReason
        }
      });

      return {
        triggerAction: input.triggerAction,
        requestedPlatform: input.platform,
        closedPlatforms,
        failedPlatforms,
        preemptDurationMs,
        abortReason
      };
    });
  }

  return {
    preemptAll
  };
}
