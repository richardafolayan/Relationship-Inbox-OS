import test from "node:test";
import assert from "node:assert/strict";
import { checkSendGuard } from "../apps/runner/dist/platforms/whatsapp/sendGuard.js";

const RECIPIENT = "447111222333@c.us";
const NOW = 1_700_000_000_000; // fixed clock for deterministic interval / cap maths
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function buildDeps(overrides = {}) {
  const {
    isMyContact = true,
    recentOutbound = null, // pass a Date to simulate a prior recent send to this recipient
    dailyOutboundCount = 0,
    minIntervalMs = 30_000,
    dailyCap = 30
  } = overrides;
  return {
    client: {
      async getContactById(jid) {
        assert.equal(jid, RECIPIENT);
        return { isMyContact };
      }
    },
    prisma: {
      message: {
        async findFirst(args) {
          assert.equal(args.where.thread.platform, "WHATSAPP");
          assert.equal(args.where.direction, "OUT");
          assert.equal(args.where.thread.platformThreadId, RECIPIENT);
          if (recentOutbound) {
            return { timestamp: recentOutbound };
          }
          return null;
        },
        async count(args) {
          assert.equal(args.where.thread.platform, "WHATSAPP");
          assert.equal(args.where.direction, "OUT");
          // The query window must be exactly 24h before now.
          const expectedCutoff = new Date(NOW - ONE_DAY_MS);
          assert.equal(args.where.timestamp.gte.toISOString(), expectedCutoff.toISOString());
          return dailyOutboundCount;
        }
      }
    },
    config: { minIntervalMs, dailyCap },
    now: () => NOW
  };
}

test("checkSendGuard allows a send when all gates pass", async () => {
  const result = await checkSendGuard(buildDeps(), RECIPIENT);
  assert.deepEqual(result, { allowed: true });
});

test("checkSendGuard rejects when the recipient is not a saved contact", async () => {
  const result = await checkSendGuard(buildDeps({ isMyContact: false }), RECIPIENT);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /not in your WhatsApp saved contacts/);
});

test("checkSendGuard rejects when a send to the same recipient is within the interval window", async () => {
  // 10 seconds ago — well inside the 30s default window
  const recent = new Date(NOW - 10_000);
  const result = await checkSendGuard(
    buildDeps({ recentOutbound: recent }),
    RECIPIENT
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Per-recipient send interval not yet elapsed/);
  assert.match(result.reason, /20s remaining/);
});

test("checkSendGuard allows a send when the prior send to this recipient was OUTSIDE the interval window", async () => {
  // findFirst would not return that row in real Prisma because of the
  // `gte` filter, so we simulate "no recent" by leaving recentOutbound null.
  const result = await checkSendGuard(buildDeps({ recentOutbound: null }), RECIPIENT);
  assert.equal(result.allowed, true);
});

test("checkSendGuard rejects when the rolling-24h cap is hit", async () => {
  const result = await checkSendGuard(
    buildDeps({ dailyOutboundCount: 30 }),
    RECIPIENT
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /24h send cap reached \(30\/30\)/);
});

test("checkSendGuard rejects when the rolling-24h cap is exceeded", async () => {
  const result = await checkSendGuard(
    buildDeps({ dailyOutboundCount: 31 }),
    RECIPIENT
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /31\/30/);
});

test("checkSendGuard honours custom dailyCap from config", async () => {
  // 5 sends already, cap of 5 → blocked
  const result = await checkSendGuard(
    buildDeps({ dailyOutboundCount: 5, dailyCap: 5 }),
    RECIPIENT
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /5\/5/);
});

test("checkSendGuard honours custom minIntervalMs from config", async () => {
  // 60s ago, but custom interval is 120s → blocked
  const result = await checkSendGuard(
    buildDeps({
      recentOutbound: new Date(NOW - 60_000),
      minIntervalMs: 120_000
    }),
    RECIPIENT
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /60s remaining/);
});
