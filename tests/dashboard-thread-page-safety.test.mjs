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
  assert.match(src, /if \(!thread \|\| sending \|\| sendingRef\.current\) return;/);
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

// #885. Outgoing LinkedIn messages stay editable when they carry text plus
// an attachment or inline link card. Those rich rows use a transparent
// surface (no dark bubble), so Cancel/Save must not keep paper-on-accent
// colours that vanish against the page.
test("LinkedIn edit controls branch contrast on transparent rich surfaces", () => {
  assert.match(
    src,
    /const canEdit\s*=\s*\n?\s*thread\.platform === "LINKEDIN" && message\.direction === "OUT" && showText/
  );
  // Cancel: ink on transparent, paper on bubble.
  assert.match(
    src,
    /usesTransparentRichSurface\s*\?\s*"inline-flex h-\[30px\][^\"]*text-ink-2[^\"]*hover:bg-paper-2[^\"]*hover:text-ink[^\"]*"\s*:\s*"inline-flex h-\[30px\][^\"]*text-paper\/75[^\"]*hover:bg-paper\/10[^\"]*hover:text-paper/
  );
  // Save: ink fill + paper text on transparent, paper fill + ink text on bubble.
  assert.match(
    src,
    /usesTransparentRichSurface\s*\?\s*"inline-flex h-\[30px\][^\"]*bg-ink[^\"]*text-paper[^\"]*"\s*:\s*"inline-flex h-\[30px\][^\"]*bg-paper[^\"]*text-ink/
  );
});
