import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  draftRevisionForComposerSend,
  mergeDeletedDraftRevision,
  mergeSavedDraftRevision,
  shouldClearComposerAfterDraftDelete
} from "../apps/dashboard/lib/saved-draft-revision.ts";

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

test("a delayed delete clears only the exact visible intent represented by the deleted draft", () => {
  const deletedDraft = {
    text: "Saved reply",
    updatedAt: "2026-08-30T09:05:00.000Z"
  };
  const capturedIntent = {
    attachments: [],
    customScheduleValue: "",
    replyToMessageId: null,
    source: "draft",
    text: "Saved reply"
  };

  assert.equal(
    shouldClearComposerAfterDraftDelete(
      "thread-a",
      "thread-a",
      capturedIntent,
      capturedIntent,
      deletedDraft
    ),
    true
  );
  assert.equal(
    shouldClearComposerAfterDraftDelete(
      "thread-b",
      "thread-a",
      capturedIntent,
      capturedIntent,
      deletedDraft
    ),
    false
  );
  assert.equal(
    shouldClearComposerAfterDraftDelete(
      "thread-a",
      "thread-a",
      { ...capturedIntent, text: "Newer reply" },
      capturedIntent,
      deletedDraft
    ),
    false
  );
  assert.equal(
    shouldClearComposerAfterDraftDelete(
      "thread-a",
      "thread-a",
      capturedIntent,
      { ...capturedIntent, replyToMessageId: "message-parent" },
      deletedDraft
    ),
    false
  );
});

test("a delete response clears only its target thread's authoritative draft metadata", () => {
  const threadA = {
    id: "thread-a",
    draft: "Saved reply",
    draftUpdatedAt: "2026-08-30T09:05:00.000Z"
  };
  assert.deepEqual(mergeDeletedDraftRevision(threadA, "thread-a"), {
    ...threadA,
    draft: "",
    draftUpdatedAt: null
  });

  const threadB = { ...threadA, id: "thread-b" };
  assert.equal(mergeDeletedDraftRevision(threadB, "thread-a"), threadB);
});

test("send consumes the exact draft revision from which the composer originated", () => {
  const current = {
    text: "Newer cross-tab reply B",
    updatedAt: "2026-08-30T09:05:00.000Z"
  };
  const originatedFrom = {
    text: "Saved reply A",
    updatedAt: "2026-08-30T09:00:00.000Z"
  };
  assert.deepEqual(
    draftRevisionForComposerSend(current, originatedFrom),
    originatedFrom
  );
  assert.deepEqual(
    draftRevisionForComposerSend(originatedFrom, originatedFrom),
    originatedFrom
  );
  assert.equal(draftRevisionForComposerSend(current, null), null);
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
