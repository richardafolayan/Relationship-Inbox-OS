import test from "node:test";
import assert from "node:assert/strict";
import { checkPresenterGuard } from "../apps/runner/dist/middleware/presenter-guard.js";

// Sandbox presenter mode lets mutations through ONLY for manifest
// records — any other thread or person id is rejected with
// `demo-mode-foreign-thread`. This stops a sandbox presenter from
// archiving / sending / snoozing a real conversation by accidentally
// navigating to it.

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

function makeStore({
  presenterDemoMode = "sandbox",
  presenterReadOnly = false,
  manifest = { personIds: ["p-demo"], threadIds: ["t-demo"], logIds: [], screenshotFiles: [], domDumpFiles: [], seededAt: new Date().toISOString() }
} = {}) {
  return {
    async getSettings() {
      return { presenterDemoMode, presenterReadOnly };
    },
    async getDemoSeedManifest() {
      return manifest;
    }
  };
}

test("sandbox: foreign thread mutation returns demo-mode-foreign-thread", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore(), {
    threadId: "t-not-in-manifest",
    action: "archive",
    kind: "thread-mutation"
  });
  assert.equal(handled, true);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "demo-mode-foreign-thread");
});

test("sandbox: manifest thread mutation is allowed", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore(), {
    threadId: "t-demo",
    action: "archive",
    kind: "thread-mutation"
  });
  assert.equal(handled, false);
  assert.equal(res.statusCode, undefined);
});

test("sandbox: manifest person mutation is allowed", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore(), {
    personId: "p-demo",
    action: "rename the contact",
    kind: "thread-mutation"
  });
  assert.equal(handled, false);
});

test("sandbox: foreign person mutation is rejected", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore(), {
    personId: "p-not-in-manifest",
    action: "rename the contact",
    kind: "thread-mutation"
  });
  assert.equal(handled, true);
  assert.equal(res.body.error, "demo-mode-foreign-thread");
});

test("sandbox: missing manifest rejects every thread mutation", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore({ manifest: null }), {
    threadId: "t-demo",
    action: "archive",
    kind: "thread-mutation"
  });
  assert.equal(handled, true);
  assert.equal(res.body.error, "demo-mode-foreign-thread");
});

test("sandbox: operator-write is allowed (local setting, no platform fan-out)", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore(), {
    action: "save your profile",
    kind: "operator-write"
  });
  assert.equal(handled, false);
});

test("sandbox: mutation with no threadId or personId is rejected", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore(), {
    action: "do something",
    kind: "thread-mutation"
  });
  assert.equal(handled, true);
  assert.equal(res.body.error, "demo-mode-foreign-thread");
});
