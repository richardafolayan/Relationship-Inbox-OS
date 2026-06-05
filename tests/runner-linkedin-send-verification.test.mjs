import test from "node:test";
import assert from "node:assert/strict";
import { classifyLinkedInSendVerification } from "../apps/runner/dist/platforms/linkedin-send-verification.js";

// Default: an outbound, synthetic-timestamp bubble (the common LinkedIn case
// where <time> renders bare "4:52 PM" and Date.parse() returns NaN).
const bubble = (over = {}) => ({
  direction: "OUT",
  timestamp: 1000,
  text: "",
  timestampSynthetic: true,
  count: 5,
  ...over,
});

test("confirms when the sent text appears in the last outbound bubble", () => {
  const pre = bubble({ text: "an older line", count: 5 });
  const last = bubble({ text: "Hi Marianne — sounds good, see you then", count: 6 });
  assert.equal(
    classifyLinkedInSendVerification({ pre, last, sentText: "Hi Marianne — sounds good, see you then" }),
    "bubble_detected"
  );
});

test("text match is whitespace/case tolerant", () => {
  const pre = bubble({ count: 5 });
  const last = bubble({ text: "Thanks   so much!", count: 5 });
  assert.equal(
    classifyLinkedInSendVerification({ pre, last, sentText: "thanks so much!" }),
    "bubble_detected"
  );
});

test("confirms when a brand-new outbound bubble appeared even if the text read came back empty", () => {
  const pre = bubble({ direction: "IN", text: "their question", count: 5 });
  const last = bubble({ text: "", count: 6 }); // count grew, newest bubble is OUT
  assert.equal(
    classifyLinkedInSendVerification({ pre, last, sentText: "my reply" }),
    "bubble_detected"
  );
});

test("THE BUG: a re-reply whose send silently failed is NOT confirmed", () => {
  // Operator's previous outbound message is still the newest bubble; the new
  // send never landed. Synthetic Date.now() "advanced" and direction is OUT,
  // which the old code rubber-stamped as timestamp_advanced -> false "Sent".
  const pre = bubble({ text: "my earlier reply", count: 7, timestamp: 1000, timestampSynthetic: true });
  const last = bubble({ text: "my earlier reply", count: 7, timestamp: 9999, timestampSynthetic: true });
  assert.equal(
    classifyLinkedInSendVerification({ pre, last, sentText: "a brand new, different reply" }),
    null
  );
});

test("does not confirm when the newest bubble is inbound", () => {
  const pre = bubble({ count: 5 });
  const last = bubble({ direction: "IN", text: "their new message", count: 6 });
  assert.equal(classifyLinkedInSendVerification({ pre, last, sentText: "anything" }), null);
});

test("trusts a real (non-synthetic) timestamp advance", () => {
  const pre = bubble({ text: "x", count: 5, timestamp: 1000, timestampSynthetic: false });
  const last = bubble({ text: "y", count: 5, timestamp: 2000, timestampSynthetic: false });
  assert.equal(
    classifyLinkedInSendVerification({ pre, last, sentText: "z" }),
    "timestamp_advanced"
  );
});

test("does not trust a synthetic timestamp advance with no new bubble or text match", () => {
  const pre = bubble({ text: "x", count: 5, timestamp: 1000, timestampSynthetic: true });
  const last = bubble({ text: "x", count: 5, timestamp: 2000, timestampSynthetic: true });
  assert.equal(classifyLinkedInSendVerification({ pre, last, sentText: "z" }), null);
});

test("a null snapshot (list not ready) is not confirmed", () => {
  assert.equal(classifyLinkedInSendVerification({ pre: bubble(), last: null, sentText: "x" }), null);
});

test("empty thread pre-send: a first outbound bubble counts as delivered", () => {
  const last = bubble({ text: "first message", count: 1 });
  assert.equal(
    classifyLinkedInSendVerification({ pre: null, last, sentText: "first message" }),
    "bubble_detected"
  );
});
