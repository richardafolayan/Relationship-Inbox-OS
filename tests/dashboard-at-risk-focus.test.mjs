import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import below.
const { nextFocusIndexAfterMarkHandled } = await import(
  "../apps/dashboard/lib/at-risk-focus.ts"
);

// Regression: At Risk reply-focus "mark handled" used to call advance()
// (focusIndex + 1) AFTER archiving. Archiving refreshes the inbox, which drops
// the handled thread from the list and slides the next thread into the current
// focusIndex — so advancing as well skipped that next thread. The fix keeps the
// focus index unchanged after a mark-handled.

test("mark handled does NOT advance the focus index (next thread not skipped)", () => {
  for (const idx of [0, 1, 2, 5]) {
    assert.equal(
      nextFocusIndexAfterMarkHandled(idx),
      idx,
      `focus index ${idx} should stay put after mark-handled, not jump to ${idx + 1}`
    );
  }
});

test("mark handled never reproduces the old skip-by-one behaviour", () => {
  // The bug was: returned index === focusIndex + 1. Pin that it never does.
  for (const idx of [0, 1, 3, 10]) {
    const next = nextFocusIndexAfterMarkHandled(idx);
    assert.notEqual(next, idx + 1, `index ${idx} must not advance to ${idx + 1}`);
  }
});

test("marking the last thread handled leaves the index pointing past the shrunk list", () => {
  // With `total` threads (indices 0..total-1), marking the last one handled
  // shrinks the list to length `total - 1`. The kept index (total - 1) now
  // points past the end, so sortedAtRisk[index] is undefined and the caller's
  // focusDone branch shows "All done." — verify the helper keeps that index.
  const total = 3;
  const lastIndex = total - 1; // 2
  const next = nextFocusIndexAfterMarkHandled(lastIndex);
  const remainingLength = total - 1; // 2 after the handled thread drops out
  assert.equal(next, lastIndex);
  assert.ok(
    next >= remainingLength,
    "after handling the last thread the index points past the shrunk list (focusDone)"
  );
});
