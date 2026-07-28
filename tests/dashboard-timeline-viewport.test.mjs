import assert from "node:assert/strict";
import test from "node:test";
import {
  snapshotTimelineViewport,
  timelineScrollTopAfterResize,
  timelineSnapshotForResize
} from "../apps/dashboard/lib/timeline-viewport.ts";

test("timeline opened at latest remains at latest through keyboard resize", () => {
  const before = {
    scrollTop: 8695,
    scrollHeight: 8959,
    clientHeight: 264
  };
  const snapshot = snapshotTimelineViewport(before);
  assert.equal(snapshot.distanceFromBottom, 0);
  assert.equal(
    timelineScrollTopAfterResize(
      snapshot,
      { scrollHeight: 8959, clientHeight: 80 },
      80
    ),
    8879
  );
});

test("timeline preserves an older reader's scrollTop through keyboard resize", () => {
  const before = {
    scrollTop: 4200,
    scrollHeight: 8959,
    clientHeight: 264
  };
  const snapshot = snapshotTimelineViewport(before);
  assert.ok(snapshot.distanceFromBottom > 80);
  assert.equal(
    timelineScrollTopAfterResize(
      snapshot,
      { scrollHeight: 8959, clientHeight: 80 },
      80
    ),
    4200
  );
});

test("timeline preserves a small bottom offset rather than snapping", () => {
  const snapshot = {
    scrollTop: 8665,
    distanceFromBottom: 30
  };
  assert.equal(
    timelineScrollTopAfterResize(
      snapshot,
      { scrollHeight: 8959, clientHeight: 100 },
      80
    ),
    8829
  );
});

test("a stale pre-layout snapshot still follows an explicitly bottom-stuck thread", () => {
  const stale = {
    scrollTop: 0,
    distanceFromBottom: 8959
  };
  const snapshot = timelineSnapshotForResize(stale, true, 200);
  assert.equal(snapshot.distanceFromBottom, 0);
  assert.equal(
    timelineScrollTopAfterResize(
      snapshot,
      { scrollHeight: 8959, clientHeight: 80 },
      200
    ),
    8879
  );
});

test("a stale-looking snapshot is untouched when the user is reading history", () => {
  const snapshot = {
    scrollTop: 4200,
    distanceFromBottom: 4495
  };
  assert.equal(timelineSnapshotForResize(snapshot, false, 200), snapshot);
});
