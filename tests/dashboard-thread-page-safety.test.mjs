import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The thread page is a stateful client component with heavy live wiring
// (polling, SSE, object-URL attachments), so these invariants are pinned at
// the source level — the same static-assertion approach as
// dashboard-rail-reply-workspace.test.mjs.
const src = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/thread/[id]/page.tsx", import.meta.url)),
  "utf8"
);

// A: the page does NOT remount when navigating /thread/A -> /thread/B (same
// App Router dynamic segment), so thread-local composer + AI state must reset
// on threadId change or it leaks across threads — risking a reply typed for A
// being sent to B, phantom "sending" bubbles, and A's snooze durations on B.
test("a [threadId]-keyed effect resets the composer cluster, pending sends, and snooze suggestions", () => {
  const effectBodies = [
    ...src.matchAll(/useEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[threadId\]\)/g)
  ].map((m) => m[1]);
  const reset = effectBodies.find(
    (body) =>
      body.includes('setComposer("")') &&
      body.includes("setPendingSends([])") &&
      body.includes("setSnoozeSuggestions(null)") &&
      body.includes("setComposerAttachments(")
  );
  assert.ok(reset, "expected a [threadId] reset effect clearing composer + pending sends + snooze");
  // Staged attachment object URLs must be revoked on the reset, not leaked.
  assert.match(reset, /URL\.revokeObjectURL\(a\.previewUrl\)/);
});

// The timeline must never scroll horizontally. overflow-y-auto alone makes
// the browser compute overflow-x as auto, so one message holding a long
// unbroken token (Airbnb links in real pilot data; URL segments get
// break-all anchors, but plain text had no word-breaking) widened the
// column and put a horizontal scrollbar under the chat that dragged the
// sticky header along. Two layers: bubble text breaks long tokens, and
// the scroller clips the x axis.
test("the timeline scroller clips horizontal overflow and bubble text wraps anywhere", () => {
  assert.match(
    src,
    /className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden"/,
    "timeline scroller must keep overflow-x-hidden alongside overflow-y-auto"
  );
  const preWrapLines = src
    .split("\n")
    .filter((line) => line.includes("whitespace-pre-wrap"));
  assert.ok(preWrapLines.length >= 5, "expected the known pre-wrap text blocks");
  for (const line of preWrapLines) {
    assert.ok(
      line.includes("[overflow-wrap:anywhere]"),
      `pre-wrap text block must also break long unbroken tokens: ${line.trim()}`
    );
  }
});

// Double-send guard: the only re-entrancy guard was the async `sending` state,
// which a held Cmd+Enter autorepeat (or click+shortcut in one frame) defeats,
// enqueueing two distinct clientSendIds. A synchronous ref closes the gap.
test("onSend has a synchronous sendingRef re-entrancy guard", () => {
  assert.match(src, /const sendingRef = useRef\(false\)/);
  assert.match(src, /if \(!thread \|\| sending \|\| sendingRef\.current\) return;/);
  assert.match(src, /sendingRef\.current = true;/);
  assert.match(src, /sendingRef\.current = false;/);
});
