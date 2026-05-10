import test from "node:test";
import assert from "node:assert/strict";
import { epochSecondsToIso, isoToEpochSeconds } from "../apps/runner/dist/platforms/whatsapp/whatsappTime.js";

test("epochSecondsToIso converts an epoch second value to an ISO string", () => {
  // 1700000000 = 2023-11-14T22:13:20Z
  assert.equal(epochSecondsToIso(1700000000), "2023-11-14T22:13:20.000Z");
});

test("epochSecondsToIso returns null for null / undefined input", () => {
  assert.equal(epochSecondsToIso(null), null);
  assert.equal(epochSecondsToIso(undefined), null);
});

test("epochSecondsToIso returns null for non-finite input", () => {
  assert.equal(epochSecondsToIso(Number.NaN), null);
  assert.equal(epochSecondsToIso(Number.POSITIVE_INFINITY), null);
});

test("isoToEpochSeconds round-trips epochSecondsToIso", () => {
  const seconds = 1700000000;
  const iso = epochSecondsToIso(seconds);
  assert.equal(isoToEpochSeconds(iso), seconds);
});

test("isoToEpochSeconds returns null for unparseable input", () => {
  assert.equal(isoToEpochSeconds(null), null);
  assert.equal(isoToEpochSeconds(""), null);
  assert.equal(isoToEpochSeconds("not a date"), null);
});
