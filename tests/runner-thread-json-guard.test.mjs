import test from "node:test";
import assert from "node:assert/strict";

// Runner logic ships as TypeScript compiled to dist/. We import the compiled
// helper (not src/index.ts, whose top-level start() would boot the Express
// server) under `node --import tsx --test`. filterDismissedOpenLoops sits on
// the /data/thread/:threadId read path and used to bare-parse the
// dismissedOpenLoopsJson column, so one corrupt row 500'd the whole thread.
import { filterDismissedOpenLoops } from "../apps/runner/dist/utils/open-loops.js";

test("filterDismissedOpenLoops degrades a corrupt dismissed column to no-op instead of throwing", () => {
  const loops = ["Reply about the offer", "Confirm the date"];
  // Truncated / partial-write JSON — exactly the kind of value that made the
  // bare JSON.parse throw out of the route and 500 /data/thread.
  const corrupt = '["Reply about the offer"';

  assert.doesNotThrow(() => filterDismissedOpenLoops(loops, corrupt));
  // Nothing parseable to dismiss => all loops are kept.
  assert.deepEqual(filterDismissedOpenLoops(loops, corrupt), loops);
});

test("filterDismissedOpenLoops still filters out dismissed loops for a valid column", () => {
  const loops = ["Reply about the offer", "Confirm the date"];
  const dismissedJson = JSON.stringify(["Confirm the date"]);

  assert.deepEqual(filterDismissedOpenLoops(loops, dismissedJson), [
    "Reply about the offer"
  ]);
});

test("filterDismissedOpenLoops returns loops unchanged when the column is null", () => {
  const loops = ["Reply about the offer"];
  assert.deepEqual(filterDismissedOpenLoops(loops, null), loops);
});
