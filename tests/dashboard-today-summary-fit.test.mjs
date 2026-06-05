import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pins the "Today summaries always show in full" layout invariant. Richard:
// "the summary must fit so I see the whole thing... I want it solved entirely.
// Same with these summaries in the 'then these in order' list."
//
// The hero summary renders through <FitText> (it shrinks the font to fit and
// never truncates) and the needs-reply list row wraps its ask-summary in full.
// These tests stop a future change from silently re-introducing the old
// ellipsis (line-clamp on the hero, single-line `truncate` on the row).
//
// We extract the exact className STRING LITERALS rather than scanning whole
// files, so the explanatory comments in those files (which necessarily mention
// "line-clamp"/"truncate") can't trigger a false failure.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const TODAY = read("apps/dashboard/app/today/page.tsx");
const THREAD_ROW = read("apps/dashboard/components/common/thread-row.tsx");
const FIT_TEXT = read("apps/dashboard/components/common/fit-text.tsx");

test("Today hero summary renders via <FitText>, not a clamp/truncate", () => {
  assert.match(
    TODAY,
    /import\s*\{\s*FitText\s*\}\s*from\s*"@\/components\/common\/fit-text"/,
    "today/page.tsx must import FitText"
  );

  // Require whitespace + attributes so we match the real JSX element, not the
  // bare "<FitText>" mention inside the explanatory comment above it.
  const tag = TODAY.match(/<FitText\s+([\s\S]*?)>/);
  assert.ok(tag, "the hero summary must be rendered through <FitText>");
  const attrs = tag[1];

  assert.match(attrs, /data-testid="today-hero-summary"/, "hero summary needs its test id");
  for (const prop of ["maxPx", "minPx", "maxHeightPx"]) {
    assert.match(attrs, new RegExp(`\\b${prop}\\b`), `<FitText> must set ${prop}`);
  }

  const cls = attrs.match(/className="([^"]*)"/);
  assert.ok(cls, "<FitText> needs a className");
  assert.doesNotMatch(
    cls[1],
    /\btruncate\b|line-clamp/,
    "the hero summary must never be truncated or line-clamped"
  );
});

test("Today needs-reply row summary wraps in full; only the literal preview clamps", () => {
  assert.match(THREAD_ROW, /const\s+showingNudge\s*=/, "thread-row must branch on showingNudge");
  assert.match(THREAD_ROW, /data-testid="thread-row-summary"/, "row summary needs its test id");

  // The body className is a ternary: needs-reply summary vs literal preview.
  const ternary = THREAD_ROW.match(/showingNudge\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"/);
  assert.ok(ternary, "the row body className should branch on showingNudge");
  const [, needsReplyClass, previewClass] = ternary;

  assert.doesNotMatch(
    needsReplyClass,
    /\btruncate\b|line-clamp/,
    "the needs-reply ask-summary must wrap in full, never truncated/clamped"
  );
  // The longer literal last-message preview stays 2-line clamped so that
  // already-replied rows don't balloon — this half of the contract is allowed.
  assert.match(previewClass, /line-clamp-2/, "the literal preview should stay 2-line clamped");
});

test("FitText fits by measuring real height, never by clamping", () => {
  assert.match(FIT_TEXT, /ResizeObserver/, "FitText must re-fit on width changes");
  assert.match(FIT_TEXT, /scrollHeight/, "FitText must measure rendered height");
  assert.match(FIT_TEXT, /useLayoutEffect/, "FitText must measure before paint (no flash)");
});
