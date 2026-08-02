import test from "node:test";
import assert from "node:assert/strict";
import {
  AdminResetGuardError,
  resetPlatformInboxGraph,
  validateAdminResetGuards
} from "../apps/runner/dist/services/admin-reset.js";

function withEnv(overrides, run) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("admin reset guard enforces dev-only + token + RESET confirmation", () =>
  withEnv(
    {
      NODE_ENV: "production",
      ADMIN_RESET_ENABLED: undefined,
      ADMIN_RESET_TOKEN: "secret"
    },
    () => {
      assert.throws(
        () => validateAdminResetGuards({ token: "secret", confirm: "RESET" }),
        (error) => error instanceof AdminResetGuardError && error.code === "reset_disabled"
      );
    }
  ));

test("admin reset guard rejects missing token or bad confirmation", () =>
  withEnv(
    {
      NODE_ENV: "development",
      ADMIN_RESET_ENABLED: undefined,
      ADMIN_RESET_TOKEN: "secret"
    },
    () => {
      assert.throws(
        () => validateAdminResetGuards({ token: "wrong", confirm: "RESET" }),
        (error) => error instanceof AdminResetGuardError && error.code === "invalid_reset_token"
      );
      assert.throws(
        () => validateAdminResetGuards({ token: "secret", confirm: "nope" }),
        (error) => error instanceof AdminResetGuardError && error.code === "invalid_reset_confirmation"
      );
      assert.doesNotThrow(() => validateAdminResetGuards({ token: "secret", confirm: "RESET" }));
    }
  ));

test("admin reset applies platform-scoped deletes and removes only orphan people", async () => {
  const calls = [];
  const mockPrisma = {
    thread: {
      findMany: async (args) => {
        calls.push({ model: "thread.findMany", args });
        return [{ id: "thread-1" }, { id: "thread-2" }];
      },
      deleteMany: async (args) => {
        calls.push({ model: "thread.deleteMany", args });
        return { count: 2 };
      }
    },
    sendRequest: {
      deleteMany: async (args) => {
        calls.push({ model: "sendRequest.deleteMany", args });
        return { count: 3 };
      }
    },
    draft: {
      deleteMany: async (args) => {
        calls.push({ model: "draft.deleteMany", args });
        return { count: 4 };
      }
    },
    message: {
      deleteMany: async (args) => {
        calls.push({ model: "message.deleteMany", args });
        return { count: 5 };
      }
    },
    person: {
      findMany: async (args) => {
        calls.push({ model: "person.findMany", args });
        return [{ id: "orphan-person" }];
      },
      deleteMany: async (args) => {
        calls.push({ model: "person.deleteMany", args });
        return { count: 1 };
      }
    }
  };
  mockPrisma.$transaction = async (work) => work(mockPrisma);

  const result = await resetPlatformInboxGraph("LINKEDIN", mockPrisma);

  assert.equal(result.platform, "LINKEDIN");
  assert.equal(result.matchedThreadCount, 2);
  assert.deepEqual(result.deleted, {
    sendRequests: 3,
    drafts: 4,
    messages: 5,
    threads: 2,
    orphanPeople: 1
  });

  const sendDelete = calls.find((entry) => entry.model === "sendRequest.deleteMany");
  const draftDelete = calls.find((entry) => entry.model === "draft.deleteMany");
  const messageDelete = calls.find((entry) => entry.model === "message.deleteMany");
  const threadDelete = calls.find((entry) => entry.model === "thread.deleteMany");
  const personDelete = calls.find((entry) => entry.model === "person.deleteMany");

  assert.equal(sendDelete.args.where.thread.platform, "LINKEDIN");
  assert.equal(draftDelete.args.where.thread.platform, "LINKEDIN");
  assert.equal(messageDelete.args.where.thread.platform, "LINKEDIN");
  assert.equal(threadDelete.args.where.platform, "LINKEDIN");
  assert.deepEqual(personDelete.args.where.id.in, ["orphan-person"]);
});
