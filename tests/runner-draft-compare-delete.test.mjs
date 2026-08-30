import assert from "node:assert/strict";
import test from "node:test";

import { deleteDraftRevision } from "../apps/runner/src/services/draft.ts";

function harness(initial) {
  let draft = initial;
  return {
    prisma: {
      draft: {
        async deleteMany({ where }) {
          if (
            draft &&
            draft.threadId === where.threadId &&
            draft.text === where.text &&
            draft.updatedAt.getTime() === where.updatedAt.getTime()
          ) {
            draft = null;
            return { count: 1 };
          }
          return { count: 0 };
        }
      }
    },
    read: () => draft
  };
}

test("a stale tab cannot delete a newer cross-tab draft", async () => {
  const newer = {
    threadId: "thread-a",
    text: "Newer draft B",
    updatedAt: new Date("2026-08-30T09:05:00.000Z")
  };
  const h = harness(newer);

  assert.equal(
    await deleteDraftRevision(h.prisma, "thread-a", {
      text: "Older draft A",
      updatedAt: "2026-08-30T09:00:00.000Z"
    }),
    false
  );
  assert.deepEqual(h.read(), newer);
});

test("an exact observed draft revision can be deleted", async () => {
  const observed = {
    threadId: "thread-a",
    text: "Observed draft",
    updatedAt: new Date("2026-08-30T09:05:00.000Z")
  };
  const h = harness(observed);

  assert.equal(
    await deleteDraftRevision(h.prisma, "thread-a", {
      text: observed.text,
      updatedAt: observed.updatedAt.toISOString()
    }),
    true
  );
  assert.equal(h.read(), null);
});
