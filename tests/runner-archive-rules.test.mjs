import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runnerIndex = readFileSync("apps/runner/src/index.ts", "utf8");
const scanQueue = readFileSync("apps/runner/src/services/scan-queue.ts", "utf8");

test("mark handled clears reply state without changing archive state", () => {
  const route = runnerIndex.match(
    /app\.post\("\/control\/thread\/:threadId\/mark-done"[\s\S]*?\n\}\)\);/
  );

  assert.ok(route, "mark-done route not found");
  assert.match(route[0], /needsReply:\s*false/);
  assert.doesNotMatch(route[0], /archivedAt/);
});

test("scanning new messages preserves an archived thread's archive state", () => {
  assert.doesNotMatch(scanQueue, /decideArchivedResurface/);
  assert.doesNotMatch(scanQueue, /\?\s*\{\s*archivedAt:\s*null\s*\}/);
});
