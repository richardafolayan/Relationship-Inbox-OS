import test from "node:test";
import assert from "node:assert/strict";
import {
  mirrorRequiredToOpenLoops,
  sanitizeReplyBrief,
  stripBannedPhrases,
  synthesiseFallbackBrief
} from "../apps/runner/dist/services/reply-brief.js";

// These pure helpers back the Reply Brief that drives the thread right rail.
// They are extracted out of ai.ts so the classifier invariants (required /
// optional / handled mutually exclusive, banned coaching phrases stripped,
// fallback derivation when the model omits the brief) can be tested without
// hitting an actual LLM.

test("sanitizeReplyBrief: returns null when the raw input is unusable", () => {
  assert.equal(sanitizeReplyBrief(null), null);
  assert.equal(sanitizeReplyBrief(undefined), null);
  assert.equal(sanitizeReplyBrief("not an object"), null);
  assert.equal(sanitizeReplyBrief({}), null);
  assert.equal(sanitizeReplyBrief({ where_it_stands: "", on_you: "" }), null);
});

test("sanitizeReplyBrief: a well-formed brief survives intact", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "He shared an update about the exec search and the offer he paused.",
    on_you: "He hasn't asked you anything. Acknowledge the offer.",
    required_points: [],
    optional_followups: [
      { id: "ask-next", text: "Ask what he's looking at now", status: "optional" }
    ],
    handled_points: [],
    fuller_context: "Long-standing peer, last spoke six weeks ago about hiring.",
    tone_steer: "Warm, short, peer-to-peer",
    enough_to_reply_without_scrolling: true
  });
  assert.ok(brief);
  assert.equal(brief.where_it_stands.startsWith("He shared an update"), true);
  assert.equal(brief.required_points.length, 0);
  assert.equal(brief.optional_followups.length, 1);
  assert.equal(brief.optional_followups[0].status, "optional");
  assert.equal(brief.tone_steer, "Warm, short, peer-to-peer");
  assert.equal(brief.enough_to_reply_without_scrolling, true);
});

test("sanitizeReplyBrief: required wins over optional when both contain the same text", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "She asked whether Friday works.",
    on_you: "Confirm yes or suggest another time.",
    required_points: [
      { id: "friday", text: "Confirm whether Friday works", status: "required" }
    ],
    optional_followups: [
      { id: "friday-dup", text: "Confirm whether Friday works", status: "optional" },
      { id: "ask-tolu", text: "Ask if she still wants Tolu involved", status: "optional" }
    ]
  });
  assert.ok(brief);
  assert.equal(brief.required_points.length, 1);
  // The duplicate is stripped from optional; the unrelated optional stays.
  assert.equal(brief.optional_followups.length, 1);
  assert.equal(brief.optional_followups[0].text, "Ask if she still wants Tolu involved");
});

test("sanitizeReplyBrief: a point classified as handled drops out of required", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "He answered the Friday question himself two messages later.",
    on_you: "Nothing pending from him.",
    required_points: [
      { id: "friday", text: "Confirm whether Friday works", status: "required" }
    ],
    optional_followups: [],
    handled_points: [
      {
        id: "friday-handled",
        text: "Confirm whether Friday works",
        status: "handled",
        reason: "he answered this himself two messages later"
      }
    ]
  });
  assert.ok(brief);
  assert.equal(brief.required_points.length, 0);
  assert.equal(brief.handled_points?.length, 1);
  assert.equal(brief.handled_points?.[0].reason, "he answered this himself two messages later");
});

test("sanitizeReplyBrief: string-only entries in required_points get coerced into points", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "She had two questions.",
    on_you: "Answer both.",
    required_points: ["Send the doc Marianne asked for", "Confirm Friday at 11 works"],
    optional_followups: []
  });
  assert.ok(brief);
  assert.equal(brief.required_points.length, 2);
  assert.equal(brief.required_points[0].status, "required");
  assert.equal(brief.required_points[0].text, "Send the doc Marianne asked for");
  // Each point has a deterministic id derived from the text.
  assert.ok(brief.required_points[0].id.length > 0);
  assert.notEqual(brief.required_points[0].id, brief.required_points[1].id);
});

test("sanitizeReplyBrief: malformed point objects are dropped, not trusted", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "Mixed input.",
    on_you: "On you.",
    required_points: [
      { id: "ok", text: "Real point", status: "required" },
      { id: "missing-text", status: "required" },
      { id: "empty", text: "   ", status: "required" },
      42,
      null
    ]
  });
  assert.ok(brief);
  assert.equal(brief.required_points.length, 1);
  assert.equal(brief.required_points[0].text, "Real point");
});

test("sanitizeReplyBrief: enforces caps on required / optional / handled lists", () => {
  const tenStrings = Array.from({ length: 10 }, (_, i) => `Required point ${i}`);
  const eightOptionals = Array.from({ length: 8 }, (_, i) => `Optional ${i}`);
  const brief = sanitizeReplyBrief({
    where_it_stands: "Lots of stuff.",
    on_you: "Lots to do.",
    required_points: tenStrings,
    optional_followups: eightOptionals
  });
  assert.ok(brief);
  // Caps live in reply-brief.ts (MAX_REQUIRED_POINTS = 6, MAX_OPTIONAL_POINTS = 4).
  assert.equal(brief.required_points.length, 6);
  assert.equal(brief.optional_followups.length, 4);
});

