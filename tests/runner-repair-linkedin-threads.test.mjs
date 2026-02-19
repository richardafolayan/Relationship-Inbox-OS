import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLinkedInRepairPlan,
  canonicalizeLinkedInThreadRecord
} from "../apps/runner/dist/scripts/repair-linkedin-threads.js";

function buildRecord(overrides = {}) {
  return {
    id: "thread-1",
    platformThreadId: "linkedin-temp:1",
    threadUrl: null,
    personId: "person-1",
    createdAt: new Date("2026-02-19T08:00:00.000Z"),
    updatedAt: new Date("2026-02-19T10:00:00.000Z"),
    messageCount: 0,
    ...overrides
  };
}

test("repair planner generates dry-run merge actions for provably same canonical identity", () => {
  const plan = buildLinkedInRepairPlan([
    buildRecord({
      id: "keep",
      platformThreadId: "linkedin-temp:keep",
      threadUrl: "https://www.linkedin.com/messaging/thread/abc/",
      messageCount: 5
    }),
    buildRecord({
      id: "merge",
      platformThreadId: "linkedin-temp:merge",
      threadUrl: "https://www.linkedin.com/messaging/thread/abc/",
      messageCount: 2
    })
  ]);

  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].keepThreadId, "keep");
  assert.equal(plan.merges[0].mergeThreadId, "merge");
  assert.equal(plan.deletes.length, 0);
});

test("repair planner groups conservatively and does not merge different canonical identities", () => {
  const plan = buildLinkedInRepairPlan([
    buildRecord({
      id: "thread-a",
      platformThreadId: "linkedin-temp:a",
      threadUrl: "https://www.linkedin.com/messaging/thread/a/",
      personId: "same-person",
      messageCount: 3
    }),
    buildRecord({
      id: "thread-b",
      platformThreadId: "linkedin-temp:b",
      threadUrl: "https://www.linkedin.com/messaging/thread/b/",
      personId: "same-person",
      messageCount: 3
    })
  ]);

  assert.equal(plan.merges.length, 0);
});

test("repair planner does not delete unresolved rows by default", () => {
  const plan = buildLinkedInRepairPlan([
    buildRecord({
      id: "unresolved-zero",
      platformThreadId: "linkedin-temp:unresolved-zero",
      threadUrl: null,
      messageCount: 0
    })
  ]);

  assert.equal(plan.unresolved.length, 1);
  assert.equal(plan.deletes.length, 0);
});

test("repair planner deletes unresolved zero-message rows only with explicit flag", () => {
  const plan = buildLinkedInRepairPlan(
    [
      buildRecord({
        id: "unresolved-zero",
        platformThreadId: "linkedin-temp:unresolved-zero",
        threadUrl: null,
        messageCount: 0
      }),
      buildRecord({
        id: "unresolved-with-message",
        platformThreadId: "linkedin-temp:unresolved-msg",
        threadUrl: null,
        messageCount: 2
      })
    ],
    {
      deleteZeroMessageUnresolved: true
    }
  );

  assert.equal(plan.deletes.length, 1);
  assert.equal(plan.deletes[0].threadId, "unresolved-zero");
});

test("canonicalizeLinkedInThreadRecord resolves canonical IDs from URLs", () => {
  const canonical = canonicalizeLinkedInThreadRecord(
    buildRecord({
      platformThreadId: "linkedin-temp:1",
      threadUrl: "https://www.linkedin.com/messaging/thread/abc/"
    })
  );
  assert.equal(canonical, "abc");
});
