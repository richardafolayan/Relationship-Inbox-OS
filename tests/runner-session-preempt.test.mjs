import test from "node:test";
import assert from "node:assert/strict";
import { createSessionCoordinator } from "../apps/runner/dist/services/session-coordinator.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("SessionCoordinator preempts all platform sessions and records diagnostics", async () => {
  const abortReasons = [];
  const auditCalls = [];
  const closed = [];

  const coordinator = createSessionCoordinator({
    adapters: {
      LINKEDIN: {
        closeSession: async (reason) => {
          closed.push({ platform: "LINKEDIN", reason });
        }
      },
      INSTAGRAM: {
        closeSession: async (reason) => {
          closed.push({ platform: "INSTAGRAM", reason });
        }
      },
      TIKTOK: {
        closeSession: async (reason) => {
          closed.push({ platform: "TIKTOK", reason });
        }
      }
    },
    scanQueue: {
      requestAbort: (reason) => {
        abortReasons.push(reason);
      }
    },
    auditLog: async (input) => {
      auditCalls.push(input);
      return String(auditCalls.length);
    }
  });

  const summary = await coordinator.preemptAll({
    triggerAction: "TEST_SELECTORS",
    platform: "LINKEDIN"
  });

  assert.equal(abortReasons.length, 1);
  assert.equal(abortReasons[0], "session_preempt:test_selectors");
  assert.deepEqual(
    closed.map((row) => row.platform).sort(),
    ["INSTAGRAM", "LINKEDIN", "TIKTOK"]
  );
  assert.deepEqual(summary.closedPlatforms.sort(), ["INSTAGRAM", "LINKEDIN", "TIKTOK"]);
  assert.equal(summary.failedPlatforms.length, 0);
  assert.equal(auditCalls.length, 2);
  assert.equal(auditCalls[0].action, "SESSION_PREEMPT_START");
  assert.equal(auditCalls[1].action, "SESSION_PREEMPT_OK");
});

test("SessionCoordinator serializes concurrent preemption requests with a mutex", async () => {
  const auditActions = [];
  const firstClose = createDeferred();
  let closeCalls = 0;

  const coordinator = createSessionCoordinator({
    adapters: {
      LINKEDIN: {
        closeSession: async () => {
          closeCalls += 1;
          if (closeCalls === 1) {
            await firstClose.promise;
          }
        }
      },
      INSTAGRAM: {
        closeSession: async () => {
          closeCalls += 1;
        }
      },
      TIKTOK: {
        closeSession: async () => {
          closeCalls += 1;
        }
      }
    },
    scanQueue: {
      requestAbort: () => undefined
    },
    auditLog: async (input) => {
      auditActions.push(input.action);
      return String(auditActions.length);
    }
  });

  const first = coordinator.preemptAll({
    triggerAction: "CONNECT",
    platform: "LINKEDIN"
  });
  const second = coordinator.preemptAll({
    triggerAction: "OPEN_BROWSER",
    platform: "INSTAGRAM"
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(auditActions[0], "SESSION_PREEMPT_START");
  assert.equal(auditActions.includes("SESSION_PREEMPT_OK"), false);

  firstClose.resolve();
  await Promise.all([first, second]);

  assert.equal(auditActions.filter((action) => action === "SESSION_PREEMPT_START").length, 2);
  assert.equal(auditActions.filter((action) => action === "SESSION_PREEMPT_OK").length, 2);
});
