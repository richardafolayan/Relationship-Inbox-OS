import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { mergeSavedDraftRevision } from "../apps/dashboard/lib/saved-draft-revision.ts";

test("the authoritative saved draft revision replaces the page's stale revision", () => {
  const current = {
    id: "thread-a",
    draft: "Old text",
    draftUpdatedAt: "2026-08-30T09:00:00.000Z",
    personName: "Serena"
  };
  assert.deepEqual(
    mergeSavedDraftRevision(current, "thread-a", {
      text: "Send this exact draft",
      updatedAt: "2026-08-30T09:05:00.000Z"
    }),
    {
      ...current,
      draft: "Send this exact draft",
      draftUpdatedAt: "2026-08-30T09:05:00.000Z"
    }
  );
});

test("a late save response cannot overwrite another route", () => {
  const current = {
    id: "thread-b",
    draft: "B",
    draftUpdatedAt: "2026-08-30T09:06:00.000Z"
  };
  assert.equal(
    mergeSavedDraftRevision(current, "thread-a", {
      text: "A",
      updatedAt: "2026-08-30T09:07:00.000Z"
    }),
    current
  );
});

test("the draft endpoint returns the exact persisted revision used by send consumption", () => {
  const runner = readFileSync(
    resolve(process.cwd(), "apps/runner/src/index.ts"),
    "utf8"
  );
  const start = runner.indexOf('app.post("/control/thread/:threadId/draft"');
  const end = runner.indexOf('app.post("/control/thread/:threadId/delete-draft"', start);
  const route = runner.slice(start, end);
  assert.match(route, /const draft = await prisma\.draft\.upsert/);
  assert.match(route, /select: \{ text: true, updatedAt: true \}/);
  assert.match(route, /draft: \{ text: draft\.text, updatedAt: draft\.updatedAt\.toISOString\(\) \}/);
});
