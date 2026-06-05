import test from "node:test";
import assert from "node:assert/strict";
import { checkPresenterGuard } from "../apps/runner/dist/middleware/presenter-guard.js";

// Sandbox blocks every adapter-touching action (scan, rescan, platform
// connect, test-selectors, reconnect refresh, closed-status refresh,
// people/scan-all, etc.) with 403 `demo-mode-external-blocked`. The
// dispatcher branch — not the manifest check — is the safety boundary
// for adapter-touching operations: in this mode the runner refuses to
// open a browser context at all.

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

function makeStore({ presenterDemoMode = "sandbox", presenterReadOnly = false } = {}) {
  return {
    async getSettings() {
      return { presenterDemoMode, presenterReadOnly };
    },
    async getDemoSeedManifest() {
      return null;
    }
  };
}

const EXTERNAL_ACTIONS = [
  "run a scan",
  "rescan the thread",
  "connect a platform",
  "run selector tests",
  "refresh reconnect scores",
  "refresh closed verdicts",
  "scan all people",
  "enrich the contact",
  "reset the platform session",
  "run a LinkedIn smoke test",
  "open the platform browser"
];

for (const action of EXTERNAL_ACTIONS) {
  test(`sandbox: ${action} is rejected with demo-mode-external-blocked`, async () => {
    const res = makeRes();
    const handled = await checkPresenterGuard(res, makeStore(), { action, kind: "external-action" });
    assert.equal(handled, true);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "demo-mode-external-blocked");
    assert.equal(res.body.action, action);
  });
}

test("off mode: external-action is allowed", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(res, makeStore({ presenterDemoMode: "off" }), {
    action: "run a scan",
    kind: "external-action"
  });
  assert.equal(handled, false);
});

test("live read-only beats sandbox precedence: external-action returns presenter-readonly", async () => {
  const res = makeRes();
  const handled = await checkPresenterGuard(
    res,
    makeStore({ presenterDemoMode: "sandbox", presenterReadOnly: true }),
    { action: "run a scan", kind: "external-action" }
  );
  assert.equal(handled, true);
  // The read-only check fires before the sandbox external-action check,
  // so live + sandbox simultaneously surfaces the read-only error first.
  assert.equal(res.body.error, "presenter-readonly");
});
