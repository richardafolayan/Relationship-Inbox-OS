import test from "node:test";
import assert from "node:assert/strict";

// Regression test for the leading-wildcard bug (Q13).
//
// Both copies of the "kept an audio message" matcher used a leading
// `[^\n]{1,80}?` in the name slot. Because the patterns are anchored with
// `$`, that lazy wildcard would happily absorb up to 80 characters of
// arbitrary prefix prose — so a REAL inbound message that merely ENDS with
// the canonical phrase (e.g. "I really cannot believe she kept an audio
// message from you") matched and was silently dropped from the thread,
// needsReply, and AI pipelines.
//
// The fix replaces the leading wildcard with a bounded, name-shaped class
// so the slot can only hold something that looks like a contact display
// name (1-3 letter tokens), never a run of sentence prose.
//
// Exercise the dashboard boundary and canonical source together. The
// dashboard boundary re-exports the built browser-safe core subpath, so this
// also catches stale build output during the normal build-before-test flow.
const { isNonContentIMessageSystemEvent: dashboardImpl } = await import(
  "../apps/dashboard/lib/imessage-system-events.ts"
);
const { isNonContentIMessageSystemEvent: coreImpl } = await import(
  "../packages/core/src/imessage-system-events.ts"
);

// Real messages that END with the canonical phrase but carry several words
// of preceding prose. These are exactly what the 80-char wildcard hid.
// Every one MUST be treated as real content (false).
const realMessagesEndingInPhrase = [
  "I really cannot believe she kept an audio message from you",
  "Can you believe she kept an audio message I sent ages ago?",
  "wait so you actually kept an audio message from you",
  "Did you know that he secretly kept an audio message",
  "lol my sister said she kept an audio message from you",
  "honestly I never thought you kept an audio message from me",
  "so apparently they finally kept an audio message"
];

// Genuine system events that MUST still be filtered (true). Includes the
// edge shapes the core test already relies on: two-word display names and a
// phone number in the "from <name>" slot.
const genuineSystemEvents = [
  "Seyi kept an audio message from you.",
  "You kept an audio message from Lanre.",
  "Praise kept an audio message.",
  "You kept an audio message.",
  "Marianne Acheampong kept an audio message from you.",
  "You kept an audio message from +447951711949.",
  "seyi kept an audio message from you.",
  "SEYI KEPT AN AUDIO MESSAGE FROM YOU",
  "  Marianne kept an audio message from you.  "
];

for (const input of realMessagesEndingInPhrase) {
  test(`real message ending in phrase is NOT dropped: ${JSON.stringify(input)}`, () => {
    assert.equal(
      coreImpl(input),
      false,
      `core dropped a real message: ${JSON.stringify(input)}`
    );
    assert.equal(
      dashboardImpl(input),
      false,
      `dashboard dropped a real message: ${JSON.stringify(input)}`
    );
    // The public dashboard boundary and canonical source must agree.
    assert.equal(coreImpl(input), dashboardImpl(input));
  });
}

for (const input of genuineSystemEvents) {
  test(`genuine system event still filtered: ${JSON.stringify(input)}`, () => {
    assert.equal(
      coreImpl(input),
      true,
      `core failed to filter a system event: ${JSON.stringify(input)}`
    );
    assert.equal(
      dashboardImpl(input),
      true,
      `dashboard failed to filter a system event: ${JSON.stringify(input)}`
    );
    assert.equal(coreImpl(input), dashboardImpl(input));
  });
}
