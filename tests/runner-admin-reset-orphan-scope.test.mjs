import test from "node:test";
import assert from "node:assert/strict";
import { resetPlatformInboxGraph } from "../apps/runner/dist/services/admin-reset.js";

// Regression: a per-platform reset must only GC orphaned People of THAT
// platform. Before the fix the orphan-People findMany used
// `where: { threads: { none: {} } }` with no platform filter, so a single
// LinkedIn reset could delete a thread-less iMessage/Instagram/TikTok Person.
test("per-platform reset scopes orphan-People GC to the reset platform", async () => {
  const calls = [];
  const mockPrisma = {
    thread: {
      findMany: async (args) => {
        calls.push({ model: "thread.findMany", args });
        return [{ id: "thread-1" }];
      },
      deleteMany: async (args) => {
        calls.push({ model: "thread.deleteMany", args });
        return { count: 1 };
      }
    },
    sendRequest: {
      deleteMany: async (args) => {
        calls.push({ model: "sendRequest.deleteMany", args });
        return { count: 0 };
      }
    },
    draft: {
      deleteMany: async (args) => {
        calls.push({ model: "draft.deleteMany", args });
        return { count: 0 };
      }
    },
    message: {
      deleteMany: async (args) => {
        calls.push({ model: "message.deleteMany", args });
        return { count: 0 };
      }
    },
    person: {
      findMany: async (args) => {
        calls.push({ model: "person.findMany", args });
        return [{ id: "orphan-linkedin-person" }];
      },
      deleteMany: async (args) => {
        calls.push({ model: "person.deleteMany", args });
        return { count: 1 };
      }
    }
  };

  await resetPlatformInboxGraph("LINKEDIN", mockPrisma);

  const personFind = calls.find((entry) => entry.model === "person.findMany");
  assert.ok(personFind, "expected person.findMany to be called for orphan GC");

  // The orphan query MUST be scoped to the reset platform, otherwise it would
  // also match thread-less People on other platforms.
  assert.equal(
    personFind.args.where.platform,
    "LINKEDIN",
    "orphan-People findMany must filter by the reset platform"
  );

  // ...and it must still only consider thread-less People (the orphan check).
  assert.deepEqual(
    personFind.args.where.threads,
    { none: {} },
    "orphan-People findMany must keep the threads:{none:{}} orphan filter"
  );

  // Sanity: the follow-up delete only targets the IDs the scoped query returned.
  const personDelete = calls.find((entry) => entry.model === "person.deleteMany");
  assert.deepEqual(personDelete.args.where.id.in, ["orphan-linkedin-person"]);
});
