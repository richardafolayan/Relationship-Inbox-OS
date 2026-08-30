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
// App Router dynamic segment), so thread-local intent must be saved/restored
// on threadId change and pending sends must be filtered to their owner thread.
test("a thread-keyed layout effect restores intent and isolates pending sends", () => {
  const effectBodies = [
    ...src.matchAll(
      /useLayoutEffect\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[composerAttachmentStore, externalActionAttempts, threadId\]\)/g
    )
  ].map((m) => m[1]);
  const reset = effectBodies.find(
    (body) =>
      body.includes("readThreadComposerSession(threadId)") &&
      body.includes("setComposer(restoredIntent.text)") &&
      body.includes("setSnoozeSuggestions(null)") &&
      body.includes("setComposerAttachments(")
  );
  assert.ok(reset, "expected per-thread composer restoration and local UI reset");
  assert.match(reset, /URL\.revokeObjectURL\(a\.previewUrl\)/);
  assert.doesNotMatch(reset, /setPendingSends\(\[\]\)/);
  assert.match(
    src,
    /const activePendingSends = pendingSends\.filter\(\(pending\) => pending\.threadId === threadId\)/
  );
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
    /className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"/,
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
  const start = src.indexOf("const onSend = useCallback(async () => {");
  const end = src.indexOf("if (!composer.trim()", start);
  assert.notEqual(start, -1, "located onSend");
  assert.notEqual(end, -1, "located the end of the onSend entry guard");
  const guard = src.slice(start, end);
  assert.match(guard, /sendingRef\.current/);
  assert.match(guard, /composerActionRef\.current/);
  assert.match(src, /sendingRef\.current = true;/);
  assert.match(src, /sendingRef\.current = false;/);
});

test("rich messages drop the message bubble chrome", () => {
  assert.match(
    src,
    /const usesTransparentRichSurface\s*=\s*hasInlineMedia \|\| Boolean\(whatsappPoll\) \|\| Boolean\(inlineCardUrl\)/
  );
  assert.match(src, /usesTransparentRichSurface\s*\?\s*"flex flex-col gap-2[^\"]*text-ink"/);
  assert.match(src, /bg-ink text-paper/); // bubble bg still exists for the non-image branch
});
