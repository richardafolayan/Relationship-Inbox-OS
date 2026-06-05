import test from "node:test";
import assert from "node:assert/strict";
import { checkPresenterGuard } from "../apps/runner/dist/middleware/presenter-guard.js";

// Live-mode read-only blocks every guarded mutation with a 403 +
// "presenter-readonly" payload. Exit paths (settings + presenter-demo
// reset) live outside the guard wiring — those are covered by routing
// inspection in the index file. This test exercises the helper itself.

function makeRes() {
  return {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function makeStore({ presenterReadOnly = false, presenterDemoMode = "off", manifest = null } = {}) {
  return {
    async getSettings() {
      return { presenterReadOnly, presenterDemoMode };
    },
    async getDemoSeedManifest() {
      return manifest;
    }
  };
}

test("read-only blocks thread-mutation with presenter-readonly", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore({ presenterReadOnly: true }), {
    threadId: "anything",
    action: "archive",
    kind: "thread-mutation"
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "presenter-readonly");
  assert.equal(res.body.action, "archive");
});

test("read-only blocks external-action with presenter-readonly", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore({ presenterReadOnly: true }), {
    action: "run a scan",
    kind: "external-action"
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "presenter-readonly");
});

test("read-only blocks operator-write with presenter-readonly", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore({ presenterReadOnly: true }), {
    action: "save your profile",
    kind: "operator-write"
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
});

test("read-only off passes thread mutations through", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore(), {
    threadId: "any",
    action: "archive",
    kind: "thread-mutation"
  });
  assert.equal(handled, false);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.body, undefined);
});
