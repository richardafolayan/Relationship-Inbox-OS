import test from "node:test";
import assert from "node:assert/strict";

// Pilot R-0087 (#754): the auto-scan cadence is operator-adjustable, and
// every cadence keeps the proportional jitter (base x 0.8..1.3) that the
// historical hard-coded 8-13 minute window gave the 10-minute default.
const {
  DEFAULT_SCAN_INTERVAL,
  nextScanDelayMs,
  parseScanInterval,
  scanIntervalCaption,
  scanIntervalWindowMs,
  SCAN_INTERVAL_OPTIONS
} = await import("../apps/dashboard/lib/scan-interval.ts");

const MIN = 60 * 1000;

test("parseScanInterval falls back to the 10 min default on junk", () => {
  assert.equal(parseScanInterval(null), "10m");
  assert.equal(parseScanInterval(undefined), "10m");
  assert.equal(parseScanInterval(""), "10m");
  assert.equal(parseScanInterval("5s"), "10m");
  assert.equal(parseScanInterval("weekly"), "10m");
  assert.equal(DEFAULT_SCAN_INTERVAL, "10m");
});

test("parseScanInterval accepts every offered option", () => {
  for (const option of SCAN_INTERVAL_OPTIONS) {
    assert.equal(parseScanInterval(option.id), option.id);
  }
});

test("the 10 min window is the historical 8-13 minute jitter, exactly", () => {
  assert.deepEqual(scanIntervalWindowMs("10m"), { min: 8 * MIN, max: 13 * MIN });
});

test("every cadence keeps the proportional 0.8-1.3 spread", () => {
  assert.deepEqual(scanIntervalWindowMs("30m"), { min: 24 * MIN, max: 39 * MIN });
  assert.deepEqual(scanIntervalWindowMs("1h"), { min: 48 * MIN, max: 78 * MIN });
  assert.deepEqual(scanIntervalWindowMs("1d"), {
    min: Math.round(0.8 * 24 * 60 * MIN),
    max: Math.round(1.3 * 24 * 60 * MIN)
  });
});

test("nextScanDelayMs stays inside the window at the random extremes", () => {
  for (const option of SCAN_INTERVAL_OPTIONS) {
    const window = scanIntervalWindowMs(option.id);
    assert.equal(nextScanDelayMs(option.id, { random: () => 0 }), window.min);
    assert.ok(nextScanDelayMs(option.id, { random: () => 0.999999 }) <= window.max);
    assert.ok(nextScanDelayMs(option.id, { random: () => 0.999999 }) >= window.min);
  }
});

test("a skipped tick retries on the short 10 min window whatever the cadence", () => {
  // Otherwise a daily timer that lands inside quiet hours would starve for
  // another full day; the quiet-hours/active-hours gates still decide
  // whether the retry actually scans.
  const short = scanIntervalWindowMs("10m");
  for (const id of ["30m", "1h", "1d"]) {
    const delay = nextScanDelayMs(id, { skipped: true, random: () => 0.5 });
    assert.ok(delay >= short.min && delay <= short.max, `${id} skipped retry ${delay}`);
  }
});

test("captions cover every option for the Settings state line", () => {
  assert.equal(scanIntervalCaption("10m"), "every 10 min");
  assert.equal(scanIntervalCaption("30m"), "every 30 min");
  assert.equal(scanIntervalCaption("1h"), "hourly");
  assert.equal(scanIntervalCaption("1d"), "daily");
});
