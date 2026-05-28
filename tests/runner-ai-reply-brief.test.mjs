import test from "node:test";
import assert from "node:assert/strict";
import {
  briefSignatureForCache,
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

// ── Issue #397 — em/en dash strip in brief fields ──────────────────────

test("stripBannedPhrases: replaces em dashes with comma-space (#397)", () => {
  const dirty = "He paused the offer — clients were in the Middle East.";
  const cleaned = stripBannedPhrases(dirty);
  assert.equal(cleaned.includes("—"), false, "em dash must be gone");
  assert.match(cleaned, /paused the offer, clients were in the Middle East/);
});

test("stripBannedPhrases: replaces en dashes with comma-space (#397)", () => {
  const dirty = "She asked for Friday – Tuesday windows.";
  const cleaned = stripBannedPhrases(dirty);
  assert.equal(cleaned.includes("–"), false, "en dash must be gone");
  assert.match(cleaned, /Friday, Tuesday windows/);
});

test("stripBannedPhrases: handles multiple em dashes in one string", () => {
  const dirty = "First part — middle part — last part.";
  const cleaned = stripBannedPhrases(dirty);
  assert.equal(cleaned.includes("—"), false);
  assert.match(cleaned, /First part, middle part, last part/);
});

test("sanitizeReplyBrief: scrubs em dashes from on_you (the canonical leak)", () => {
  // Regression: the Brandon thread's on_you came back as "He's paused a
  // job offer because the clients are in the Middle East — that's the
  // big thing worth acknowledging." The "big thing" framing is handled
  // by the fidelity prompts now (#390); the em-dash is handled here.
  const brief = sanitizeReplyBrief({
    where_it_stands: "You asked Brandon whether he was exploring exec opportunities.",
    on_you: "He's paused a job offer — the clients are based in the Middle East.",
    required_points: [],
    optional_followups: [],
    handled_points: []
  });
  assert.ok(brief);
  assert.equal(brief.on_you.includes("—"), false, "em dash must be stripped from on_you");
});

test("sanitizeReplyBrief: scrubs em dashes from where_it_stands and fuller_context", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "She sent two messages — both about the trip.",
    on_you: "Reply with the dates.",
    fuller_context: "Started in March — covers both the move and the new role.",
    durable_context: "Old uni friend — works in product now.",
    tone_steer: "Warm — not corporate.",
    required_points: [{ id: "x", text: "Pick a date — Friday works.", status: "required" }],
    optional_followups: [],
    handled_points: []
  });
  assert.ok(brief);
  assert.equal(brief.where_it_stands.includes("—"), false);
  assert.equal((brief.fuller_context ?? "").includes("—"), false);
  assert.equal((brief.durable_context ?? "").includes("—"), false);
  assert.equal((brief.tone_steer ?? "").includes("—"), false);
  assert.equal(brief.required_points[0].text.includes("—"), false);
});

test("sanitizeReplyBrief: scrubs em dashes from they_said bullets", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "You asked about exec search.",
    on_you: "Acknowledge the paused offer.",
    they_said: [
      { id: "x", text: "He paused the offer — region was Middle East." }
    ],
    required_points: [],
    optional_followups: [],
    handled_points: []
  });
  assert.ok(brief);
  assert.equal(brief.they_said.length, 1);
  assert.equal(brief.they_said[0].text.includes("—"), false);
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

// Substance ("they said") field — the core regression this expansion is
// fixing. Multi-part inbound where the contact answered the operator's
// question across several distinct beats (recruiters, interview status,
// an offer, a Middle East constraint) must keep each beat as its own
// bullet — not collapse into one vague summary. See Brandon-shaped
// fixture below. Required_points stays conservative: Brandon didn't
// explicitly ask anything, so under the tightened prompt only the
// single weightiest acknowledgement is required; further acks and any
// "ask back" moves live in optional_followups so the rail doesn't
// invent homework on a no-ask thread.
test("sanitizeReplyBrief: they_said substance bullets pass through with stable ids", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "You asked Brandon if he'd started exploring executive search.",
    on_you:
      "He's slightly paused a job offer because the clients are in the Middle East — that's the big thing worth acknowledging.",
    they_said: [
      {
        id: "recruiter",
        text:
          "He explained that executive search normally involves partnering with a recruiter or team who pitch your CV to companies."
      },
      { id: "interviews", text: "He has a couple of interviews still active." },
      { id: "offer", text: "He has secured one offer." },
      { id: "pause", text: "He paused that offer because the clients are based in the Middle East." }
    ],
    required_points: [
      {
        id: "ack-pause",
        text: "Acknowledge the paused offer in the Middle East",
        status: "required"
      }
    ],
    optional_followups: [
      {
        id: "ack-explain",
        text: "Acknowledge his explanation of how exec search works",
        status: "optional"
      },
      {
        id: "ask-rest",
        text: "Ask how the remaining interviews are going",
        status: "optional"
      }
    ]
  });
  assert.ok(brief);
  assert.equal(brief.they_said?.length, 4);
  // Each Brandon-substance beat survives — the prompt's job is to extract
  // them and the sanitiser's job is to pass them through verbatim.
  assert.match(brief.they_said?.[0].text ?? "", /recruiter|team|CV/);
  assert.match(brief.they_said?.[1].text ?? "", /interviews/);
  assert.match(brief.they_said?.[2].text ?? "", /offer/);
  assert.match(brief.they_said?.[3].text ?? "", /Middle East/);
  // Conservative required-points discipline on a no-ask thread:
  // exactly one acknowledgement; further moves are optional.
  assert.equal(brief.required_points.length, 1);
  assert.match(brief.required_points[0].text, /paused offer|Middle East/i);
  assert.equal(brief.optional_followups.length, 2);
});

