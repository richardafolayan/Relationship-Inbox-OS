import test from "node:test";
import assert from "node:assert/strict";
import { resolveClusterAnchor } from "../apps/runner/dist/scripts/repair-linkedin-synthetic-timestamps.js";

// Regression for the synthetic-timestamp repair reordering a thread.
//
// repair-linkedin-synthetic-timestamps anchors a synthetic cluster's tail onto
// thread.lastMessageAt. Done unconditionally for EVERY cluster, an earlier
// cluster's synthetic rows get jumped onto lastMessageAt — landing on top of
// (or past) the later real messages and reordering the thread. resolveClusterAnchor
// fixes that: only the genuinely-last cluster (endIndex === timestamps.length-1)
// may anchor to lastMessageAt; any earlier cluster anchors to its OWN tail, so the
// loop's divergence check is 0 for it and it is left untouched.

const d = (iso) => new Date(iso);

test("the last cluster anchors to thread.lastMessageAt", () => {
  const timestamps = [d("2026-01-01T10:00:00Z"), d("2026-01-01T10:01:00Z"), d("2026-06-01T09:00:00Z")];
  const lastMessageAt = d("2026-06-01T09:05:00Z");
  // cluster covering the final row (index 2 === length-1)
  const anchor = resolveClusterAnchor({ startIndex: 2, endIndex: 2 }, timestamps, lastMessageAt);
  assert.equal(anchor.getTime(), lastMessageAt.getTime(), "last cluster -> lastMessageAt");
});

test("a NON-last cluster anchors to its own tail, NOT lastMessageAt (no reorder)", () => {
  const timestamps = [
    d("2026-03-01T10:00:00Z"), // cluster A tail (index 1)
    d("2026-03-01T10:01:00Z"),
    d("2026-05-01T12:00:00Z"), // a later REAL message after cluster A
    d("2026-06-01T09:00:00Z")
  ];
  const lastMessageAt = d("2026-06-01T09:05:00Z");
  // cluster A ends at index 1, which is NOT the last index (3)
  const anchor = resolveClusterAnchor({ startIndex: 0, endIndex: 1 }, timestamps, lastMessageAt);
  assert.equal(anchor.getTime(), timestamps[1].getTime(), "non-last cluster -> its own tail");
  assert.notEqual(anchor.getTime(), lastMessageAt.getTime(), "must NOT jump onto lastMessageAt");
  // and crucially it must not land at/after the later real message at index 2
  assert.ok(anchor.getTime() < timestamps[2].getTime(), "anchor stays before the later real message");
});

test("single-cluster thread (cluster IS the last) still anchors to lastMessageAt", () => {
  const timestamps = [d("2026-06-01T08:00:00Z"), d("2026-06-01T08:01:00Z")];
  const lastMessageAt = d("2026-06-02T00:00:00Z");
  const anchor = resolveClusterAnchor({ startIndex: 0, endIndex: 1 }, timestamps, lastMessageAt);
  assert.equal(anchor.getTime(), lastMessageAt.getTime());
});
