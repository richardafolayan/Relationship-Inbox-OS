import test from "node:test";
import assert from "node:assert/strict";
import {
  parseScreenshotDataUrl,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS,
  PILOT_REPORT_TYPES,
  ALLOWED_SCREENSHOT_TYPES
} from "../apps/runner/dist/services/pilot-feedback.js";

// A 1x1 PNG, as a real base64 data URL.
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("pilot report types are the four expected kinds", () => {
  assert.deepEqual([...PILOT_REPORT_TYPES], ["bug", "feedback", "confusing", "feature_idea"]);
});

test("parseScreenshotDataUrl accepts a valid image data URL", () => {
  const result = parseScreenshotDataUrl("shot.png", TINY_PNG);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.screenshot.mimeType, "image/png");
    assert.ok(result.screenshot.base64.length > 0);
    assert.equal(result.screenshot.name, "shot.png");
  }
});

test("parseScreenshotDataUrl sanitises unsafe file names", () => {
  const result = parseScreenshotDataUrl("../../etc/passwd .png", TINY_PNG);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.doesNotMatch(result.screenshot.name, /[/]/);
  }
});

test("parseScreenshotDataUrl rejects non-image and non-data-URL input", () => {
  assert.equal(parseScreenshotDataUrl("x", "just some text").ok, false);
  assert.equal(parseScreenshotDataUrl("x", "data:text/plain;base64,aGVsbG8=").ok, false);
  assert.equal(parseScreenshotDataUrl("x", "").ok, false);
});

test("parseScreenshotDataUrl rejects an image type outside the allowlist", () => {
  const result = parseScreenshotDataUrl("x.svg", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
  assert.equal(result.ok, false);
  // sanity: the allowlist is the four raster types, not svg
  assert.ok(!ALLOWED_SCREENSHOT_TYPES.includes("image/svg+xml"));
});

test("parseScreenshotDataUrl rejects a screenshot over the size limit", () => {
  // base64 length that decodes to just over MAX_SCREENSHOT_BYTES.
  const overLength = Math.ceil(((MAX_SCREENSHOT_BYTES + 1024) * 4) / 3);
  const huge = "data:image/png;base64," + "A".repeat(overLength);
  const result = parseScreenshotDataUrl("huge.png", huge);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /too large/i);
});

test("MAX_SCREENSHOTS caps a report at a few images", () => {
  assert.equal(typeof MAX_SCREENSHOTS, "number");
  assert.ok(MAX_SCREENSHOTS >= 2, "a report must allow multiple screenshots");
});