test("sanitizeReplyBrief: they_said accepts plain strings and assigns stable ids", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "You asked about her week.",
    on_you: "Light acknowledgement is enough.",
    they_said: [
      "Her week was hectic with the new product launch.",
      "She's heading to Lagos on Friday for a friend's wedding."
    ]
  });
  assert.ok(brief);
  assert.equal(brief.they_said?.length, 2);
  assert.equal(brief.they_said?.[0].text, "Her week was hectic with the new product launch.");
  assert.ok((brief.they_said?.[0].id ?? "").length > 0);
  // Each item gets a unique id so React keys don't collide.
  assert.notEqual(brief.they_said?.[0].id, brief.they_said?.[1].id);
});

test("sanitizeReplyBrief: they_said deduplicates case-insensitively and caps at 6", () => {
  const tenStrings = Array.from({ length: 10 }, (_, i) => `Substance bullet ${i}`);
  // Include a duplicate of an existing bullet but in upper case to verify
  // the dedupe rule. The dupe stays out, the cap holds at 6.
  tenStrings.push("SUBSTANCE BULLET 0");
  const brief = sanitizeReplyBrief({
    where_it_stands: "Lots of substance.",
    on_you: "Acknowledge each.",
    they_said: tenStrings
  });
  assert.ok(brief);
  // Cap (MAX_THEY_SAID_POINTS = 6) holds, dedupe runs before the cap.
  assert.equal(brief.they_said?.length, 6);
});

test("sanitizeReplyBrief: they_said malformed entries are dropped, not trusted", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "Mixed inbound.",
    on_you: "On you.",
    they_said: [
      { id: "ok", text: "Real substance bullet" },
      { id: "missing-text" },
      { id: "empty", text: "   " },
      42,
      null
    ]
  });
  assert.ok(brief);
  assert.equal(brief.they_said?.length, 1);
  assert.equal(brief.they_said?.[0].text, "Real substance bullet");
});

test("sanitizeReplyBrief: they_said omitted by the model parses as an empty array", () => {
  // Older AI runs (pre-they_said) and reconnect-mode responses leave the
  // field out entirely. The sanitiser must still produce a brief — the
  // panel just hides the section when the list is empty.
  const brief = sanitizeReplyBrief({
    where_it_stands: "Quiet, mature thread.",
    on_you: "Nothing pending.",
    required_points: [],
    optional_followups: []
  });
  assert.ok(brief);
  assert.deepEqual(brief.they_said, []);
});

test("sanitizeReplyBrief: they_said strips banned coaching phrases the same way other fields do", () => {
  const brief = sanitizeReplyBrief({
    where_it_stands: "Where things stand.",
    on_you: "Light acknowledgement.",
    they_said: [
      "He shared a thoughtful update — would deepen the connection to follow up."
    ]
  });
  assert.ok(brief);
  // Banned phrase stripped; clean fragment survives.
  assert.equal(/deepen the connection/i.test(brief.they_said?.[0].text ?? ""), false);
});

test("sanitizeReplyBrief: handled_points reason carries the actual substance, not a generic", () => {
  // The prompt now requires reason to include the actual answer/substance
  // in compact form. The sanitiser passes it through up to 160 chars so
  // the operator can read "what was settled" without scrolling back.
  const brief = sanitizeReplyBrief({
    where_it_stands: "Trace.",
    on_you: "Nothing pending.",
    required_points: [],
    handled_points: [
      {
        id: "friday-h",
        text: "Confirm Friday at 11",
        status: "handled",
        reason: "she answered Friday at 11 works herself two messages later when you didn't reply right away"
      }
    ]
  });
  assert.ok(brief);
  assert.equal(brief.handled_points?.length, 1);
  assert.match(brief.handled_points?.[0].reason ?? "", /Friday at 11|herself/);
});

test("synthesiseFallbackBrief: falls back to an empty they_said list", () => {
  // The synthesiser is conservative — it never invents substance, so
  // older threads (pre-brief) get an empty array. The UI hides the
  // section when empty.
  const brief = synthesiseFallbackBrief({
    rollingSummary: "Brandon — old peer, last spoke about hiring.",
    whatTheyWant: "He hasn't asked anything specific.",
    openLoops: [],
    needsReply: false,
    latestInboundText: "all good, talk soon"
  });
  assert.deepEqual(brief.they_said, []);
});

test("briefSignatureForCache: empty string when brief is null", () => {
  // Predraft pre-warm + /data/thread both run this helper. Null brief
  // (older row, no JSON persisted yet) must produce the same key on both
  // sides so the cache hits.
  assert.equal(briefSignatureForCache(null), "");
});

test("briefSignatureForCache: a change to they_said flips the signature", () => {
  // Confirms the brief substance actually contributes to the cache key —
  // otherwise a new inbound that refreshed the brief wouldn't invalidate
  // the cached replies, and the operator would keep seeing replies
  // generated for the previous turn.
  const baseBrief = sanitizeReplyBrief({
    where_it_stands: "You asked about her week.",
    on_you: "Light acknowledgement is enough.",
    they_said: ["Her week was hectic with the new product launch."],
    required_points: []
  });
  const updatedBrief = sanitizeReplyBrief({
    where_it_stands: "You asked about her week.",
    on_you: "Light acknowledgement is enough.",
    they_said: [
      "Her week was hectic with the new product launch.",
      "She's heading to Lagos on Friday for a friend's wedding."
    ],
    required_points: []
  });
  assert.notEqual(briefSignatureForCache(baseBrief), briefSignatureForCache(updatedBrief));
});
