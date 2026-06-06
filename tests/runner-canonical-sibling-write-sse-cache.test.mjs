import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalWriteTargetId,
  pickCanonicalThread
} from "../apps/runner/dist/services/canonical-thread.js";
import { shouldRefetchForThreadEvent } from "../apps/dashboard/lib/thread-identity-guard.ts";

// Canonical-sibling WRITE / SSE / CACHE desync (multi-handle iMessage).
//
// #499 / PM11/PM16/PM17 made the READ path source AI fields from the canonical
// (most-recent-inbound) sibling. The WRITE target, the SSE THREAD_UPDATED
// routing, and the predraft cache key still keyed off the requested/per-handle
// sibling, so they drifted: a reassess fired on the dormant phone row wrote the
// fresh brief onto the phone row while the reader consulted the live email
// sibling; a new inbound on the other handle never refetched the open view; and
// the predraft cache key was computed on the requested row's stale AI inputs.
//
// These tests pin the two decision points that now agree with the read path:
//   (A) the AI-write target resolves to the canonical sibling,
//   (B) the SSE refetch match is sibling-cohort aware.
// The (C) predraft and (D) cohort wiring reuse the SAME canonical decision.

const date = (iso) => new Date(iso);

// ---- (A) WRITE TARGET --------------------------------------------------

test("canonicalWriteTargetId redirects an iMessage write to the canonical sibling", () => {
  // Serena-shaped: reassess-on-send / the stale-summary self-heal fire on the
  // dormant phone row, but the AI fields must land on the LIVE email sibling —
  // the row the readers (and pickCanonicalThread) agree on — even though the
  // phone row has far more messages.
  const siblingRows = [
    { id: "imsg-phone", lastInboundAt: date("2026-06-04T14:50:00Z"), messageCount: 7313 },
    { id: "imsg-email", lastInboundAt: date("2026-06-05T13:25:00Z"), messageCount: 345 }
  ];
  // Requested = the dormant phone row; canonical write target = the live email row.
  assert.equal(canonicalWriteTargetId("imsg-phone", "IMESSAGE", siblingRows), "imsg-email");
  // Order-independent, and asking from the already-canonical row is idempotent
  // (so runReassessForThread, which pre-resolves canonical, stays correct).
  assert.equal(canonicalWriteTargetId("imsg-email", "IMESSAGE", siblingRows), "imsg-email");
  // Agrees with the read path's own resolver.
  assert.equal(
    canonicalWriteTargetId("imsg-phone", "IMESSAGE", siblingRows),
    pickCanonicalThread(siblingRows).id
  );
});

test("canonicalWriteTargetId is a no-op for a single-sibling iMessage person", () => {
  // One handle only: write to the row itself, no canonical redirect, no surprise.
  const siblingRows = [{ id: "solo", lastInboundAt: date("2026-06-05T13:25:00Z"), messageCount: 12 }];
  assert.equal(canonicalWriteTargetId("solo", "IMESSAGE", siblingRows), "solo");
});

test("canonicalWriteTargetId is a no-op for non-iMessage threads", () => {
  // LinkedIn / Instagram / TikTok threads are their own canonical row — never
  // redirected even if (defensively) several rows are passed.
  const siblingRows = [
    { id: "li-a", lastInboundAt: date("2026-06-04T14:50:00Z"), messageCount: 10 },
    { id: "li-b", lastInboundAt: date("2026-06-05T13:25:00Z"), messageCount: 1 }
  ];
  assert.equal(canonicalWriteTargetId("li-a", "LINKEDIN", siblingRows), "li-a");
});

test("canonicalWriteTargetId falls back to the requested id on an empty sibling set", () => {
  assert.equal(canonicalWriteTargetId("req", "IMESSAGE", []), "req");
});

// ---- (B) SSE DELIVERY across handles -----------------------------------

test("shouldRefetchForThreadEvent matches the exact thread id", () => {
  // The current behaviour: an event for the open thread always refetches.
  assert.equal(shouldRefetchForThreadEvent("imsg-email", "imsg-email", ["imsg-email"]), true);
});

test("shouldRefetchForThreadEvent matches a sibling handle in the cohort", () => {
  // The bug: a new inbound on the OTHER handle (phone) emits THREAD_UPDATED for
  // the phone row, but the operator has the email row open. With siblingIds in
  // the ThreadResponse the open view now refetches on the sibling's event.
  const siblingIds = ["imsg-email", "imsg-phone"];
  assert.equal(shouldRefetchForThreadEvent("imsg-phone", "imsg-email", siblingIds), true);
});

test("shouldRefetchForThreadEvent ignores an unrelated thread's event", () => {
  // An event for a thread that is neither the open one nor a sibling must NOT
  // refetch — otherwise a scan burst on other contacts janks the open view.
  assert.equal(
    shouldRefetchForThreadEvent("someone-else", "imsg-email", ["imsg-email", "imsg-phone"]),
    false
  );
});

test("shouldRefetchForThreadEvent is false when the event carries no thread id", () => {
  assert.equal(shouldRefetchForThreadEvent(undefined, "imsg-email", ["imsg-email"]), false);
  assert.equal(shouldRefetchForThreadEvent(null, "imsg-email", ["imsg-email"]), false);
});

test("shouldRefetchForThreadEvent degrades to exact match without a sibling list", () => {
  // A runner build that predates siblingIds in ThreadResponse: the page passes
  // an empty/undefined cohort, so behaviour degrades to the old exact-id match.
  assert.equal(shouldRefetchForThreadEvent("imsg-email", "imsg-email", []), true);
  assert.equal(shouldRefetchForThreadEvent("imsg-phone", "imsg-email", []), false);
  assert.equal(shouldRefetchForThreadEvent("imsg-email", "imsg-email", undefined), true);
});
