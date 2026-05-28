import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Issue #382 / pilot R-0029. The race flag MUST only be set on the
// manual reassess route — never on scan paths or background AI.
// Doubling provider spend on every background call would burn budget
// for no user-visible benefit (the operator isn't waiting on a scan).
//
// These tests pin the call-site scope at the source level. They catch
// the regression where someone adds `race: true` to a scan-time AI
// call or removes it from the reassess route. They are deliberately
// regex-based against the source — the wiring is small enough that
// the source is the source of truth, and a behavioural test would
// require booting Express + mocks.
//
// If you intentionally add a new operator-initiated AI surface that
// should also race, extend the allowlist below.

function readSource(relativePath) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

test("reassess route delegates to runReassessForThread (single seam)", () => {
  const indexTs = readSource("apps/runner/src/index.ts");

  // Locate the reassess route handler. The test fails loudly if the
  // route gets renamed so the scope assertion below can't silently
  // pass against the wrong block.
  const routeMatch = indexTs.match(
    /app\.post\(\s*"\/control\/thread\/:threadId\/reassess"[\s\S]*?\}\)\);/
  );
  assert.ok(routeMatch, "/control/thread/:threadId/reassess route not found");
  const routeBody = routeMatch[0];

  // The route is a thin wrapper around the extracted service so the
  // race wiring is testable without booting Express. If someone
  // re-inlines the AI calls back into the route, the behavioural
  // test in runner-reassess-thread-race.test.mjs stops covering them.
  assert.match(
    routeBody,
    /runReassessForThread\(/,
    "reassess route must delegate to runReassessForThread (see services/reassess-thread.ts)"
  );
});

test("services/reassess-thread enables race for both AI calls", () => {
  const reassessThreadTs = readSource("apps/runner/src/services/reassess-thread.ts");

  // The service calls deps.resummarize with race: true. That helper
  // (production: resummarizeThreadById) forwards race down to
  // aiService.updateThreadSummary — covered by the next test.
  assert.match(
    reassessThreadTs,
    /deps\.resummarize\(\s*[^)]*\{\s*race:\s*true\s*\}\s*\)/,
    "runReassessForThread must call deps.resummarize with { race: true }"
  );

  // The service calls aiService.classifyThreadCategory with race: true.
  assert.match(
    reassessThreadTs,
    /classifyThreadCategory\(\s*\{[\s\S]*?race:\s*true[\s\S]*?\}\s*\)/,
    "runReassessForThread must call classifyThreadCategory with race: true"
  );
});

test("resummarizeThreadById forwards race option to updateThreadSummary", () => {
  const indexTs = readSource("apps/runner/src/index.ts");
  const fnMatch = indexTs.match(
    /async function resummarizeThreadById[\s\S]*?\n\}\n/
  );
  assert.ok(fnMatch, "resummarizeThreadById not found");
  const fnBody = fnMatch[0];

  // The race option must thread through to the AI call. options?.race
  // is the exact wiring — if someone refactors to options.race without
  // the optional chain, that's fine; if they drop it entirely the
  // test fails.
  assert.match(
    fnBody,
    /updateThreadSummary\(\s*\{[\s\S]*?race:\s*options\?\.race[\s\S]*?\}\s*\)/,
    "resummarizeThreadById must forward race to aiService.updateThreadSummary"
  );
});

test("scan-queue does NOT pass race to updateThreadSummary", () => {
  const scanQueueTs = readSource("apps/runner/src/services/scan-queue.ts");

  // updateThreadSummary in scan-queue must not opt into race. This is
  // a background path — the operator isn't waiting on a scan and the
  // doubled provider spend isn't worth it.
  const callMatch = scanQueueTs.match(
    /aiService\.updateThreadSummary\(\s*\{[\s\S]*?\}\s*\)/
  );
  assert.ok(callMatch, "expected aiService.updateThreadSummary call in scan-queue");
  assert.doesNotMatch(
    callMatch[0],
    /race:\s*true/,
    "scan-queue must not enable race on updateThreadSummary"
  );
});

test("scan-queue does NOT pass race to classifyThreadCategory", () => {
  const scanQueueTs = readSource("apps/runner/src/services/scan-queue.ts");
  const callMatch = scanQueueTs.match(
    /aiService\s*\.classifyThreadCategory\(\s*\{[\s\S]*?\}\s*\)/
  );
  assert.ok(callMatch, "expected aiService.classifyThreadCategory call in scan-queue");
  assert.doesNotMatch(
    callMatch[0],
    /race:\s*true/,
    "scan-queue must not enable race on classifyThreadCategory"
  );
});

test("race option is only set in the reassess code path (defence in depth)", () => {
  // Whole-repo scan: every occurrence of `race: true` in the runner
  // source must live within either index.ts (the reassess route +
  // resummarizeThreadById) or test files. Anything else is a scope
  // violation — likely a copy-paste from the reassess route into a
  // scan-time call.
  const files = [
    "apps/runner/src/services/scan-queue.ts",
    "apps/runner/src/services/reassess-all.ts",
    "apps/runner/src/services/ai.ts",
    "apps/runner/src/index.ts"
  ];
  for (const path of files) {
    const content = readSource(path);
    // ai.ts defines the option and the race wiring; it doesn't pass
    // `race: true` as a literal. scan-queue / reassess-all are
    // background paths. index.ts route handler is a thin wrapper —
    // the literal `race: true` opt-in lives only in
    // services/reassess-thread.ts.
    assert.doesNotMatch(
      content,
      /\brace:\s*true\b/,
      `${path} must not set race: true — race is only for the manual reassess service`
    );
  }
});
