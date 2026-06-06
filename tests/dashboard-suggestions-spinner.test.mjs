import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts import below.
const { computeRepliesGenerating } = await import(
  "../apps/dashboard/lib/suggestions-spinner.ts"
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "app", "thread", "[id]", "page.tsx"),
  "utf8"
);

// --- Pure derivation truth table -------------------------------------------

test("spinner shows only while the server is generating and we have not timed out", () => {
  assert.equal(computeRepliesGenerating(true, false), true);
  assert.equal(computeRepliesGenerating(true, true), false);
  assert.equal(computeRepliesGenerating(false, false), false);
  assert.equal(computeRepliesGenerating(false, true), false);
});

// --- Cross-thread navigation race ------------------------------------------
// The thread page does NOT remount across /thread/A -> /thread/B (same App
// Router dynamic segment). `suggestionsTimedOut` is a single piece of state
// shared across navigation. Model the page lifecycle the way
// dashboard-thread-identity-guard.test.mjs models the composer: the
// thread-change reset effect must clear the flag, or a timeout from A leaks
// into a still-generating B and suppresses its spinner.

function makeThreadPageModel() {
  // Mirrors the relevant slice of the page's state machine.
  let suggestionsTimedOut = false;

  return {
    // The 30s safety timer fired for the current thread.
    fireSafetyTimeout() {
      suggestionsTimedOut = true;
    },
    // The thread-change reset effect (apps/dashboard/app/thread/[id]/page.tsx,
    // lines ~902-928). After the fix it clears the thread-local timeout flag.
    runThreadChangeReset() {
      suggestionsTimedOut = false;
    },
    // The render-time derivation (line ~2412), via the pure helper.
    spinnerVisible(serverSaysGenerating) {
      return computeRepliesGenerating(serverSaysGenerating, suggestionsTimedOut);
    }
  };
}

test("a previous thread's timeout does not suppress the next thread's spinner", () => {
  const page = makeThreadPageModel();

  // Thread A is generating, then hits the 30s ceiling -> fallback chips.
  assert.equal(page.spinnerVisible(true), true, "A shows the spinner while generating");
  page.fireSafetyTimeout();
  assert.equal(page.spinnerVisible(true), false, "A falls back to static chips after the ceiling");

  // Operator navigates to B; the reset effect runs as navigation starts.
  page.runThreadChangeReset();

  // B is genuinely still generating: it MUST show the spinner, not A's
  // carried-over fallback. (Without the reset, suggestionsTimedOut would
  // still be true here and this assertion would fail.)
  assert.equal(page.spinnerVisible(true), true, "B shows the spinner instead of leaking A's timeout");
});

test("navigating to a thread that already has chips never shows the spinner", () => {
  const page = makeThreadPageModel();
  page.fireSafetyTimeout();
  page.runThreadChangeReset();
  // B is not generating (server reports ready / has chips).
  assert.equal(page.spinnerVisible(false), false);
});

// --- Static-source regression ----------------------------------------------
// The reset effect's JSX cannot be unit-mounted here, so guard the fix in
// place the same way dashboard-thread-page-state-race-guards.test.mjs does:
// the thread-change reset effect MUST clear suggestionsTimedOut. This fails
// before the fix (line absent) and passes after.

test("the thread-change reset effect clears the suggestions timeout flag", () => {
  // Scope to the reset effect: from the composer reset down to its deps array.
  const start = SRC.indexOf("setComposer(\"\");");
  assert.notEqual(start, -1, "located the thread-change reset effect");
  const end = SRC.indexOf("}, [threadId]);", start);
  assert.notEqual(end, -1, "located the end of the thread-change reset effect");
  const resetEffect = SRC.slice(start, end);
  assert.match(
    resetEffect,
    /setSuggestionsTimedOut\(false\);/,
    "reset effect must call setSuggestionsTimedOut(false) so a previous thread's timeout cannot suppress the next thread's spinner"
  );
});
