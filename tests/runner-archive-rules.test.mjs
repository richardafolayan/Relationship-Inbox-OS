import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyHandledBoundary } from "../apps/runner/dist/services/scan-queue.js";

const runnerIndex = readFileSync("apps/runner/src/index.ts", "utf8");
const scanQueue = readFileSync("apps/runner/src/services/scan-queue.ts", "utf8");

test("mark handled clears reply state without changing archive state", () => {
  const route = runnerIndex.match(
    /app\.post\("\/control\/thread\/:threadId\/mark-done"[\s\S]*?\n\}\)\);/
  );

  assert.ok(route, "mark-done route not found");
  assert.match(route[0], /needsReply:\s*false/);
  assert.match(route[0], /handledAt:\s*new Date\(\)/);
  assert.doesNotMatch(route[0], /archivedAt/);
});

test("a scan preserves manual handled state until a newer inbound arrives", () => {
  const handledAt = new Date("2026-07-15T10:00:00Z");

  assert.deepEqual(
    applyHandledBoundary({
      needsReply: true,
      handledAt,
      lastInboundAt: new Date("2026-07-15T09:00:00Z")
    }),
    { needsReply: false, clearHandledAt: false }
  );
});

test("a newer inbound clears manual handled state and can rejoin the reply queue", () => {
  const handledAt = new Date("2026-07-15T10:00:00Z");

  assert.deepEqual(
    applyHandledBoundary({
      needsReply: true,
      handledAt,
      lastInboundAt: new Date("2026-07-15T10:00:01Z")
    }),
    { needsReply: true, clearHandledAt: true }
  );
});

test("scanning new messages preserves an archived thread's archive state", () => {
  assert.doesNotMatch(scanQueue, /decideArchivedResurface/);
  assert.doesNotMatch(scanQueue, /\?\s*\{\s*archivedAt:\s*null\s*\}/);
});
