import test from "node:test";
import assert from "node:assert/strict";

// today.ts is framework-free, so the tsx loader resolves this .ts import
// directly (matches the dashboard-horizon.test.mjs pattern).
const { isInTodayQueue } = await import("../apps/dashboard/lib/today.ts");

const recent = () => new Date().toISOString();
const baseRow = (over = {}) => ({
  id: "t1",
  needsReply: true,
  scheduledSendAt: null,
  lastMessageAt: recent(),
  lastMessageDirection: "OUT",
  riskLevel: "AMBER",
  ...over
});
const none = new Set();

// The Today queue ("tonight's work") backs the MESSAGE_SENT handler's
// "is this thread actually in tonight's queue?" check. A send for a thread
// the queue excludes (a scheduled send firing, a dormant/closed thread
// replied to from elsewhere) must NOT advance Today's "done" counter.

test("a fresh needs-reply thread is in tonight's queue", () => {
  assert.equal(isInTodayQueue(baseRow(), none), true);
});

test("a thread with a queued scheduled send is OFF-queue", () => {
  // The exact case that inflated the counter: a scheduled send fires while
  // Today is mounted; its thread is not in the queue, so it must not count.
  assert.equal(isInTodayQueue(baseRow({ scheduledSendAt: recent() }), none), false);
});

test("a thread that no longer needs a reply is off-queue", () => {
  assert.equal(isInTodayQueue(baseRow({ needsReply: false }), none), false);
});

test("an optimistically removed thread is off-queue", () => {
  assert.equal(isInTodayQueue(baseRow({ id: "gone" }), new Set(["gone"])), false);
});

test("a dormant thread outside the recency horizon is off-queue", () => {
  const dormant = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isInTodayQueue(baseRow({ lastMessageAt: dormant }), none), false);
});

test("a thread that wrapped on a closing 'thanks!' is off-queue", () => {
  assert.equal(
    isInTodayQueue(baseRow({ lastMessageDirection: "IN", preview: "thanks!" }), none),
    false
  );
});
