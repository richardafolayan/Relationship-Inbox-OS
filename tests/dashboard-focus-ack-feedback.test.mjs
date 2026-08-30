import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = await Promise.all([
  "focus-inbox-group.tsx",
  "focus-thread-strip.tsx",
  "focus-review-sheet.tsx"
].map(async (name) => ({
  name,
  source: await readFile(
    new URL(`../apps/dashboard/components/common/focus/${name}`, import.meta.url),
    "utf8"
  )
})));
const focusHookSource = await readFile(
  new URL("../apps/dashboard/lib/use-focus-window.ts", import.meta.url),
  "utf8"
);

test("every manual focus-note surface shows delivery failures inline", () => {
  for (const { name, source } of files) {
    assert.match(source, /error instanceof Error \? error\.message/,
      `${name} must preserve the delivery failure message`);
    assert.match(source, /role="alert"/,
      `${name} must announce the failure without making the operator guess`);
    assert.match(source, /text-risk-overdue/,
      `${name} must visibly distinguish the failure`);
  }
});

test("a focus note that fails after queueing is not silently retried", () => {
  const retryGuard = focusHookSource.slice(
    focusHookSource.indexOf("catch (error)"),
    focusHookSource.indexOf("const retry =", focusHookSource.indexOf("catch (error)"))
  );
  assert.match(retryGuard, /queued\.status !== "FAILED"/);
  assert.match(retryGuard, /!error\.status\.retrySafe/);
});
