import test from "node:test";
import assert from "node:assert/strict";

const { shouldInterceptLive, describeInterceptedAction, isExitPath } = await import(
  "../apps/dashboard/lib/full-demo-fetch.ts"
);

// H7 regression. The live-mode interceptor is the dashboard's first line of
// read-only defence. It previously used an allow-list that silently omitted
// real mutation endpoints (remind, open, react, favourite, open-profile,
// transcribe, analyze-style, overdue-digest) — those POSTs sailed through to
// the runner during a live demo, mutating real threads and spending real AI
// budget. The fix is default-deny: every non-GET /control/ request is blocked
// unless it is an explicit exit path.

// Every endpoint that the pre-fix allow-list omitted. These FAIL before the
// fix (shouldInterceptLive returns false) and PASS after.
const PREVIOUSLY_OMITTED = [
  "/runner/control/thread/abc/remind",
  "/runner/control/thread/abc/open",
  "/runner/control/thread/abc/message/m1/react",
  "/runner/control/person/p1/favourite",
  "/runner/control/person/p1/open-profile",
  "/runner/control/message/m1/transcribe",
  "/runner/control/operator-profile/analyze-style",
  "/runner/control/overdue-digest/settings",
  "/runner/control/overdue-digest/tick",
  "/runner/control/overdue-digest/ack",
  "/runner/control/overdue-digest/dismiss-today",
  "/runner/control/overdue-digest/snooze-person",
  "/runner/control/overdue-digest/unsnooze-person"
];

for (const path of PREVIOUSLY_OMITTED) {
  test(`POST ${path} is intercepted in live mode`, () => {
    assert.equal(shouldInterceptLive("POST", path), true);
  });
}

test("default-deny: an unlisted future /control mutation is intercepted", () => {
  // No matcher and no exit-path entry — the allow-list approach would have
  // let this through. Default-deny blocks it.
  assert.equal(
    shouldInterceptLive("POST", "/runner/control/thread/abc/some-future-action"),
    true
  );
  assert.equal(shouldInterceptLive("POST", "/runner/control/brand-new-endpoint"), true);
});

test("non-GET verbs to /control are also intercepted", () => {
  assert.equal(shouldInterceptLive("PUT", "/runner/control/thread/abc/remind"), true);
  assert.equal(shouldInterceptLive("DELETE", "/runner/control/person/p1/favourite"), true);
  assert.equal(shouldInterceptLive("PATCH", "/runner/control/overdue-digest/settings"), true);
});

test("GET requests are never intercepted, even for newly-covered paths", () => {
  assert.equal(shouldInterceptLive("GET", "/runner/control/thread/abc/remind"), false);
  assert.equal(shouldInterceptLive("GET", "/runner/control/thread/abc/suggest-snooze"), false);
  assert.equal(shouldInterceptLive("GET", "/runner/data/inbox"), false);
});

test("exit / recovery paths still pass through in live mode", () => {
  for (const path of [
    "/runner/control/settings",
    "/runner/control/presenter-demo/reset",
    "/runner/control/scan/abort",
    "/runner/control/pilot-feedback"
  ]) {
    assert.equal(isExitPath(path), true, `${path} should be an exit path`);
    assert.equal(shouldInterceptLive("POST", path), false, `${path} should pass through`);
  }
});

test("non-/control requests are never intercepted (dashboard-internal calls)", () => {
  // The interceptor patches window.fetch globally; it must only gate runner
  // /control proxies, never the dashboard's own Next /api routes.
  assert.equal(shouldInterceptLive("POST", "/api/some-next-route"), false);
  assert.equal(shouldInterceptLive("POST", "/runner/data/refresh"), false);
});

test("the omitted endpoints now resolve a human-readable toast verb", () => {
  assert.equal(describeInterceptedAction("/runner/control/thread/abc/remind"), "set a reminder");
  assert.equal(
    describeInterceptedAction("/runner/control/thread/abc/message/m1/react"),
    "react to a message"
  );
  assert.equal(
    describeInterceptedAction("/runner/control/person/p1/favourite"),
    "favourite the contact"
  );
  assert.equal(
    describeInterceptedAction("/runner/control/operator-profile/analyze-style"),
    "analyse your writing style"
  );
  assert.equal(
    describeInterceptedAction("/runner/control/overdue-digest/snooze-person"),
    "change overdue-digest settings"
  );
});

test("analyze-style does not collide with the operator-profile save verb", () => {
  // The more specific analyze-style matcher must win over /operator-profile$.
  assert.equal(
    describeInterceptedAction("/runner/control/operator-profile"),
    "save your profile"
  );
  assert.notEqual(
    describeInterceptedAction("/runner/control/operator-profile/analyze-style"),
    "save your profile"
  );
});
