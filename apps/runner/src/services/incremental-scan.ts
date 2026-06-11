import type { PlatformAdapter, ThreadStub } from "@inbox-os/core";

// Incremental scan gate (perf backlog rank 13).
//
// Platforms with a cheap upstream change signal (iMessage's chat.db) let the
// scan loop decide, per tick, between three plans:
//   - skip:  nothing changed since the last completed scan - finish the tick
//            with zero candidates (the steady-state case; ~25ms instead of
//            seconds of synchronous candidate discovery),
//   - delta: sync exactly the conversations that changed (one new iMessage
//            means 1-2 thread syncs instead of a ~30-thread sweep),
//   - full:  today's unread+recent sweep (first run after deploy, watermark
//            format change, suspected deletions, capability errors).
//
// The plan carries the watermark captured BEFORE any sync work. The caller
// persists it only after the scan completes cleanly, so a change landing
// mid-scan stays ahead of the stored watermark and is re-examined on the
// next tick rather than lost.

export type IncrementalScanPlan =
  | { mode: "full"; reason: string; watermark: string | null }
  | { mode: "skip"; watermark: string }
  | { mode: "delta"; watermark: string; stubs: ThreadStub[] };

export function adapterSupportsIncrementalScan(adapter: PlatformAdapter): boolean {
  return (
    typeof adapter.getScanWatermark === "function" &&
    typeof adapter.collectChangedThreads === "function"
  );
}

export async function resolveIncrementalScanPlan(
  adapter: PlatformAdapter,
  storedWatermark: string | null
): Promise<IncrementalScanPlan> {
  if (!adapterSupportsIncrementalScan(adapter)) {
    return { mode: "full", reason: "adapter_no_capability", watermark: null };
  }

  let captured: string;
  try {
    captured = await adapter.getScanWatermark!();
  } catch {
    // Signal unavailable (chat.db briefly locked, etc.) - scan normally and
    // try again next tick. Never let the gate make a scan fail.
    return { mode: "full", reason: "watermark_unavailable", watermark: null };
  }

  if (!storedWatermark) {
    return { mode: "full", reason: "no_stored_watermark", watermark: captured };
  }
  if (storedWatermark === captured) {
    return { mode: "skip", watermark: captured };
  }

  try {
    const delta = await adapter.collectChangedThreads!(storedWatermark);
    if (delta.fullSweepRequired) {
      return { mode: "full", reason: "delta_unavailable", watermark: captured };
    }
    return { mode: "delta", watermark: captured, stubs: delta.stubs };
  } catch {
    return { mode: "full", reason: "delta_failed", watermark: captured };
  }
}
