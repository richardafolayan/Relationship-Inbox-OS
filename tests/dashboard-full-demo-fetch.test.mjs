import test from "node:test";
import assert from "node:assert/strict";

const {
  shouldInterceptLive,
  describeInterceptedAction,
  isExitPath,
  LIVE_INTERCEPTED_PATHS
} = await import("../apps/dashboard/lib/full-demo-fetch.ts");

// The live-mode fetch interceptor is the dashboard's first line of
// defence. The runner's checkPresenterGuard catches anything that slips
// past. These tests cover the pure path-matcher: GETs always pass,
// exit paths always pass, and listed mutation paths get intercepted.

test("GET requests are never intercepted, no matter the path", () => {
  assert.equal(shouldInterceptLive("GET", "/runner/control/thread/abc/send"), false);
  assert.equal(shouldInterceptLive("GET", "/runner/data/inbox"), false);
});

test("POST to /control/settings is never intercepted (exit path)", () => {
  assert.equal(shouldInterceptLive("POST", "/runner/control/settings"), false);
});

test("POST to /control/presenter-demo/reset is never intercepted (exit path)", () => {
  assert.equal(shouldInterceptLive("POST", "/runner/control/presenter-demo/reset"), false);
});

test("POST to /control/scan/abort is never intercepted (recovery path)", () => {
  assert.equal(shouldInterceptLive("POST", "/runner/control/scan/abort"), false);
});

test("POST to /control/pilot-feedback is never intercepted (feedback always allowed)", () => {
  assert.equal(shouldInterceptLive("POST", "/runner/control/pilot-feedback"), false);
});

test("isExitPath agrees with the always-allowed set", () => {
  assert.equal(isExitPath("/runner/control/settings"), true);
  assert.equal(isExitPath("/runner/control/presenter-demo/reset"), true);
  assert.equal(isExitPath("/runner/control/thread/abc/send"), false);
});

const MUTATION_SAMPLES = [
  ["POST", "/runner/control/thread/abc/send", "send a message"],
  ["POST", "/runner/control/thread/abc/archive", "archive the thread"],
  ["POST", "/runner/control/thread/abc/snooze", "snooze the thread"],
  ["POST", "/runner/control/thread/abc/mark-done", "mark the thread handled"],
  ["POST", "/runner/control/thread/abc/draft", "save a draft"],
  ["POST", "/runner/control/thread/abc/predraft", "request an AI predraft"],
  ["POST", "/runner/control/thread/abc/check-draft", "check draft coverage"],
  ["POST", "/runner/control/thread/abc/open-loop", "edit the reply checklist"],
  ["POST", "/runner/control/thread/abc/rescan", "rescan the thread"],
  ["POST", "/runner/control/closed-status/refresh-stale", "refresh closed verdicts"],
  ["POST", "/runner/control/reconnect/refresh-scores", "refresh reconnect scores"],
  ["POST", "/runner/control/platform/connect", "connect a platform"],
  ["POST", "/runner/control/platform/test-selectors", "run selector tests"],
  ["POST", "/runner/control/scan", "run a scan"],
  ["POST", "/runner/control/operator-profile", "save your profile"]
];

for (const [method, path, expectedVerb] of MUTATION_SAMPLES) {
  test(`${method} ${path} is intercepted`, () => {
    assert.equal(shouldInterceptLive(method, path), true);
    assert.equal(describeInterceptedAction(path), expectedVerb);
  });
}

test("intercept list is non-empty and uses regex matchers", () => {
  assert.ok(LIVE_INTERCEPTED_PATHS.length > 10);
  for (const [matcher] of LIVE_INTERCEPTED_PATHS) {
    assert.ok(matcher instanceof RegExp);
  }
});
