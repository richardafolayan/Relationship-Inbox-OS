import test from "node:test";
import assert from "node:assert/strict";

// pilot.ts is framework-free, so the tsx loader resolves this .ts import
// directly. mergeScreenshots is the pure cap-accounting helper the pilot
// feedback modal calls inside its setState functional updater, so the
// capacity check runs against the freshest committed array rather than a
// stale length captured before an async file read.
const { mergeScreenshots, MAX_SCREENSHOTS } = await import("../apps/dashboard/lib/pilot.ts");

const shot = (id) => ({ id });
const many = (n) => Array.from({ length: n }, (_, i) => shot(`s${i}`));

test("mergeScreenshots keeps everything when under the cap", () => {
  const { merged, overflow } = mergeScreenshots([shot("a")], [shot("b")]);
  assert.equal(merged.length, 2);
  assert.equal(overflow, false);
  assert.deepEqual(
    merged.map((s) => s.id),
    ["a", "b"]
  );
});

test("mergeScreenshots caps at MAX_SCREENSHOTS and flags overflow", () => {
  const { merged, overflow } = mergeScreenshots([], many(MAX_SCREENSHOTS + 2));
  assert.equal(merged.length, MAX_SCREENSHOTS);
  assert.equal(overflow, true);
});

test("mergeScreenshots flags overflow when prev is already full", () => {
  const { merged, overflow } = mergeScreenshots(many(MAX_SCREENSHOTS), [shot("x")]);
  assert.equal(merged.length, MAX_SCREENSHOTS);
  assert.equal(overflow, true);
});

test("sequential merges (the concurrent-drop race) cannot silently exceed the cap", () => {
  // Reproduces the bug: invocation A and invocation B each pick a batch that
  // individually fits, but their committed results, applied in sequence to
  // the freshest array, must still cap and signal overflow rather than
  // dropping images with no feedback.
  const batchA = many(3).map((s, i) => shot(`a${i}`));
  const batchB = many(3).map((s, i) => shot(`b${i}`));

  const a = mergeScreenshots([], batchA); // 0 -> 3, no overflow
  assert.equal(a.merged.length, 3);
  assert.equal(a.overflow, false);

  const b = mergeScreenshots(a.merged, batchB); // 3 -> capped at MAX, overflow
  assert.equal(b.merged.length, MAX_SCREENSHOTS);
  assert.equal(b.overflow, true);
});
