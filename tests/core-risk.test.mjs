import test from "node:test";
import assert from "node:assert/strict";
import { calculateRisk, formatSlaCountdown } from "../packages/core/dist/risk.js";

test("calculateRisk returns GREEN when no inbound exists", () => {
  const result = calculateRisk({
    lastInboundAt: undefined,
    lastOutboundAt: undefined,
    amberHours: 6,
    redHours: 18
  });

  assert.equal(result.level, "GREEN");
  assert.equal(result.needsReply, false);
  assert.equal(result.riskReason, "No inbound messages");
  assert.equal(result.slaDueAt, undefined);
});

test("calculateRisk returns GREEN when outbound is newer than inbound", () => {
  const now = Date.now();
  const result = calculateRisk({
    lastInboundAt: new Date(now - 2 * 60 * 60 * 1000),
    lastOutboundAt: new Date(now - 1 * 60 * 60 * 1000),
    amberHours: 6,
    redHours: 18
  });

  assert.equal(result.level, "GREEN");
  assert.equal(result.needsReply, false);
  assert.equal(result.riskReason, "Replied");
  assert.equal(result.slaDueAt, undefined);
});

test("calculateRisk returns AMBER and RED based on elapsed hours", () => {
  const amber = calculateRisk({
    lastInboundAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    lastOutboundAt: undefined,
    amberHours: 6,
    redHours: 18
  });

  assert.equal(amber.level, "AMBER");
  assert.equal(amber.needsReply, true);
  assert.ok(amber.slaDueAt instanceof Date);

  const red = calculateRisk({
    lastInboundAt: new Date(Date.now() - 20 * 60 * 60 * 1000),
    lastOutboundAt: undefined,
    amberHours: 6,
    redHours: 18
  });

  assert.equal(red.level, "RED");
  assert.equal(red.needsReply, true);
  assert.ok(red.riskReason.startsWith("Inbound waiting"));
});

test("formatSlaCountdown formats due and overdue values", () => {
  const dueSoon = formatSlaCountdown(new Date(Date.now() + 30 * 60 * 1000));
  assert.match(dueSoon, /^Due in \d+h \d+m$/);

  const overdue = formatSlaCountdown(new Date(Date.now() - 30 * 60 * 1000));
  assert.match(overdue, /^Overdue \d+h \d+m$/);
});
