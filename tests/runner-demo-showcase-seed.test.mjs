import test from "node:test";
import assert from "node:assert/strict";
import { buildShowcaseThreads } from "../apps/runner/dist/services/demo.js";

// These tests cover the deterministic showcase records the full-presenter
// demo seeds (Serena, Timi, Brandon, multi-loop, reconnect, snoozed,
// archived). The full DB-touching seed/cleanup flow is covered by manual
// verification because exercising it from a test would need a fresh
// SQLite + Prisma client; the showcase builder is the load-bearing part
// the script depends on, so we test it directly.

const NOW = Date.parse("2026-05-25T12:00:00Z");

test("showcase threads include every required stable platformThreadId", () => {
  const ids = new Set(buildShowcaseThreads(NOW).map((t) => t.platformThreadId));
  for (const required of [
    "demo-full-serena-imessage",
    "demo-full-timi-linkedin",
    "demo-full-brandon-linkedin",
    "demo-full-multi-open-loop",
    "demo-full-reconnect",
    "demo-full-snoozed",
    "demo-full-archived"
  ]) {
    assert.ok(ids.has(required), `missing showcase id: ${required}`);
  }
});

test("Serena is on IMESSAGE and Timi is on LINKEDIN", () => {
  const showcase = buildShowcaseThreads(NOW);
  const serena = showcase.find((t) => t.platformThreadId === "demo-full-serena-imessage");
  const timi = showcase.find((t) => t.platformThreadId === "demo-full-timi-linkedin");
  assert.equal(serena?.platform, "IMESSAGE");
  assert.equal(serena?.displayName, "Serena");
  assert.equal(timi?.platform, "LINKEDIN");
  assert.equal(timi?.displayName, "Timi");
});

test("multi-loop thread has 4 distinct open loops", () => {
  const t = buildShowcaseThreads(NOW).find((x) => x.platformThreadId === "demo-full-multi-open-loop");
  assert.ok(t);
  assert.equal(t.openLoops.length, 4);
  assert.equal(new Set(t.openLoops).size, 4);
});

test("reconnect thread is dormant and has a reconnect score", () => {
  const t = buildShowcaseThreads(NOW).find((x) => x.platformThreadId === "demo-full-reconnect");
  assert.ok(t);
  // dormant > 30 days
  assert.ok(t.lastInboundAgoHours > 24 * 30);
  assert.equal(typeof t.reconnectScore, "number");
  assert.ok(t.reconnectScore > 0);
});

test("snoozed thread carries snoozedInHours in the future", () => {
  const t = buildShowcaseThreads(NOW).find((x) => x.platformThreadId === "demo-full-snoozed");
  assert.ok(t);
  assert.ok(typeof t.snoozedInHours === "number");
  assert.ok(t.snoozedInHours > 0);
});

test("archived thread is flagged archived", () => {
  const t = buildShowcaseThreads(NOW).find((x) => x.platformThreadId === "demo-full-archived");
  assert.ok(t);
  assert.equal(t.archived, true);
});

test("every showcase thread has at least one message", () => {
  for (const t of buildShowcaseThreads(NOW)) {
    assert.ok(t.messages.length > 0, `${t.platformThreadId} has no messages`);
  }
});

test("Timi thread reads as a respond-lightly catch-up (not needs-reply with a direct ask)", () => {
  const t = buildShowcaseThreads(NOW).find((x) => x.platformThreadId === "demo-full-timi-linkedin");
  assert.ok(t);
  // Plan calls for Timi to demonstrate "respond lightly" — keep the
  // contract: when nothing is really on the operator, openLoops stays at
  // most one acknowledgement item.
  assert.ok(t.openLoops.length <= 1);
});
