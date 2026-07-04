import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

test("a thread that wrapped on short gratitude is off-queue", () => {
  assert.equal(
    isInTodayQueue(
      baseRow({ lastMessageDirection: "IN", preview: "Thanks for lending it to me that night" }),
      none
    ),
    false
  );
});

test("AppShell sidebar badge uses the Today queue predicate, not raw risk buckets", () => {
  const appShellPath = fileURLToPath(
    new URL("../apps/dashboard/components/layout/app-shell.tsx", import.meta.url)
  );
  const source = readFileSync(appShellPath, "utf8");
  assert.match(source, /isInTodayQueue\(row, new Set\(\)\)/);
  assert.doesNotMatch(
    source,
    /row\.riskLevel === "RED" \|\| row\.riskLevel === "AMBER"/
  );
});

test("sidebar and dock show a single warm dot, never a counter", () => {
  // PRODUCT.md: "urgency is communicated through quiet rank and a single
  // warm dot, not red badges, counters, or alarm". The Today count lives on
  // the Today page itself ("N need you tonight"); nav surfaces only signal
  // presence. Regression: the sidebar once rendered a capped "99+" pill.
  for (const rel of [
    "../apps/dashboard/components/layout/sidebar.tsx",
    "../apps/dashboard/components/layout/mobile-dock.tsx"
  ]) {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /99\+/, `${rel} must not cap-render a counter`);
    assert.doesNotMatch(
      source,
      /\{\s*(attentionCount|badge)\s*\}/,
      `${rel} must not render the attention count as text`
    );
    assert.match(
      source,
      /rounded-full bg-accent/,
      `${rel} should render the warm presence dot`
    );
  }
});
