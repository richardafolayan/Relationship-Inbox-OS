import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// P3-PL2: the ⌘K palette is mounted once for the whole app session (it lives
// in AppShell and only returns null while closed). The buggy version held its
// search state (query / activeIndex / threads) on that always-mounted
// component and reset it inside a post-commit `useEffect(..., [open])` whose
// first line was `if (!open) return`. Because that effect runs AFTER the
// reopen render commits, the first committed frame on reopen flashed the
// previous session's typed query, stale highlight, and filtered rows before
// the effect cleared them on the next tick.
//
// The fix splits the stateful body into an inner CommandPalettePanel that is
// mounted ONLY while open: the exported CommandPalette returns null when
// closed and renders the panel otherwise. Closing unmounts the panel, so the
// next open always mounts a fresh, blank panel — there is no stale state to
// flash. The component has no pure-function decision to unit-test, so (as with
// dashboard-command-palette-active-index.test.mjs) we pin the wiring with
// static source assertions that fail if the buggy pattern returns.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "command-palette.tsx"),
  "utf8"
);

test("the stateful body lives in an inner panel mounted only while open", () => {
  // A separate panel component exists...
  assert.match(
    SRC,
    /function CommandPalettePanel\b/,
    "search state must live in an inner CommandPalettePanel, not the always-mounted wrapper"
  );
  // ...and the exported wrapper renders it only when open, returning null
  // otherwise, so closing unmounts the panel and its state.
  assert.match(
    SRC,
    /export function CommandPalette\([^)]*\)\s*\{\s*if\s*\(!open\)\s*return null;\s*return\s*<CommandPalettePanel/,
    "CommandPalette must return null when closed and remount CommandPalettePanel when open"
  );
});

test("the search state is no longer held on the always-mounted wrapper", () => {
  // Isolate the exported wrapper body (up to the first inner `function`).
  const wrapper = SRC.split(/function CommandPalettePanel\b/)[0];
  const exported = wrapper.slice(wrapper.indexOf("export function CommandPalette("));
  assert.doesNotMatch(
    exported,
    /useState/,
    "the always-mounted wrapper must hold no search state (it would survive a close)"
  );
});

test("the palette no longer resets query in a post-commit [open] effect", () => {
  // The exact buggy shape: an effect that early-returns on !open and then
  // clears the query. Resetting after the reopen render commits is what
  // caused the one-frame flash of the previous search.
  assert.doesNotMatch(
    SRC,
    /if\s*\(!open\)\s*return;[\s\S]*?setQuery\(""\)/,
    "query must not be reset inside a post-commit [open] effect"
  );
  assert.doesNotMatch(
    SRC,
    /\},\s*\[open\]\)/,
    "there must be no [open]-keyed effect committing a reset after reopen"
  );
});

test("the selection-reset and clamp wiring from #605 is preserved", () => {
  // Guard against a regression of the sibling fix when restructuring: the
  // reset-to-top stays keyed on [query], and a data-driven list change only
  // clamps via clampActiveIndex on [items.length].
  assert.match(
    SRC,
    /setActiveIndex\(0\);\s*\n\s*\},\s*\[query\]\)/,
    "reset-to-top must remain keyed on [query]"
  );
  assert.match(
    SRC,
    /setActiveIndex\(\(i\)\s*=>\s*clampActiveIndex\(i,\s*items\.length\)\);\s*\n\s*\},\s*\[items\.length\]\)/,
    "a data-driven list change must clamp via clampActiveIndex on [items.length]"
  );
});
