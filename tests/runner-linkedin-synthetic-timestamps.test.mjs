import test from "node:test";
import assert from "node:assert/strict";
import {
  findSyntheticClusters,
  resolveClusterAnchor
} from "../apps/runner/dist/scripts/repair-linkedin-synthetic-timestamps.js";

// Issue #407 / pilot R-0042. Before the adapter fix, when LinkedIn's
// per-message timestamp parser failed, the adapter synthesised
// fallbacks 1 second apart. These tests cover the cluster detector
// used by the one-shot repair script.

function ts(iso) {
  return new Date(iso);
}

function sequential(startIso, count, stepMs = 1_000) {
  const start = new Date(startIso).getTime();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(new Date(start + i * stepMs));
  }
  return out;
}

test("findSyntheticClusters: 4+ rows ~1s apart are a cluster", () => {
  const clusters = findSyntheticClusters(sequential("2026-05-28T15:00:00.000Z", 5));
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0], { startIndex: 0, endIndex: 4 });
});

test("findSyntheticClusters: 3 rows ~1s apart is NOT a cluster (below threshold)", () => {
  const clusters = findSyntheticClusters(sequential("2026-05-28T15:00:00.000Z", 3));
  assert.equal(clusters.length, 0);
});

test("findSyntheticClusters: real-looking gaps break runs", () => {
  // 5 rows 1s apart, then a 5-minute gap, then 5 rows 1s apart again
  const cluster1 = sequential("2026-05-28T15:00:00.000Z", 5);
  const cluster2 = sequential("2026-05-28T15:05:00.000Z", 5);
  const clusters = findSyntheticClusters([...cluster1, ...cluster2]);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0], { startIndex: 0, endIndex: 4 });
  assert.deepEqual(clusters[1], { startIndex: 5, endIndex: 9 });
});

test("findSyntheticClusters: a single non-1s gap inside an otherwise-1s run splits it", () => {
  const timestamps = [
    ts("2026-05-28T15:00:00.000Z"),
    ts("2026-05-28T15:00:01.000Z"),
    ts("2026-05-28T15:00:02.000Z"),
    ts("2026-05-28T15:00:03.000Z"),
    // 30s gap (real conversation pace)
    ts("2026-05-28T15:00:33.000Z"),
    ts("2026-05-28T15:00:34.000Z"),
    ts("2026-05-28T15:00:35.000Z"),
    ts("2026-05-28T15:00:36.000Z")
  ];
  const clusters = findSyntheticClusters(timestamps);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0], { startIndex: 0, endIndex: 3 });
  assert.deepEqual(clusters[1], { startIndex: 4, endIndex: 7 });
});

test("findSyntheticClusters: 1.1s and 0.9s tolerance — still detects clusters", () => {
  // Mix of 950ms and 1050ms gaps — within the ±100ms tolerance window
  const timestamps = [
    ts("2026-05-28T15:00:00.000Z"),
    ts("2026-05-28T15:00:00.950Z"),
    ts("2026-05-28T15:00:02.000Z"),
    ts("2026-05-28T15:00:03.050Z"),
    ts("2026-05-28T15:00:04.000Z")
  ];
  const clusters = findSyntheticClusters(timestamps);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0], { startIndex: 0, endIndex: 4 });
});

test("findSyntheticClusters: 1.5s spacing is NOT detected as synthetic (real-pace messages)", () => {
  const timestamps = [
    ts("2026-05-28T15:00:00.000Z"),
    ts("2026-05-28T15:00:01.500Z"),
    ts("2026-05-28T15:00:03.000Z"),
    ts("2026-05-28T15:00:04.500Z"),
    ts("2026-05-28T15:00:06.000Z")
  ];
  const clusters = findSyntheticClusters(timestamps);
  assert.equal(clusters.length, 0);
});

// Regression for the repair anchoring bug: a synthetic cluster that is
// NOT the thread's last cluster must stay inside its own local range. If
// it were anchored to thread.lastMessageAt it would jump on top of (or
// past) the later real messages and reorder the thread.

test("resolveClusterAnchor: last cluster (covers final row) anchors to lastMessageAt", () => {
  const timestamps = sequential("2026-05-28T15:00:00.000Z", 5); // indices 0..4
  const cluster = { startIndex: 0, endIndex: 4 };
  const lastMessageAt = ts("2026-06-01T09:30:00.000Z");
  const anchor = resolveClusterAnchor(cluster, timestamps, lastMessageAt);
  assert.equal(anchor.getTime(), lastMessageAt.getTime());
});

test("resolveClusterAnchor: earlier cluster anchors to its own tail, NOT lastMessageAt", () => {
  // 5 synthetic rows (0..4), then 2 later real messages (5,6).
  const synthetic = sequential("2026-05-28T15:00:00.000Z", 5);
  const later = [ts("2026-05-30T10:00:00.000Z"), ts("2026-06-01T09:30:00.000Z")];
  const timestamps = [...synthetic, ...later];
  const cluster = { startIndex: 0, endIndex: 4 };
  // thread.lastMessageAt is the latest real message.
  const lastMessageAt = ts("2026-06-01T09:30:00.000Z");

  const anchor = resolveClusterAnchor(cluster, timestamps, lastMessageAt);

  // Must anchor to the cluster's own tail (index 4), not lastMessageAt.
  assert.equal(anchor.getTime(), timestamps[4].getTime());
  assert.notEqual(anchor.getTime(), lastMessageAt.getTime());
  // And the cluster's anchored tail must stay strictly before the next
  // real message, so the repair never reorders the thread.
  assert.ok(anchor.getTime() < timestamps[5].getTime());
});

test("resolveClusterAnchor: only the cluster ending on the final row is treated as last", () => {
  // Two synthetic clusters separated by a real-pace gap; 7 rows total.
  const first = sequential("2026-05-28T15:00:00.000Z", 4); // indices 0..3
  const second = sequential("2026-05-28T15:05:00.000Z", 3); // indices 4..6 (real msgs after first cluster)
  const timestamps = [...first, ...second];
  const lastMessageAt = ts("2026-06-01T09:30:00.000Z");

  const earlier = resolveClusterAnchor({ startIndex: 0, endIndex: 3 }, timestamps, lastMessageAt);
  const last = resolveClusterAnchor({ startIndex: 4, endIndex: 6 }, timestamps, lastMessageAt);

  // Earlier cluster: local-range anchor (its own tail at index 3).
  assert.equal(earlier.getTime(), timestamps[3].getTime());
  // Cluster covering the final row: anchored to lastMessageAt.
  assert.equal(last.getTime(), lastMessageAt.getTime());
});
