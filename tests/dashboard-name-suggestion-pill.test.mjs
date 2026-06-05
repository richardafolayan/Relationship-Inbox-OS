import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The "Maybe <name>" pill's confirm/rename/dismiss handler used to do a bare
// `await apiPost(...)` with no catch, so any failure (e.g. a duplicate/stale
// confirm) bubbled out as an unhandled rejection onto Next.js's dev error
// overlay - the bug the operator hit. Every dashboard action must funnel
// through `runAction`, which captures the error into local state instead. See
// dashboard-run-action.test.mjs for the helper's own contract.

const src = readFileSync(
  fileURLToPath(
    new URL("../apps/dashboard/components/common/name-suggestion-pill.tsx", import.meta.url)
  ),
  "utf8"
);

test("name-suggestion-pill funnels its action through runAction", () => {
  assert.match(src, /import\s*\{[^}]*\brunAction\b[^}]*\}\s*from\s*"@\/lib\/api"/);
  assert.match(src, /runAction\s*\(/);
});

test("name-suggestion-pill never does a bare uncaught apiPost", () => {
  // The old shape that leaked rejections to the dev overlay.
  assert.doesNotMatch(
    src,
    /await\s+apiPost\s*\(/,
    "use runAction(apiPost(...), setError, ...) instead of `await apiPost`"
  );
});

test("name-suggestion-pill guards against double-fire", () => {
  // `disabled={busy}` is render-deferred; a synchronous ref guard stops a fast
  // double-click from sending a duplicate confirm.
  assert.match(src, /busyRef/);
});

test("name-suggestion-pill surfaces errors inline", () => {
  assert.match(src, /setError\b/);
  assert.match(src, /\{error\}/, "the captured error must be rendered, not just stored");
});