test("sanitizeReplyBrief: dedupes points by case-insensitive text", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "Repeating points.",
    on_you: "Just one of them.",
    required_points: [
      { id: "a", text: "Send the deck", status: "required" },
      { id: "b", text: "SEND THE DECK", status: "required" },
      { id: "c", text: "send the deck", status: "required" }
    ]
  });
  assert.ok(brief);
  assert.equal(brief.required_points.length, 1);
});

test("stripBannedPhrases: removes the abstract coaching strings the rail must not surface", () => {
  const dirty = "Ask a grounded question to deepen the connection with a helpful nudge.";
  const cleaned = stripBannedPhrases(dirty);
  assert.equal(/grounded question/i.test(cleaned), false);
  assert.equal(/deepen the connection/i.test(cleaned), false);
  assert.equal(/helpful nudge/i.test(cleaned), false);
});

test("stripBannedPhrases: leaves clean text untouched", () => {
  const clean = "Acknowledge the offer and ask what he's looking at now.";
  assert.equal(stripBannedPhrases(clean), clean);
});

test("synthesiseFallbackBrief: a quiet thread with no needsReply yields a no-pending on_you", () => {
  const brief = synthesiseFallbackBrief({
    rollingSummary: "Brandon — peer, last spoke about hiring six weeks ago.",
    whatTheyWant: "No clear ask yet.",
    openLoops: [],
    needsReply: false,
    latestInboundText: "All good, talk soon."
  });
  assert.ok(brief.where_it_stands.length > 0);
  // "Nothing pending" wording surfaces when there's no live ask.
  assert.match(brief.on_you, /Nothing pending/i);
  assert.equal(brief.required_points.length, 0);
});

test("synthesiseFallbackBrief: when openLoops exist they become required_points", () => {
  const brief = synthesiseFallbackBrief({
    rollingSummary: "Marianne — ongoing project chat.",
    whatTheyWant: "She wants the latest deck and Friday confirmation.",
    openLoops: ["Send the deck Marianne asked for", "Confirm Friday at 11"],
    needsReply: true,
    latestInboundText: "Send the deck pls, and Friday still good?"
  });
  assert.equal(brief.required_points.length, 2);
  assert.equal(brief.required_points[0].status, "required");
  // on_you carries the real ask, not the static "No clear ask yet." string.
  assert.match(brief.on_you, /deck|Friday/);
});

test("synthesiseFallbackBrief: static fallback whatTheyWant gives a generic waiting-on-reply on_you", () => {
  const brief = synthesiseFallbackBrief({
    rollingSummary: "",
    whatTheyWant: "No clear ask yet.",
    openLoops: [],
    needsReply: true,
    latestInboundText: "thanks"
  });
  // Doesn't echo the static string back as the obligation.
  assert.equal(/No clear ask yet/i.test(brief.on_you), false);
  // Carries a "waiting on a reply, nothing specific" framing.
  assert.match(brief.on_you, /waiting on a reply|short acknowledgement/i);
});

test("synthesiseFallbackBrief: a whatTheyWant poisoned by banned coaching phrases is rejected wholesale", () => {
  // Real failure case observed on a v5 thread: the legacy whatTheyWant
  // ("What would deepen the connection is...") was built around the
  // banned coaching idea. Partial stripping would leave "What would." —
  // a grammatical fragment worse than a clean generic. Whole-phrase
  // rejection should kick in and route on_you through the neutral
  // "they're waiting on a reply, but nothing specific has been asked"
  // branch instead.
  const brief = synthesiseFallbackBrief({
    rollingSummary: "Brandon is sharing a thoughtful shift from law to recruitment.",
    whatTheyWant:
      "What would deepen the connection is acknowledging his move and asking a light, grounded question about his next steps, or offering a helpful nudge.",
    openLoops: [],
    needsReply: true,
    latestInboundText: null
  });
  assert.equal(/deepen the connection/i.test(brief.on_you), false);
  assert.equal(/grounded question/i.test(brief.on_you), false);
  assert.equal(/helpful nudge/i.test(brief.on_you), false);
  // The fragment "What would" must NOT survive — that's the live-verification bug.
  assert.equal(/^What would\.?\s*$/i.test(brief.on_you.trim()), false);
  // Falls through to the generic waiting-on-reply wording.
  assert.match(brief.on_you, /waiting on a reply|short acknowledgement|nothing specific/i);
});

test("synthesiseFallbackBrief: derives where_it_stands from latest inbound when summary is empty", () => {
  const brief = synthesiseFallbackBrief({
    rollingSummary: "",
    whatTheyWant: "",
    openLoops: [],
    needsReply: true,
    latestInboundText: "Hey, just wanted to say thanks for the intro to Sarah."
  });
  assert.match(brief.where_it_stands, /thanks for the intro to Sarah/);
});

test("mirrorRequiredToOpenLoops: returns the required text array verbatim", () => {
  const brief = synthesiseFallbackBrief({
    rollingSummary: "",
    whatTheyWant: "",
    openLoops: ["Send the deck", "Confirm Friday"],
    needsReply: true,
    latestInboundText: null
  });
  const loops = mirrorRequiredToOpenLoops(brief);
  assert.deepEqual(loops, ["Send the deck", "Confirm Friday"]);
});

test("mirrorRequiredToOpenLoops: returns null when the brief itself is null", () => {
  assert.equal(mirrorRequiredToOpenLoops(null), null);
});
