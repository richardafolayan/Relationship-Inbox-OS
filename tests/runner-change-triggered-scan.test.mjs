import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createChangeTriggeredScan } from "../apps/runner/dist/services/change-triggered-scan.js";

test("change-triggered scans coalesce bursts per target and keep the earliest source time", async () => {
  const enqueued = [];
  const coordinator = createChangeTriggeredScan({
    platform: "WHATSAPP",
    debounceMs: 10,
    enqueue: (signal) => {
      enqueued.push(signal);
      return { ok: true };
    }
  });

  coordinator.notify({
    reason: "first",
    sourceChangedAt: "2026-07-10T10:00:00.000Z",
    platformThreadId: "group@g.us"
  });
  coordinator.notify({
    reason: "second",
    sourceChangedAt: "2026-07-10T10:00:00.010Z",
    platformThreadId: "group@g.us"
  });
  await delay(30);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].sourceChangedAt, "2026-07-10T10:00:00.000Z");
  assert.equal(enqueued[0].platformThreadId, "group@g.us");
  assert.match(enqueued[0].reason, /first/);
  assert.match(enqueued[0].reason, /second/);
  coordinator.stop();
});

test("cooldown blocks are retried instead of dropping the platform change", async () => {
  let attempts = 0;
  const coordinator = createChangeTriggeredScan({
    platform: "IMESSAGE",
    debounceMs: 5,
    enqueue: () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, reason: "cooldown_active", retryAfterSeconds: 0 }
        : { ok: true };
    }
  });
  coordinator.notify({ reason: "chat.db-wal", sourceChangedAt: new Date().toISOString() });
  await delay(30);

  assert.equal(attempts, 2);
  assert.equal(coordinator.pendingCount(), 0);
  coordinator.stop();
});
