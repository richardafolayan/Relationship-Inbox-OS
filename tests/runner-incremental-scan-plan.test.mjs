import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  adapterSupportsIncrementalScan,
  resolveIncrementalScanPlan
} from "../apps/runner/dist/services/incremental-scan.js";

// Plan resolution for the incremental scan gate: which ticks skip, which
// sync a delta, and which fall back to the full sweep. The watermark a plan
// carries must always be the one captured BEFORE sync work - the scan loop
// persists it only after a clean run, so mid-scan changes are never lost.

const stub = (id) => ({ platformThreadId: id, displayName: id, lastMessagePreview: "" });

function fakeAdapter(overrides = {}) {
  return {
    platform: "IMESSAGE",
    ensureConnected: async () => {},
    scanUnreadThreads: async () => [],
    fetchRecentThreads: async () => [],
    fetchThreadMessages: async () => [],
    sendMessage: async () => ({ ok: true }),
    openThread: async () => {},
    closeSession: async () => {},
    ...overrides
  };
}

test("adapters without the capability always plan a full sweep", async () => {
  const adapter = fakeAdapter();
  assert.equal(adapterSupportsIncrementalScan(adapter), false);
  const plan = await resolveIncrementalScanPlan(adapter, "imsg1:1:1:0");
  assert.deepEqual(plan, { mode: "full", reason: "adapter_no_capability", watermark: null });
});

test("no stored watermark -> full sweep, but the captured watermark is carried for persistence", async () => {
  const adapter = fakeAdapter({
    getScanWatermark: async () => "imsg1:10:10:5",
    collectChangedThreads: async () => ({ stubs: [], fullSweepRequired: false })
  });
  const plan = await resolveIncrementalScanPlan(adapter, null);
  assert.deepEqual(plan, { mode: "full", reason: "no_stored_watermark", watermark: "imsg1:10:10:5" });
});

test("unchanged watermark -> skip", async () => {
  const adapter = fakeAdapter({
    getScanWatermark: async () => "imsg1:10:10:5",
    collectChangedThreads: async () => {
      throw new Error("must not be called when the watermark is unchanged");
    }
  });
  const plan = await resolveIncrementalScanPlan(adapter, "imsg1:10:10:5");
  assert.deepEqual(plan, { mode: "skip", watermark: "imsg1:10:10:5" });
});

test("changed watermark -> delta with exactly the changed stubs", async () => {
  const calls = [];
  const adapter = fakeAdapter({
    getScanWatermark: async () => "imsg1:12:12:5",
    collectChangedThreads: async (since) => {
      calls.push(since);
      return { stubs: [stub("chat-b")], fullSweepRequired: false };
    }
  });
  const plan = await resolveIncrementalScanPlan(adapter, "imsg1:10:10:5");
  assert.equal(plan.mode, "delta");
  assert.equal(plan.watermark, "imsg1:12:12:5");
  assert.deepEqual(plan.stubs.map((s) => s.platformThreadId), ["chat-b"]);
  assert.deepEqual(calls, ["imsg1:10:10:5"], "delta is derived from the STORED watermark");
});

test("adapter-requested full sweep and capability errors all degrade to full", async () => {
  const sweep = await resolveIncrementalScanPlan(
    fakeAdapter({
      getScanWatermark: async () => "imsg1:12:11:5",
      collectChangedThreads: async () => ({ stubs: [], fullSweepRequired: true })
    }),
    "imsg1:10:10:5"
  );
  assert.deepEqual(sweep, { mode: "full", reason: "delta_unavailable", watermark: "imsg1:12:11:5" });

  const watermarkBroken = await resolveIncrementalScanPlan(
    fakeAdapter({
      getScanWatermark: async () => {
        throw new Error("chat.db locked");
      },
      collectChangedThreads: async () => ({ stubs: [], fullSweepRequired: false })
    }),
    "imsg1:10:10:5"
  );
  assert.deepEqual(watermarkBroken, { mode: "full", reason: "watermark_unavailable", watermark: null });

  const deltaBroken = await resolveIncrementalScanPlan(
    fakeAdapter({
      getScanWatermark: async () => "imsg1:12:12:5",
      collectChangedThreads: async () => {
        throw new Error("boom");
      }
    }),
    "imsg1:10:10:5"
  );
  assert.deepEqual(deltaBroken, { mode: "full", reason: "delta_failed", watermark: "imsg1:12:12:5" });
});

test("scan loop wiring: gate consulted in the collect phase, watermark persisted only on a clean run", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(
    join(here, "../apps/runner/src/services/scan-queue.ts"),
    "utf8"
  );
  assert.ok(
    /resolveIncrementalScanPlan\(adapter, storedWatermark\)/.test(source),
    "scan loop resolves the incremental plan"
  );
  assert.ok(
    /capturedScanWatermark\s*&&\s*threadFailures === 0\s*&&\s*!candidateCapBroke\s*&&\s*freshnessComplete/.test(source),
    "watermark advances only when every candidate was processed without failures or quarantines"
  );
  assert.ok(
    /saveScanWatermark\(platform, capturedScanWatermark\)/.test(source),
    "the persisted value is the watermark captured BEFORE the scan's sync work"
  );
});
