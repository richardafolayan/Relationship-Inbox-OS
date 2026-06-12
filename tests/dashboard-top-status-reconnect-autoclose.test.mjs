import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// P3-PL5 (state-race): the TopStatus platform-reconnect modal stayed open
// showing an empty body after the last degraded platform reconnected. The
// modal's open-state (`reconnectOpen`) is tracked separately from the data
// that justifies it (`degradedPlatforms`, derived fresh each render from the
// polled snapshot). When the list emptied — via the operator's Reconnect
// click, a background 5s poll, or a runner-event refresh — the boolean stayed
// true, leaving the modal showing "These platforms aren't connected" over an
// empty list: a self-contradictory dead-end until manual Close.
//
// The fix extracts the close decision into a pure predicate and an effect
// that auto-closes the modal once nothing is left to reconnect. This test
// covers the predicate directly and asserts the effect is wired in the
// component, mirroring dashboard-profile-drawer-state-race.test.mjs.

// platform-reconnect.ts is framework-free, so the tsx loader resolves the .ts
// import directly (matches the dashboard-favourites.test.mjs pattern).
const { shouldAutoCloseReconnect } = await import(
  "../apps/dashboard/lib/platform-reconnect.ts"
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "top-status.tsx"),
  "utf8"
);

test("shouldAutoCloseReconnect closes only when the modal is open and nothing is degraded", () => {
  // The bug condition: modal open, but the degraded list has emptied.
  assert.equal(
    shouldAutoCloseReconnect(true, false),
    true,
    "an open modal with no degraded platforms must auto-close"
  );
  // Still work to do — keep the modal open.
  assert.equal(
    shouldAutoCloseReconnect(true, true),
    false,
    "an open modal with degraded platforms remaining must stay open"
  );
  // Already closed — nothing to do, must not thrash setReconnectOpen.
  assert.equal(
    shouldAutoCloseReconnect(false, false),
    false,
    "a closed modal must not be re-closed"
  );
  assert.equal(
    shouldAutoCloseReconnect(false, true),
    false,
    "a closed modal stays closed even while platforms are degraded"
  );
});

test("top-status imports the auto-close predicate", () => {
  assert.match(
    SRC,
    /import \{ shouldAutoCloseReconnect \} from "@\/lib\/platform-reconnect";/,
    "shouldAutoCloseReconnect must be imported"
  );
});

test("top-status wires an effect that auto-closes the modal via the predicate", () => {
  // The effect must call the predicate against reconnectOpen + hasDegraded and
  // close the modal when it returns true, with both values in its deps so it
  // re-runs when a poll/runner-event flips hasDegraded.
  assert.match(
    SRC,
    /useEffect\(\(\) => \{\s*if \(shouldAutoCloseReconnect\(reconnectOpen, hasDegraded\)\) \{\s*setReconnectOpen\(false\);\s*\}\s*\}, \[reconnectOpen, hasDegraded\]\);/,
    "an effect must auto-close the modal when shouldAutoCloseReconnect is true, keyed on [reconnectOpen, hasDegraded]"
  );
});
