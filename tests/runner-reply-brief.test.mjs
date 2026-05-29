import { test } from "node:test";
import assert from "node:assert/strict";

// Pure shaping service (type-only import of @inbox-os/core, runtime import of
// the surrogate-safe string helpers). Loaded through tsx like the other
// runner service tests.
const { synthesiseFallbackBrief, sanitizeReplyBrief } = await import(
  "../apps/runner/src/services/reply-brief.ts"
);

test("synthesiseFallbackBrief dedupes duplicate open loops (case-insensitive)", () => {
  const brief = synthesiseFallbackBrief({
    rollingSummary: "",
    whatTheyWant: "",
    openLoops: ["Send the deck", "Send the deck", "send the deck", "Confirm Friday"],
    needsReply: true,
    latestInboundText: null
  });
  const texts = brief.required_points.map((p) => p.text);
  assert.equal(texts.length, 2);
  assert.deepEqual(texts, ["Send the deck", "Confirm Friday"]);
});

test("synthesiseFallbackBrief drops empty/whitespace open loops", () => {
  const brief = synthesiseFallbackBrief({
    rollingSummary: "",
    whatTheyWant: "",
    openLoops: ["", "   ", "Reply about the venue"],
    needsReply: true,
    latestInboundText: null
  });
  assert.deepEqual(
    brief.required_points.map((p) => p.text),
    ["Reply about the venue"]
  );
});

test("sanitizeReplyBrief still dedupes required_points (sibling path parity)", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "They asked about timing.",
    on_you: "Confirm the date.",
    required_points: ["Confirm the date", "confirm the date", "Send the address"]
  });
  assert.ok(brief);
  assert.deepEqual(
    brief.required_points.map((p) => p.text),
    ["Confirm the date", "Send the address"]
  );
});
