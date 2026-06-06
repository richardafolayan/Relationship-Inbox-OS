import test from "node:test";
import assert from "node:assert/strict";
import { resetPlatformInboxGraph } from "../apps/runner/dist/services/admin-reset.js";

// Regression: resetPlatformInboxGraph must report accurate per-table delete
// counts. thread.deleteMany has onDelete: Cascade on Message, Draft and
// SendRequest, so under SQLite with foreign_keys enabled the parent thread
// delete natively removes those children. Originally the four deleteMany calls
// were issued together inside one Promise.all with no ordering guarantee
// relative to the cascade, so the thread delete could run first, cascade-delete
// the children, and leave the child deleteMany calls counting 0 — under-reporting
// the rows actually removed.
//
// This mock simulates the cascade deterministically: thread.deleteMany flips a
// shared `cascaded` flag synchronously at the top of its body, while each child
// deleteMany yields a microtask (await) before reading the flag and returns 0 if
// the cascade has already fired. With the buggy single Promise.all the child
// bodies suspend on their await, the thread body runs to completion first and
// sets the flag, and the children then resolve to 0. With the fix (children
// awaited fully, then the thread delete) the children read the flag while it is
// still false and return their real counts.
test("reset reports real child delete counts and does not race the thread cascade", async () => {
  const state = { cascaded: false };

  async function childDelete(realCount) {
    // Yield a microtask before observing the cascade flag. Mirrors a real
    // deleteMany round-trip that does not complete synchronously.
    await Promise.resolve();
    return { count: state.cascaded ? 0 : realCount };
  }

  const mockPrisma = {
    thread: {
      findMany: async () => [{ id: "thread-1" }, { id: "thread-2" }],
      deleteMany: async () => {
        // The native cascade removes the children as part of this delete.
        state.cascaded = true;
        return { count: 2 };
      }
    },
    sendRequest: {
      deleteMany: async () => childDelete(3)
    },
    draft: {
      deleteMany: async () => childDelete(4)
    },
    message: {
      deleteMany: async () => childDelete(5)
    },
    person: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 })
    }
  };

  const result = await resetPlatformInboxGraph("LINKEDIN", mockPrisma);

  // Each child count must reflect the rows that existed at the time of its own
  // delete, not 0-after-cascade.
  assert.equal(result.deleted.sendRequests, 3, "sendRequests count must not be zeroed by the thread cascade");
  assert.equal(result.deleted.drafts, 4, "drafts count must not be zeroed by the thread cascade");
  assert.equal(result.deleted.messages, 5, "messages count must not be zeroed by the thread cascade");
  assert.equal(result.deleted.threads, 2);
});
