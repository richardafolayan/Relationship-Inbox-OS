import test from "node:test";
import assert from "node:assert/strict";

const { isNonContentIMessageSystemEvent: dashboardImpl } = await import(
  "../apps/dashboard/lib/imessage-system-events.ts"
);
const { isNonContentIMessageSystemEvent: coreImpl } = await import("@inbox-os/core");

// The dashboard ships a copy of the helper because the rest of
// @inbox-os/core can't be webpack-bundled into the browser
// (transitive `node:crypto` import in `hash.js`). The two implementations
// must stay behaviourally identical — this test runs the same inputs
// through both and fails if they ever diverge.
const cases = [
  { input: "Seyi kept an audio message from you.", expected: true },
  { input: "You kept an audio message from Lanre.", expected: true },
  { input: "Praise kept an audio message.", expected: true },
  { input: "You kept an audio message.", expected: true },
  { input: "  Marianne kept an audio message from you.  ", expected: true },
  { input: "SEYI KEPT AN AUDIO MESSAGE FROM YOU", expected: true },
  { input: "Can you believe she kept an audio message I sent ages ago?", expected: false },
  { input: "Why did you keep that audio message?", expected: false },
  { input: "", expected: false },
  { input: null, expected: false },
  { input: undefined, expected: false }
];

for (const { input, expected } of cases) {
  test(`dashboard helper matches core helper on: ${JSON.stringify(input)}`, () => {
    const dashboardOutcome = dashboardImpl(input);
    const coreOutcome = coreImpl(input);
    assert.equal(
      dashboardOutcome,
      coreOutcome,
      `dashboard=${dashboardOutcome} vs core=${coreOutcome}`
    );
    assert.equal(dashboardOutcome, expected);
  });
}
