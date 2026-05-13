import test from "node:test";
import assert from "node:assert/strict";
import { resolveActionTargetThreadIds } from "../apps/runner/dist/services/thread-action-targets.js";

function fakePrisma(threadsById, siblingsByKey) {
  const findUniqueCalls = [];
  const findManyCalls = [];
  return {
    thread: {
      async findUnique({ where }) {
        findUniqueCalls.push(where.id);
        return threadsById.get(where.id) ?? null;
      },
      async findMany({ where }) {
        const key = `${where.platform}:${where.personId}`;
        findManyCalls.push(key);
        return siblingsByKey.get(key) ?? [];
      }
    },
    _findUniqueCalls: findUniqueCalls,
    _findManyCalls: findManyCalls
  };
}

test("iMessage action propagates to every sibling thread for the same person", async () => {
  const prisma = fakePrisma(
    new Map([
      ["t-phone", { id: "t-phone", platform: "IMESSAGE", personId: "p-1" }]
    ]),
    new Map([
      ["IMESSAGE:p-1", [{ id: "t-phone" }, { id: "t-email" }, { id: "t-group" }]]
    ])
  );
  const targets = await resolveActionTargetThreadIds(prisma, "t-phone");
  assert.deepEqual(new Set(targets), new Set(["t-phone", "t-email", "t-group"]));
});

test("iMessage with no siblings falls back to the single thread id", async () => {
  const prisma = fakePrisma(
    new Map([
      ["t-only", { id: "t-only", platform: "IMESSAGE", personId: "p-1" }]
    ]),
    new Map([
      ["IMESSAGE:p-1", []]
    ])
  );
  const targets = await resolveActionTargetThreadIds(prisma, "t-only");
  assert.deepEqual(targets, ["t-only"]);
});

test("LinkedIn action does NOT fan out to sibling threads", async () => {
  const prisma = fakePrisma(
    new Map([
      ["t-li-a", { id: "t-li-a", platform: "LINKEDIN", personId: "p-1" }]
    ]),
    new Map([
      ["LINKEDIN:p-1", [{ id: "t-li-a" }, { id: "t-li-b" }]]
    ])
  );
  const targets = await resolveActionTargetThreadIds(prisma, "t-li-a");
  assert.deepEqual(targets, ["t-li-a"]);
  assert.equal(prisma._findManyCalls.length, 0, "should not look up siblings for non-iMessage");
});

test("unknown thread id round-trips itself so the route can 404 downstream", async () => {
  const prisma = fakePrisma(new Map(), new Map());
  const targets = await resolveActionTargetThreadIds(prisma, "missing");
  assert.deepEqual(targets, ["missing"]);
});
