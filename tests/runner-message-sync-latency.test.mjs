import test from "node:test";
import assert from "node:assert/strict";
import { createMessageSyncLatencyTracker } from "../apps/runner/dist/services/message-sync-latency.js";

test("latency tracker reports nearest-rank p50 and p95", () => {
  const tracker = createMessageSyncLatencyTracker();
  for (let durationMs = 1; durationMs <= 20; durationMs += 1) {
    tracker.record({ metric: "source_change_to_persisted_message", durationMs });
  }
  const summary = tracker
    .summary()
    .find((row) => row.metric === "source_change_to_persisted_message");

  assert.equal(summary.samples, 20);
  assert.equal(summary.p50Ms, 10);
  assert.equal(summary.p95Ms, 19);
});

test("send correlation measures click to terminal platform result", () => {
  const tracker = createMessageSyncLatencyTracker();
  tracker.startSend("send-1", "2026-07-10T10:00:00.000Z");
  tracker.finishSend({
    clientSendId: "send-1",
    platform: "LINKEDIN",
    outcome: "success",
    finishedAt: "2026-07-10T10:00:01.250Z"
  });

  const sample = tracker.samples()[0];
  assert.equal(sample.durationMs, 1250);
  assert.equal(sample.outcome, "success");
});
