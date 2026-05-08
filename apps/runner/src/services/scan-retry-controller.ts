export type ScanRetryPlatform = "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";

const allPlatforms: ScanRetryPlatform[] = ["LINKEDIN", "INSTAGRAM", "TIKTOK", "IMESSAGE"];

interface PlatformCooldownState {
  consecutiveFailures: number;
  cooldownUntilMs: number;
}

interface PlatformReloadGuardState {
  windowStartMs: number;
  reloadAttempts: number;
}

interface ScanRetryTraceEvent {
  action:
    | "cooldown_check"
    | "cooldown_check_all"
    | "mark_success"
    | "mark_failure"
    | "reload_guard_attempt"
    | "reload_guard_blocked";
  platform?: ScanRetryPlatform;
  details: Record<string, unknown>;
}

export interface ScanCooldownStatus {
  blocked: boolean;
  retryAfterSeconds: number;
  platform?: ScanRetryPlatform;
}

export function resolveScanBackoffSeconds(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) {
    return 0;
  }
  if (consecutiveFailures === 1) {
    return 30;
  }
  if (consecutiveFailures === 2) {
    return 60;
  }
  return 120;
}

export class ScanRetryController {
  private readonly cooldownByPlatform = new Map<ScanRetryPlatform, PlatformCooldownState>();
  private readonly reloadGuardByPlatform = new Map<ScanRetryPlatform, PlatformReloadGuardState>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly reloadWindowMs = 5 * 60 * 1000,
    private readonly maxReloadAttemptsPerWindow = 3,
    private readonly onTraceEvent?: (event: ScanRetryTraceEvent) => void
  ) {}

  getCooldown(platform?: ScanRetryPlatform): ScanCooldownStatus {
    if (platform) {
      const row = this.cooldownByPlatform.get(platform);
      if (!row || row.cooldownUntilMs <= this.now()) {
        this.trace({
          action: "cooldown_check",
          platform,
          details: {
            blocked: false,
            retryAfterSeconds: 0,
            consecutiveFailures: row?.consecutiveFailures ?? 0
          }
        });
        return { blocked: false, retryAfterSeconds: 0, platform };
      }
      const retryAfterSeconds = Math.max(1, Math.ceil((row.cooldownUntilMs - this.now()) / 1000));
      this.trace({
        action: "cooldown_check",
        platform,
        details: {
          blocked: true,
          retryAfterSeconds,
          consecutiveFailures: row.consecutiveFailures
        }
      });
      return {
        blocked: true,
        retryAfterSeconds,
        platform
      };
    }

    let retryAfterSeconds = 0;
    for (const candidate of allPlatforms) {
      const row = this.cooldownByPlatform.get(candidate);
      if (!row || row.cooldownUntilMs <= this.now()) {
        this.trace({
          action: "cooldown_check_all",
          details: {
            blocked: false,
            retryAfterSeconds: 0
          }
        });
        return { blocked: false, retryAfterSeconds: 0 };
      }
      const seconds = Math.max(1, Math.ceil((row.cooldownUntilMs - this.now()) / 1000));
      retryAfterSeconds = retryAfterSeconds === 0 ? seconds : Math.min(retryAfterSeconds, seconds);
    }

    this.trace({
      action: "cooldown_check_all",
      details: {
        blocked: true,
        retryAfterSeconds
      }
    });
    return {
      blocked: true,
      retryAfterSeconds
    };
  }

  markSuccess(platform: ScanRetryPlatform): void {
    this.cooldownByPlatform.set(platform, {
      consecutiveFailures: 0,
      cooldownUntilMs: 0
    });
    this.trace({
      action: "mark_success",
      platform,
      details: {
        consecutiveFailures: 0,
        retryAfterSeconds: 0
      }
    });
  }

  markFailure(platform: ScanRetryPlatform): { retryAfterSeconds: number; consecutiveFailures: number } {
    const row = this.cooldownByPlatform.get(platform) ?? {
      consecutiveFailures: 0,
      cooldownUntilMs: 0
    };
    const consecutiveFailures = row.consecutiveFailures + 1;
    const retryAfterSeconds = resolveScanBackoffSeconds(consecutiveFailures);
    this.cooldownByPlatform.set(platform, {
      consecutiveFailures,
      cooldownUntilMs: retryAfterSeconds > 0 ? this.now() + retryAfterSeconds * 1_000 : 0
    });
    this.trace({
      action: "mark_failure",
      platform,
      details: {
        consecutiveFailures,
        retryAfterSeconds
      }
    });
    return {
      retryAfterSeconds,
      consecutiveFailures
    };
  }

  registerReloadAttempt(platform: ScanRetryPlatform, attempts = 1): { blocked: boolean; retryAfterSeconds: number } {
    if (attempts <= 0) {
      this.trace({
        action: "reload_guard_attempt",
        platform,
        details: {
          attempts,
          blocked: false,
          retryAfterSeconds: 0
        }
      });
      return {
        blocked: false,
        retryAfterSeconds: 0
      };
    }

    const nowMs = this.now();
    const current = this.reloadGuardByPlatform.get(platform) ?? {
      windowStartMs: nowMs,
      reloadAttempts: 0
    };

    if (nowMs - current.windowStartMs >= this.reloadWindowMs) {
      current.windowStartMs = nowMs;
      current.reloadAttempts = 0;
    }

    current.reloadAttempts += attempts;
    this.reloadGuardByPlatform.set(platform, current);

    if (current.reloadAttempts <= this.maxReloadAttemptsPerWindow) {
      this.trace({
        action: "reload_guard_attempt",
        platform,
        details: {
          attempts,
          windowStartMs: current.windowStartMs,
          reloadAttempts: current.reloadAttempts,
          blocked: false,
          retryAfterSeconds: 0
        }
      });
      return {
        blocked: false,
        retryAfterSeconds: 0
      };
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((this.reloadWindowMs - (nowMs - current.windowStartMs)) / 1_000)
    );
    this.trace({
      action: "reload_guard_blocked",
      platform,
      details: {
        attempts,
        windowStartMs: current.windowStartMs,
        reloadAttempts: current.reloadAttempts,
        blocked: true,
        retryAfterSeconds
      }
    });
    return {
      blocked: true,
      retryAfterSeconds
    };
  }

  private trace(event: ScanRetryTraceEvent): void {
    this.onTraceEvent?.(event);
  }
}
