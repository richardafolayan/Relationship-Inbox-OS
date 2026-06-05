import test from "node:test";
import assert from "node:assert/strict";
import {
  isMoreCanonical,
  pickCanonicalThread
} from "../apps/runner/dist/services/canonical-thread.js";

// The canonical sibling is the row carrying the LIVE AI analysis for an
// iMessage Person split across handle-specific chats. Ordering:
//   1. most recent lastInboundAt   2. most messages   3. greatest id
// The load-bearing case (the Serena bug): a freshly-active small thread must
// win over a dormant huge one.

const date = (iso) => new Date(iso);

test("pickCanonicalThread prefers the most-recent inbound over a higher message count", () => {
  // Serena-shaped: phone thread is dormant but enormous; email thread is
  // tiny but where the live conversation actually is.
  const phone = { id: "imsg-phone", lastInboundAt: date("2026-06-04T14:50:00Z"), messageCount: 7313 };
  const email = { id: "imsg-email", lastInboundAt: date("2026-06-05T13:25:00Z"), messageCount: 345 };
  assert.equal(pickCanonicalThread([phone, email]).id, "imsg-email");
  // Order-independent.
  assert.equal(pickCanonicalThread([email, phone]).id, "imsg-email");
});

test("pickCanonicalThread tie-breaks equal inbound times by message count", () => {
  const t = date("2026-06-05T13:25:00Z");
  const small = { id: "a", lastInboundAt: t, messageCount: 5 };
  const big = { id: "b", lastInboundAt: t, messageCount: 10 };
  assert.equal(pickCanonicalThread([small, big]).id, "b");
});

test("pickCanonicalThread tie-breaks equal inbound + count deterministically by id", () => {
  const t = date("2026-06-05T13:25:00Z");
  const a = { id: "aaa", lastInboundAt: t, messageCount: 3 };
  const b = { id: "zzz", lastInboundAt: t, messageCount: 3 };
  assert.equal(pickCanonicalThread([a, b]).id, "zzz");
});

test("pickCanonicalThread treats a null lastInboundAt as oldest", () => {
  const withInbound = { id: "has", lastInboundAt: date("2026-01-01T00:00:00Z"), messageCount: 1 };
  const noInbound = { id: "none", lastInboundAt: null, messageCount: 9999 };
  assert.equal(pickCanonicalThread([withInbound, noInbound]).id, "has");
});

test("pickCanonicalThread returns null for an empty set", () => {
  assert.equal(pickCanonicalThread([]), null);
});

test("isMoreCanonical is a strict ordering on the live-exchange rule", () => {
  const older = { id: "x", lastInboundAt: date("2026-06-04T00:00:00Z"), messageCount: 1000 };
  const newer = { id: "y", lastInboundAt: date("2026-06-05T00:00:00Z"), messageCount: 1 };
  assert.equal(isMoreCanonical(newer, older), true);
  assert.equal(isMoreCanonical(older, newer), false);
});
