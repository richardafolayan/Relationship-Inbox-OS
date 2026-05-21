import test from "node:test";
import assert from "node:assert/strict";

// pilot.ts is framework-free (no React import), so the tsx loader can
// resolve this .ts import directly — see test:all in the root package.json.
const {
  FEEDBACK_QUESTIONS,
  buildFeedbackTemplate,
  buildBugReportTemplate,
  buildGithubIssueUrl,
  describeRoute,
  extractThreadId
} = await import("../apps/dashboard/lib/pilot.ts");

test("buildFeedbackTemplate lists every feedback question, numbered", () => {
  const out = buildFeedbackTemplate();
  assert.equal(FEEDBACK_QUESTIONS.length, 6);
  FEEDBACK_QUESTIONS.forEach((question, index) => {
    assert.ok(out.includes(`${index + 1}. ${question}`), `expected "${index + 1}. ${question}"`);
  });
  assert.match(out, /Relationship Inbox OS pilot/);
});

test("buildBugReportTemplate prompts for the four bug fields and context", () => {
  const out = buildBugReportTemplate({
    route: "Thread",
    threadId: "thread-123",
    appVersion: "0.1.0",
    timestamp: "2026-05-21T10:00:00.000Z"
  });
  assert.match(out, /What were you trying to do\?/);
  assert.match(out, /What went wrong\?/);
  assert.match(out, /What did you expect to happen\?/);
  assert.match(out, /Page: Thread/);
  assert.match(out, /Thread: thread-123/);
  assert.match(out, /Version: 0\.1\.0/);
  assert.match(out, /Time: 2026-05-21T10:00:00\.000Z/);
});

test("buildBugReportTemplate omits the Thread line when off a thread page", () => {
  const out = buildBugReportTemplate({
    route: "Today",
    threadId: null,
    appVersion: "0.1.0",
    timestamp: "2026-05-21T10:00:00.000Z"
  });
  assert.doesNotMatch(out, /Thread:/);
  assert.match(out, /Page: Today/);
});

test("describeRoute maps known routes to page names testers recognise", () => {
  assert.equal(describeRoute("/today"), "Today");
  assert.equal(describeRoute("/"), "Today");
  assert.equal(describeRoute("/inbox"), "Inbox");
  assert.equal(describeRoute("/thread/abc"), "Thread");
  assert.equal(describeRoute("/archived"), "Archived");
  assert.equal(describeRoute("/settings"), "Settings");
  assert.equal(describeRoute("/unknown"), "/unknown");
});

test("extractThreadId returns the id only on a thread route", () => {
  assert.equal(extractThreadId("/thread/abc-123"), "abc-123");
  assert.equal(extractThreadId("/thread/abc-123?focus=1"), "abc-123");
  assert.equal(extractThreadId("/today"), null);
  assert.equal(extractThreadId("/"), null);
  assert.equal(extractThreadId(""), null);
});

test("buildGithubIssueUrl targets the right issue form per mode", () => {
  const bug = buildGithubIssueUrl("bug", "hello");
  assert.match(bug, /\/issues\/new\?/);
  assert.match(bug, /template=pilot-bug\.yml/);
  const feedback = buildGithubIssueUrl("feedback", "hello");
  assert.match(feedback, /template=pilot-feedback\.yml/);
});

test("buildGithubIssueUrl url-encodes the details into the details param", () => {
  const url = buildGithubIssueUrl("bug", "line one\nline two & more");
  const details = new URL(url).searchParams.get("details");
  // The body round-trips intact through the query param (no leakage, no
  // truncation) and special characters are encoded, not raw.
  assert.equal(details, "line one\nline two & more");
  assert.doesNotMatch(url, /line one\nline two/);
});
