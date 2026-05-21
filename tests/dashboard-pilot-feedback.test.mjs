import test from "node:test";
import assert from "node:assert/strict";

// pilot.ts is framework-free, so the tsx loader resolves this .ts import
// directly — see test:all in the root package.json.
const {
  buildPilotReportPayload,
  validateScreenshotFile,
  formatReportForCopy,
  describeRoute,
  extractThreadId,
  MAX_SCREENSHOT_BYTES
} = await import("../apps/dashboard/lib/pilot.ts");

const META = {
  route: "Thread",
  pathname: "/thread/abc-123",
  threadId: "abc-123",
  appVersion: "0.1.0",
  userAgent: "test-agent",
  timestamp: "2026-05-21T10:00:00.000Z"
};

test("buildPilotReportPayload assembles only the safe fields", () => {
  const payload = buildPilotReportPayload({
    type: "bug",
    title: "  Compose button does nothing  ",
    description: "  I clicked Compose and nothing happened  ",
    expected: "  A draft should appear  ",
    privacyAck: false,
    meta: META,
    screenshot: null
  });
  // Top-level keys are a closed, safe set — there is no slot a caller
  // could use to smuggle conversation text into a report.
  assert.deepEqual(Object.keys(payload).sort(), [
    "description",
    "expected",
    "meta",
    "privacyAck",
    "screenshot",
    "title",
    "type"
  ]);
  assert.deepEqual(Object.keys(payload.meta).sort(), [
    "appVersion",
    "pathname",
    "route",
    "threadId",
    "timestamp",
    "userAgent"
  ]);
  // Typed fields are trimmed but otherwise preserved verbatim.
  assert.equal(payload.title, "Compose button does nothing");
  assert.equal(payload.description, "I clicked Compose and nothing happened");
  assert.equal(payload.expected, "A draft should appear");
  assert.equal(payload.type, "bug");
  assert.equal(payload.screenshot, null);
});

test("a report carries no message content — only typed fields and metadata", () => {
  // The meta the dashboard collects has no message-bearing field; the only
  // free text in a report is what the tester themselves typed.
  const payload = buildPilotReportPayload({
    type: "feedback",
    title: "title",
    description: "description",
    expected: "",
    privacyAck: false,
    meta: META,
    screenshot: null
  });
  const json = JSON.stringify(payload);
  for (const leak of ["messages", "rollingSummary", "preview", "lastMessage", "transcript"]) {
    assert.ok(!json.includes(leak), `payload must not carry a "${leak}" field`);
  }
  assert.equal(payload.meta.threadId, "abc-123"); // an id is fine; content is not
});

test("formatReportForCopy renders the report without message content", () => {
  const payload = buildPilotReportPayload({
    type: "bug",
    title: "Stuck on Loading",
    description: "The thread never opened",
    expected: "It should open",
    privacyAck: false,
    meta: META,
    screenshot: null
  });
  const text = formatReportForCopy(payload);
  assert.match(text, /Stuck on Loading/);
  assert.match(text, /The thread never opened/);
  assert.match(text, /no message content/i);
  assert.match(text, /Page: Thread/);
});

test("validateScreenshotFile accepts a reasonable image", () => {
  assert.deepEqual(validateScreenshotFile({ type: "image/png", size: 100_000 }), { ok: true });
  assert.deepEqual(validateScreenshotFile({ type: "image/jpeg", size: 2_000_000 }), { ok: true });
});

test("validateScreenshotFile rejects non-images", () => {
  const result = validateScreenshotFile({ type: "application/pdf", size: 1000 });
  assert.equal(result.ok, false);
});

test("validateScreenshotFile rejects oversized and empty files", () => {
  assert.equal(validateScreenshotFile({ type: "image/png", size: MAX_SCREENSHOT_BYTES + 1 }).ok, false);
  assert.equal(validateScreenshotFile({ type: "image/png", size: 0 }).ok, false);
});

test("describeRoute maps known routes to page names testers recognise", () => {
  assert.equal(describeRoute("/today"), "Today");
  assert.equal(describeRoute("/"), "Today");
  assert.equal(describeRoute("/inbox"), "Inbox");
  assert.equal(describeRoute("/thread/abc"), "Thread");
  assert.equal(describeRoute("/archived"), "Archived");
  assert.equal(describeRoute("/settings"), "Settings");
});

test("extractThreadId returns the id only on a thread route", () => {
  assert.equal(extractThreadId("/thread/abc-123"), "abc-123");
  assert.equal(extractThreadId("/thread/abc-123?focus=1"), "abc-123");
  assert.equal(extractThreadId("/today"), null);
  assert.equal(extractThreadId(""), null);
});
