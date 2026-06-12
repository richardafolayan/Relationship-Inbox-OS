import test from "node:test";
import assert from "node:assert/strict";
import { findIssueByReportId } from "../apps/runner/dist/services/github-attachments.js";

// Regression for P1-L6: findIssueByReportId must retry on a thrown
// network error, not abort. Before the fix the loop awaited fetchImpl()
// with no try/catch, so a DNS failure / connection reset / rejected 5xx
// on the first attempt propagated straight out and the remaining
// `attempts` retries were skipped — the whole attach failed on a single
// transient blip even though the issue existed and a retry would find it.

function makeThrowingThenHitStub(error, hit) {
  let callIndex = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (callIndex++ === 0) {
      throw error;
    }
    return {
      ok: true,
      status: 200,
      json: async () => hit,
      text: async () => ""
    };
  };
  fn.calls = calls;
  return fn;
}

test("findIssueByReportId: retries after a thrown network error and finds the issue", async () => {
  const fetchImpl = makeThrowingThenHitStub(
    new TypeError("fetch failed"),
    { items: [{ number: 321, title: "[Pilot feedback] Foo (R-0700)" }] }
  );
  const n = await findIssueByReportId({
    reportId: "R-0700",
    repo: "owner/name",
    token: "t",
    fetchImpl,
    attempts: 2,
    delayMs: 1
  });
  assert.equal(n, 321);
  // Proves the first throw did not abort: a second fetch was issued.
  assert.equal(fetchImpl.calls.length, 2);
});

test("findIssueByReportId: returns null (does not throw) when every attempt throws", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("ECONNRESET");
  };
  const n = await findIssueByReportId({
    reportId: "R-9999",
    repo: "owner/name",
    token: "t",
    fetchImpl,
    attempts: 3,
    delayMs: 1
  });
  assert.equal(n, null);
  // All attempts were exhausted rather than aborting on the first throw.
  assert.equal(calls, 3);
});
