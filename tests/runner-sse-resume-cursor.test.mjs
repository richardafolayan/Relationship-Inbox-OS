import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSseResumeCursor,
  resolveSseResyncReason
} from "../apps/runner/dist/services/sse-resume-cursor.js";

// Regression for SSEREPLAY: the /events handler used to resolve the SSE resume
// cursor as `Number(req.query.sinceEventId ?? req.header("last-event-id") ?? 0)`,
// so the stale mount-time `sinceEventId` query param WON over the live
// `Last-Event-ID` header. On the browser's native auto-reconnect the runner
// then replayed the whole buffered window from the mount-time id (up to
// MAX_EVENTS), re-dispatching every event and re-triggering the dashboard's
// refetch fan-out. The header must win so a reconnect resumes from the last
// event actually delivered.

test("reconnect prefers the live Last-Event-ID header over the stale query param", () => {
  // Frozen mount-time cursor = 10, but the client has since seen up to 487.
  assert.equal(resolveSseResumeCursor("10", "487"), 487);
});

test("first connection (no header yet) falls back to the mount-time query param", () => {
  assert.equal(resolveSseResumeCursor("42", undefined), 42);
});

test("no header and no query param resumes from 0 (full replay window)", () => {
  assert.equal(resolveSseResumeCursor(undefined, undefined), 0);
});

test("a numeric query param is honoured when the header is absent", () => {
  assert.equal(resolveSseResumeCursor("123", undefined), 123);
});

test("the header alone drives the cursor when no query param was sent", () => {
  // The EventSource was opened at /events with no sinceEventId, then reconnected.
  assert.equal(resolveSseResumeCursor(undefined, "256"), 256);
});

test("header wins even when it is lower than the stale query param", () => {
  // Defends the exact precedence: header is authoritative regardless of value,
  // because it reflects what the client truly received.
  assert.equal(resolveSseResumeCursor("500", "3"), 3);
});

test("a non-numeric header yields NaN (listSince treats NaN as replay-from-start)", () => {
  assert.ok(Number.isNaN(resolveSseResumeCursor("10", "not-a-number")));
});

test("a cursor ahead of this runner explicitly requests a client resync", () => {
  assert.equal(
    resolveSseResyncReason({ sinceEventId: 900, oldestEventId: 20, newestEventId: 40 }),
    "Event cursor is ahead of this runner"
  );
  assert.equal(
    resolveSseResyncReason({ sinceEventId: 3, oldestEventId: 20, newestEventId: 40 }),
    "Event replay window exceeded"
  );
  assert.equal(
    resolveSseResyncReason({ sinceEventId: 40, oldestEventId: 20, newestEventId: 40 }),
    null
  );
});
