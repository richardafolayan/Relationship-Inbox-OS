import test from "node:test";
import assert from "node:assert/strict";

const {
  formatClientErrorMessage,
  recordClientError,
  getRecentClientError,
  RECENT_CLIENT_ERROR_WINDOW_MS,
  __resetClientErrorLogForTests
} = await import("../apps/dashboard/lib/client-error-log.ts");

test("formatClientErrorMessage handles strings, Errors, and reason objects", () => {
  assert.equal(formatClientErrorMessage("boom"), "boom");
  assert.equal(formatClientErrorMessage(new Error("kapow")), "kapow");
  assert.equal(formatClientErrorMessage({ message: "rejected" }), "rejected");
});

test("formatClientErrorMessage squashes whitespace and falls back for empties", () => {
  assert.equal(formatClientErrorMessage("  a\n  b   c "), "a b c");
  assert.equal(formatClientErrorMessage(""), "Unknown error");
  assert.equal(formatClientErrorMessage(null), "Unknown error");
  assert.equal(formatClientErrorMessage(undefined), "Unknown error");
});

test("formatClientErrorMessage truncates long messages with an ASCII marker", () => {
  const long = "x".repeat(1000);
  const out = formatClientErrorMessage(long);
  assert.ok(out.length <= 300, "message is capped at 300 chars");
  assert.ok(out.endsWith("..."), "uses an ASCII ellipsis, not a typographic one");
  assert.ok(!/[–—…]/.test(out), "no en/em dash or unicode ellipsis");
});

test("getRecentClientError only returns errors inside the window", () => {
  __resetClientErrorLogForTests();
  assert.equal(getRecentClientError(1000), null, "nothing recorded yet");

  recordClientError(new Error("recent"), 1000);
  assert.equal(getRecentClientError(1000 + 5_000), "recent", "within window");
  assert.equal(
    getRecentClientError(1000 + RECENT_CLIENT_ERROR_WINDOW_MS + 1),
    null,
    "stale errors are dropped"
  );
});

test("recordClientError keeps the most recent error", () => {
  __resetClientErrorLogForTests();
  recordClientError(new Error("first"), 1000);
  recordClientError(new Error("second"), 2000);
  assert.equal(getRecentClientError(2000), "second");
});
