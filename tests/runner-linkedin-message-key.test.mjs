import test from "node:test";
import assert from "node:assert/strict";
import {
  isPositionalMessageKey,
  stableMessageKey
} from "../apps/runner/dist/linkedin/linkedinMessageKey.js";

// Regression for BUG H1 — the streaming scan path emitted the raw positional
// `li-msg-<index>` key, which shifts between delta scans, so the same older
// inbound bubble was re-keyed and persisted again (duplicate messages).
// `stableMessageKey` must convert that positional fallback into an
// index-independent content fingerprint, while leaving real DOM-id keys alone.

const bubble = {
  direction: "IN",
  senderName: "Uwa Okungbowa",
  dateHeading: "Feb 19",
  timeText: "7:16 PM",
  firstTextPart: "Hey, did you get a chance to look at the deck?"
};

test("isPositionalMessageKey only matches the li-msg-<index> fallback", () => {
  assert.equal(isPositionalMessageKey("li-msg-0"), true);
  assert.equal(isPositionalMessageKey("li-msg-7"), true);
  assert.equal(isPositionalMessageKey("li-msg-128"), true);
  // Real DOM-id keys must NOT be treated as positional.
  assert.equal(isPositionalMessageKey("urn:li:messagingMessage:abc123"), false);
  assert.equal(isPositionalMessageKey("ember1234"), false);
  assert.equal(isPositionalMessageKey("li-msg-fp:IN|x|y|z|w"), false);
  assert.equal(isPositionalMessageKey("li-msg-"), false);
  assert.equal(isPositionalMessageKey("li-msg-3:body:1"), false);
});

test("stableMessageKey leaves a real DOM-id key untouched", () => {
  const urn = "urn:li:messagingMessage:2-abc==";
  assert.equal(stableMessageKey({ ...bubble, existingKey: urn }), urn);
});

test("the same bubble yields the same fingerprint even when its index shifts", () => {
  // First scan: bubble rendered at index 3 -> li-msg-3.
  const firstScan = stableMessageKey({ ...bubble, existingKey: "li-msg-3" });
  // Later delta scan: window shifted, the same bubble is now at index 11.
  const laterScan = stableMessageKey({ ...bubble, existingKey: "li-msg-11" });

  assert.ok(firstScan.startsWith("li-msg-fp:"), "fallback should become a fingerprint");
  assert.equal(
    firstScan,
    laterScan,
    "the same bubble must produce the same key across index shifts"
  );
  assert.equal(
    firstScan,
    "li-msg-fp:IN|Uwa Okungbowa|Feb 19|7:16 PM|Hey, did you get a chance to look at the deck?"
  );
});

test("fingerprint truncates the body to the first 48 chars", () => {
  const longBody =
    "0123456789012345678901234567890123456789012345678901234567890123"; // 64 chars
  const key = stableMessageKey({
    ...bubble,
    existingKey: "li-msg-0",
    firstTextPart: longBody
  });
  assert.equal(key.endsWith("|" + longBody.slice(0, 48)), true);
  assert.equal(key.includes(longBody), false, "must not embed the full body");
});

test("different bubbles produce different fingerprints", () => {
  const a = stableMessageKey({ ...bubble, existingKey: "li-msg-0" });
  const b = stableMessageKey({
    ...bubble,
    existingKey: "li-msg-0",
    timeText: "7:17 PM"
  });
  const c = stableMessageKey({
    ...bubble,
    existingKey: "li-msg-0",
    direction: "OUT"
  });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("streaming and backfill paths agree on the key for identical bubble fields", () => {
  // Both collection paths now route their positional fallback through the same
  // helper, so a bubble seen by either path resolves to the same fingerprint.
  // This mirrors the inline fingerprint the deep-fetch path used to compute:
  //   li-msg-fp:DIR|sender|dateHeading|timeText|first48
  const expected = `li-msg-fp:${bubble.direction}|${bubble.senderName}|${bubble.dateHeading}|${bubble.timeText}|${bubble.firstTextPart.slice(0, 48)}`;
  const streaming = stableMessageKey({ ...bubble, existingKey: "li-msg-5" });
  const backfill = stableMessageKey({ ...bubble, existingKey: "li-msg-42" });
  assert.equal(streaming, expected);
  assert.equal(backfill, expected);
});
