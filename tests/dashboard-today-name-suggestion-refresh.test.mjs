import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Issue #478: the Today page rendered <ThreadRow /> without an
// `onPersonChanged` handler, so the row's "Maybe <name>" pill's onChanged was
// a no-op there. After a confirm/rename/dismiss the popover closed and the
// server updated, but the row kept the stale name until the next ~30s inbox
// poll. The fix passes the page's `refresh()` into ThreadRow so the row
// re-fetches immediately. ThreadRow already forwards onPersonChanged into the
// NameSuggestionPill (see dashboard-name-suggestion-pill.test.mjs for the
// pill's own contract).

const todaySrc = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/app/today/page.tsx", import.meta.url)),
  "utf8"
);

const threadRowSrc = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/components/common/thread-row.tsx", import.meta.url)),
  "utf8"
);

test("Today wires onPersonChanged into ThreadRow so the pill refreshes the row", () => {
  // The <ThreadRow> in Today's "Then these, in order" stack must receive an
  // onPersonChanged handler — otherwise a confirm/rename/dismiss on its pill
  // can't refresh the row until the next poll (the #478 bug).
  const rowBlock = todaySrc.match(/<ThreadRow[\s\S]*?\/>/);
  assert.ok(rowBlock, "Today should render a <ThreadRow />");
  assert.match(
    rowBlock[0],
    /onPersonChanged=\{refresh\}/,
    "Today's <ThreadRow> must pass onPersonChanged={refresh} (issue #478)"
  );
});

test("ThreadRow forwards onPersonChanged into the NameSuggestionPill", () => {
  // Guards the other half of the wiring: the prop must actually reach the
  // pill's onChanged, or passing it from Today would be inert.
  assert.match(threadRowSrc, /onPersonChanged\?\s*:\s*\(\)\s*=>\s*void/);
  assert.match(threadRowSrc, /onChanged=\{\(\)\s*=>\s*onPersonChanged\?\.\(\)\}/);
});
