import test from "node:test";
import assert from "node:assert/strict";

// Regression test for P3-PL11 / issue #620 (residual hole after Q13).
//
// Q13 replaced the [^\n]{1,80}? wildcard in the <name> slot with a bounded
// 1-3 token name class. That class is still too loose: a short conversational
// clause of up to three lowercase tokens fits the slot, so a REAL inbound
// turn that merely ENDS on the canonical phrase was still matched and
// silently dropped from the thread, needsReply, and AI pipelines.
//
// The fix captures the <name> slot and applies a proper-noun guard: a
// multi-token prefix is only a name when every token is capitalised (or the
// whole prefix is an all-caps shouting row). Single-token prefixes stay
// permissive so all-lowercase / all-caps single names still match.
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

// Short real messages that END on the canonical phrase after 2-3 filler
// words. Each fits the old 1-3 token name slot and was wrongly dropped.
// Every one MUST be treated as real content (false).
const shortClausesEndingInPhrase = [
  "No way she kept an audio message.",
  "lol yeah he kept an audio message",
  "Aw glad you kept an audio message from you.",
  "I cannot believe you kept an audio message.",
  "so apparently they kept an audio message",
  "wow you kept an audio message from you"
];

// Genuine system events that MUST still be filtered (true), covering the
// edge shapes the existing tests rely on: single name, two-token name,
// all-caps row, all-lowercase single name, phone-number "from" slot.
const genuineSystemEvents = [
  "Seyi kept an audio message from you.",
  "You kept an audio message from Lanre.",
  "Praise kept an audio message.",
  "You kept an audio message.",
  "Marianne Acheampong kept an audio message from you.",
  "Marianne Acheampong kept an audio message.",
  "You kept an audio message from +447951711949.",
  "seyi kept an audio message from you.",
  "SEYI KEPT AN AUDIO MESSAGE FROM YOU",
  "NANA ATHLETICS kept an audio message from you.",
  "  Marianne kept an audio message from you.  "
];

for (const input of shortClausesEndingInPhrase) {
  test(`short clause ending in phrase is NOT dropped: ${JSON.stringify(input)}`, () => {
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
