import type { PlatformName } from "@inbox-os/core";

export interface PlatformChangeSignal {
  reason: string;
  sourceChangedAt: string;
  platformThreadId?: string;
}

interface EnqueueResult {
  ok: boolean;
  reason?: "cooldown_active" | "in_flight";
  retryAfterSeconds?: number;
}

interface ChangeTriggeredScanDeps {
  platform: PlatformName;
  debounceMs: number;
  enqueue: (signal: PlatformChangeSignal) => EnqueueResult;
  log?: (line: string) => void;
}

interface PendingSignal {
  signal: PlatformChangeSignal;
  timer: ReturnType<typeof setTimeout> | null;
}

function earlierIso(left: string, right: string): string {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return leftMs <= rightMs ? left : right;
}

export function createChangeTriggeredScan(deps: ChangeTriggeredScanDeps): {
  notify(signal: PlatformChangeSignal): void;
  stop(): void;
  pendingCount(): number;
} {
  const pending = new Map<string, PendingSignal>();
  const log = deps.log ?? (() => undefined);
  let stopped = false;

  const keyFor = (signal: PlatformChangeSignal): string => signal.platformThreadId ?? "*";

  function schedule(key: string, delayMs: number): void {
    const entry = pending.get(key);
    if (!entry || stopped) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flush(key), Math.max(0, delayMs));
    entry.timer.unref?.();
  }

  function flush(key: string): void {
    const entry = pending.get(key);
    if (!entry || stopped) return;
    entry.timer = null;
    const result = deps.enqueue(entry.signal);
    if (result.ok) {
      pending.delete(key);
      return;
    }

    const retryMs =
      result.reason === "cooldown_active"
        ? Math.max(deps.debounceMs, (result.retryAfterSeconds ?? 1) * 1_000)
        : Math.max(deps.debounceMs, 500);
    log(
      `[${deps.platform.toLowerCase()}-change-trigger] enqueue blocked (${result.reason ?? "unknown"}); retrying in ${retryMs}ms`
    );
    schedule(key, retryMs);
  }

  return {
    notify(signal): void {
      if (stopped) return;
      const key = keyFor(signal);
      const current = pending.get(key);
      if (current) {
        current.signal = {
          ...signal,
          reason: current.signal.reason === signal.reason
            ? signal.reason
            : `${current.signal.reason},${signal.reason}`,
          sourceChangedAt: earlierIso(current.signal.sourceChangedAt, signal.sourceChangedAt)
        };
        schedule(key, deps.debounceMs);
        return;
      }
      pending.set(key, { signal, timer: null });
      schedule(key, deps.debounceMs);
    },
    stop(): void {
      stopped = true;
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      pending.clear();
    },
    pendingCount(): number {
      return pending.size;
    }
  };
}
