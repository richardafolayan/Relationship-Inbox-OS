import test from "node:test";
import assert from "node:assert/strict";
import {
  describeReactionsForPrompt,
  effectiveLastOutboundAt,
  parseReactionsFromRawJson
} from "../apps/runner/dist/services/reaction-effects.js";
import {
  prismaMessageToPrompt,
  formatMessageForPrompt
} from "../apps/runner/dist/services/ai.js";

// Issue #393 / pilot R-0033. Operator reactions (iMessage tapbacks) are
// stored on the parent message's rawJson, not as standalone rows. This
// means:
//   - aggregateOutbound (Prisma) misses them → needsReply stays true
//     even when the operator clearly responded with ❤️
//   - the AI prompt builder doesn't see them → drafts pretend the
//     operator never reacted
//
// These tests cover the two helpers that fix both leaks:
//   - effectiveLastOutboundAt(aggregateMax, messages): bumps the
//     timestamp with any OUT reactions
//   - describeReactionsForPrompt(reactions): produces the inline
//     "[operator reacted ❤️]" annotation that formatMessageForPrompt
//     appends to message text
//
// Plus a wiring test confirming prismaMessageToPrompt extracts the
// reactions from rawJson and formatMessageForPrompt renders them.

// ── parseReactionsFromRawJson ─────────────────────────────────────────

test("parseReactionsFromRawJson: empty/missing rawJson returns []", () => {
  assert.deepEqual(parseReactionsFromRawJson(null), []);
  assert.deepEqual(parseReactionsFromRawJson(undefined), []);
  assert.deepEqual(parseReactionsFromRawJson(""), []);
});

test("parseReactionsFromRawJson: malformed JSON returns [] (no throw)", () => {
  assert.deepEqual(parseReactionsFromRawJson("not json"), []);
  assert.deepEqual(parseReactionsFromRawJson("[]"), []);
  assert.deepEqual(parseReactionsFromRawJson('{"reactions":"not an array"}'), []);
});

test("parseReactionsFromRawJson: extracts well-formed reactions", () => {
  const raw = JSON.stringify({
    reactions: [
      { direction: "OUT", emoji: "❤", kind: "love", timestamp: "2026-05-28T13:00:00.000Z" },
      { direction: "IN", emoji: "👍", kind: "like" }
    ]
  });
  const parsed = parseReactionsFromRawJson(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].direction, "OUT");
  assert.equal(parsed[0].kind, "love");
  assert.equal(parsed[0].emoji, "❤");
  assert.equal(parsed[0].timestamp, "2026-05-28T13:00:00.000Z");
  assert.equal(parsed[1].direction, "IN");
  assert.equal(parsed[1].kind, "like");
});

test("parseReactionsFromRawJson: drops entries with removed:true", () => {
  const raw = JSON.stringify({
    reactions: [
      { direction: "OUT", emoji: "❤", kind: "love", removed: true },
      { direction: "OUT", emoji: "👍", kind: "like" }
    ]
  });
  const parsed = parseReactionsFromRawJson(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "like");
});

test("parseReactionsFromRawJson: drops entries with invalid direction or kind", () => {
  const raw = JSON.stringify({
    reactions: [
      { direction: "SIDEWAYS", emoji: "x", kind: "love" },
      { direction: "OUT", emoji: "x", kind: "celebrate" },
      { direction: "OUT", emoji: "❤", kind: "love" }
    ]
  });
  const parsed = parseReactionsFromRawJson(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, "love");
});

// ── effectiveLastOutboundAt ─────────────────────────────────────────

test("effectiveLastOutboundAt: returns aggregateMax when no reactions present", () => {
  const ts = new Date("2026-05-28T10:00:00.000Z");
  const result = effectiveLastOutboundAt(ts, [
    { rawJson: null },
    { rawJson: '{"reactions":[]}' }
  ]);
  assert.deepEqual(result, ts);
});

test("effectiveLastOutboundAt: bumps to latest OUT reaction timestamp", () => {
  // aggregateMax is from a real OUT message at 10:00. The operator then
  // reacted ❤️ to an inbound at 12:00. Effective lastOutboundAt should
  // be the 12:00 reaction — that's how we know the operator effectively
  // responded.
  const aggregateMax = new Date("2026-05-28T10:00:00.000Z");
  const messages = [
    {
      rawJson: JSON.stringify({
        reactions: [
          { direction: "OUT", emoji: "❤", kind: "love", timestamp: "2026-05-28T12:00:00.000Z" }
        ]
      })
    }
  ];
  const result = effectiveLastOutboundAt(aggregateMax, messages);
  assert.ok(result);
  assert.equal(result.toISOString(), "2026-05-28T12:00:00.000Z");
});

