import { sendHelperRequest } from "./helper-bridge";

/**
 * `isReachable()`: did the helper bundle inject, and does its socket answer a
 * `ping`? This gates every native send — so it must be cheap.
 *
 * Latency profile (why this satisfies the "sub-100ms" acceptance bar):
 * - Disabled  → returns false synchronously, never touches the socket.
 * - Enabled, socket file missing / no listener → connect() fails on the next
 *   tick (ENOENT / ECONNREFUSED), ~0-1ms.
 * - Enabled, helper healthy → one local UNIX-socket ping round-trip, ~1-5ms.
 * - Enabled, helper hung (accepts connect, never replies) → the only case
 *   that can exceed 100ms; bounded by `probeTimeoutMs` and then cached.
 *
 * Results (positive and negative) are cached for `cacheMs` so a burst of
 * sends doesn't re-probe per call. Staleness is harmless: a cached-true that
 * just went down means the real send's own connect fails fast and falls
 * back; a cached-false that just came up is noticed within `cacheMs`.
 */
export interface HealthProbeOptions {
  enabled: boolean;
  socketPath: string;
  /** Short timeout for the ping probe specifically (kept well under a send). */
  probeTimeoutMs: number;
  /** How long to cache a probe result. */
  cacheMs: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface HealthProbe {
  isReachable(): Promise<boolean>;
  /** Drop the cached result so the next call re-probes (used after a send
   * fails with a transport error — the helper likely went away). */
  invalidate(): void;
}

export function createHealthProbe(options: HealthProbeOptions): HealthProbe {
  const now = options.now ?? Date.now;
  let cached: { value: boolean; at: number } | null = null;
  // Coalesce concurrent probes into one in-flight round-trip.
  let inflight: Promise<boolean> | null = null;

  async function probe(): Promise<boolean> {
    try {
      await sendHelperRequest(
        { socketPath: options.socketPath, timeoutMs: options.probeTimeoutMs },
        "ping",
        {} as never
      );
      return true;
    } catch {
      return false;
    }
  }

  return {
    async isReachable(): Promise<boolean> {
      if (!options.enabled) {
        return false;
      }
      const ts = now();
      if (cached && ts - cached.at < options.cacheMs) {
        return cached.value;
      }
      if (inflight) {
        return inflight;
      }
      inflight = probe()
        .then((value) => {
          cached = { value, at: now() };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    invalidate(): void {
      cached = null;
    }
  };
}
