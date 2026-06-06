import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// #605: opening the ⌘K palette fires an async inbox fetch to index every
// thread for search. When it lands, setThreads recomputes the `items` memo
// into a new array reference, and the old `useEffect(() => setActiveIndex(0),
// [items])` snapped the keyboard selection back to the top mid-navigation.
// The fix re-keys the reset on [query] and clamps on [items.length].
const { clampActiveIndex } = await import("../apps/dashboard/lib/command-palette-search.ts");

test("#605: the inbox fetch landing keeps a still-valid selection (no jump to top)", () => {
  // User opened the palette (no query) and arrowed to row 5 of the 8 default
  // rows. The fetch lands; with no query the list is still 8 rows long.
  // The buggy effect reset this to 0 — the clamp must leave it at 5.
  assert.equal(clampActiveIndex(5, 8), 5);
  assert.equal(clampActiveIndex(0, 8), 0); // top stays top
  assert.equal(clampActiveIndex(7, 8), 7); // last stays last
});

test("clamps a now-out-of-range index to the last valid row", () => {
  // The query narrowed the list from 12 to 3 while the user sat on row 4.
  assert.equal(clampActiveIndex(4, 3), 2);
  assert.equal(clampActiveIndex(11, 3), 2);
});

test("empty list and stale indices collapse to 0 (never negative)", () => {
  assert.equal(clampActiveIndex(0, 0), 0);
  assert.equal(clampActiveIndex(7, 0), 0); // stale index, list went empty
  assert.equal(clampActiveIndex(-1, 8), 0); // never returns a negative index
  assert.equal(clampActiveIndex(-5, 0), 0);
});

// The effect itself isn't unit-mountable here, so pin the wiring statically
// (mirrors dashboard-thread-page-state-race-guards.test.mjs). These fail if
// the buggy pattern is reintroduced.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "command-palette.tsx"),
  "utf8"
);

test("the palette no longer force-resets the selection on an [items] change", () => {
  // The exact buggy effect: setActiveIndex(0) keyed on [items].
  assert.doesNotMatch(
    SRC,
    /setActiveIndex\(0\);\s*\n\s*\},\s*\[items\]\)/,
    "setActiveIndex(0) must not be keyed on [items]"
  );
});

test("the reset is keyed on [query] and the list change only clamps", () => {
  assert.match(
    SRC,
    /setActiveIndex\(0\);\s*\n\s*\},\s*\[query\]\)/,
    "reset-to-top must be keyed on [query]"
  );
  assert.match(
    SRC,
    /setActiveIndex\(\(i\)\s*=>\s*clampActiveIndex\(i,\s*items\.length\)\);\s*\n\s*\},\s*\[items\.length\]\)/,
    "a data-driven list change must clamp via clampActiveIndex on [items.length]"
  );
});