test("effectiveLastOutboundAt: IN reactions don't bump (operator didn't react)", () => {
  const aggregateMax = new Date("2026-05-28T10:00:00.000Z");
  const messages = [
    {
      rawJson: JSON.stringify({
        reactions: [
          { direction: "IN", emoji: "👍", kind: "like", timestamp: "2026-05-28T12:00:00.000Z" }
        ]
      })
    }
  ];
  const result = effectiveLastOutboundAt(aggregateMax, messages);
  assert.deepEqual(result, aggregateMax);
});

test("effectiveLastOutboundAt: returns null when nothing qualifies", () => {
  const result = effectiveLastOutboundAt(null, []);
  assert.equal(result, null);
});

test("effectiveLastOutboundAt: picks max across multiple messages with multiple reactions", () => {
  const aggregateMax = new Date("2026-05-28T08:00:00.000Z");
  const messages = [
    {
      rawJson: JSON.stringify({
        reactions: [
          { direction: "OUT", emoji: "❤", kind: "love", timestamp: "2026-05-28T11:00:00.000Z" }
        ]
      })
    },
    {
      rawJson: JSON.stringify({
        reactions: [
          { direction: "OUT", emoji: "👍", kind: "like", timestamp: "2026-05-28T15:00:00.000Z" },
          { direction: "IN", emoji: "😂", kind: "laugh", timestamp: "2026-05-28T20:00:00.000Z" }
        ]
      })
    }
  ];
  const result = effectiveLastOutboundAt(aggregateMax, messages);
  assert.ok(result);
  // 15:00 OUT wins (20:00 was IN, doesn't count).
  assert.equal(result.toISOString(), "2026-05-28T15:00:00.000Z");
});

// ── describeReactionsForPrompt ─────────────────────────────────────────

test("describeReactionsForPrompt: empty array returns empty string", () => {
  assert.equal(describeReactionsForPrompt([]), "");
});

test("describeReactionsForPrompt: single OUT reaction", () => {
  const out = describeReactionsForPrompt([
    { direction: "OUT", emoji: "❤", kind: "love" }
  ]);
  assert.equal(out, " [operator reacted ❤]");
});

test("describeReactionsForPrompt: mixed reactions are joined", () => {
  const out = describeReactionsForPrompt([
    { direction: "OUT", emoji: "❤", kind: "love" },
    { direction: "IN", emoji: "👍", kind: "like" }
  ]);
  assert.equal(out, " [operator reacted ❤, contact reacted 👍]");
});

// ── wiring: prismaMessageToPrompt + formatMessageForPrompt ─────────────

test("prismaMessageToPrompt: extracts reactions from rawJson", () => {
  const promptMsg = prismaMessageToPrompt({
    direction: "IN",
    text: "Outside your flat in 30 seconds",
    timestamp: new Date("2026-05-28T11:00:00.000Z"),
    rawJson: JSON.stringify({
      reactions: [
        { direction: "OUT", emoji: "❤", kind: "love", timestamp: "2026-05-28T11:05:00.000Z" }
      ]
    })
  });
  assert.ok(promptMsg.reactions);
  assert.equal(promptMsg.reactions?.length, 1);
  assert.equal(promptMsg.reactions?.[0].direction, "OUT");
});

test("prismaMessageToPrompt: leaves reactions undefined when no rawJson reactions", () => {
  const promptMsg = prismaMessageToPrompt({
    direction: "IN",
    text: "Hello",
    timestamp: new Date("2026-05-28T10:00:00.000Z"),
    rawJson: null
  });
  assert.equal(promptMsg.reactions, undefined);
});

test("formatMessageForPrompt: appends '[operator reacted X]' for OUT reactions", () => {
  // This is the canonical Olamide-thread regression: an inbound "Outside
  // your flat in 30 seconds" message that the operator reacted ❤️ to.
  // The AI prompt builder must surface that the operator responded —
  // even without typing — so suggested replies and the brief don't
  // pretend the operator was silent.
  const line = formatMessageForPrompt({
    direction: "IN",
    text: "Outside your flat in 30 seconds",
    timestamp: "2026-05-28T11:00:00.000Z",
    reactions: [
      { direction: "OUT", emoji: "❤", kind: "love" }
    ]
  });
  assert.match(line, /^contact \(2026-05-28T11:00:00\.000Z\): Outside your flat in 30 seconds \[operator reacted ❤\]$/);
});

test("formatMessageForPrompt: leaves plain messages unchanged", () => {
  const line = formatMessageForPrompt({
    direction: "IN",
    text: "Hello",
    timestamp: "2026-05-28T10:00:00.000Z"
  });
  assert.equal(line, "contact (2026-05-28T10:00:00.000Z): Hello");
});
