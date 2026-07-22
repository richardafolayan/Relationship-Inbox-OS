import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Static-source regression for three cross-thread state-race fixes on the thread
// page (which does NOT remount across /thread/A -> /thread/B). These assertions
// fail if a guard is removed — the protective value the helper unit test alone
// cannot provide, since the page handlers aren't unit-mountable here.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, "..", "apps", "dashboard", "app", "thread", "[id]", "page.tsx"), "utf8");

test("compose + ask snapshot the thread id before the await and guard the write", () => {
  // both async handlers must snapshot startThreadId and gate their state write
  const composeBlock = SRC.slice(SRC.indexOf("const composeFromIntent"), SRC.indexOf("const askAi"));
  assert.match(composeBlock, /const startThreadId = threadId;/, "composeFromIntent snapshots startThreadId");
  assert.match(composeBlock, /shouldApplyThreadScopedResult\(startThreadId, routeThreadIdRef\.current\)\)\s*return;\s*\n\s*setComposeDraft\(output\.text\)/, "compose guards setComposeDraft");

  const askBlock = SRC.slice(SRC.indexOf("const askAi"), SRC.indexOf("const useDraft"));
  assert.match(askBlock, /const startThreadId = threadId;/, "askAi snapshots startThreadId");
  assert.match(askBlock, /shouldApplyThreadScopedResult\(startThreadId, routeThreadIdRef\.current\)\)\s*return;\s*\n\s*setAskAnswer/, "ask guards setAskAnswer");
});

test("reassess failures stay out of the inline thread error surface", () => {
  const reassessBlock = SRC.slice(SRC.indexOf("const reassessThread"), SRC.indexOf("const reactToMessage"));
  assert.match(reassessBlock, /showToast\(\{\s*kind: "error",\s*title: "Reassess failed"/, "reassess failure uses the toast surface");
  assert.doesNotMatch(reassessBlock, /setError\(message\)/, "reassess failure must not render as inline thread error");
});

test("a dismissed AI predraft is not re-injected on the next refresh", () => {
  assert.match(SRC, /const predraftDismissedRef = useRef<Set<string>>\(new Set\(\)\)/, "predraftDismissedRef declared");
  // dismissed in both Discard and Delete-draft
  assert.match(SRC, /predraftDismissedRef\.current\.add\(threadId\)/, "Discard adds to the dismissed latch");
  assert.match(SRC, /predraftDismissedRef\.current\.add\(thread\.id\)/, "Delete-draft adds to the dismissed latch");
  // cleared on navigation
  assert.match(SRC, /predraftDismissedRef\.current\.delete\(threadId\)/, "reset effect clears the latch");
  // applyThread skips the predraft branch when dismissed
  assert.match(SRC, /!predraftDismissedRef\.current\.has\(routeThreadIdRef\.current\)/, "applyThread skips a dismissed predraft");
});
