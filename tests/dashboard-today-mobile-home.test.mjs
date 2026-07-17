import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pins the mobile Today home composition for issue #899:
// First up → Up next → Tonight → secondary, one vertical scroll owner,
// touch-sized primary actions, desktop layout kept independently.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TODAY = readFileSync(join(ROOT, "apps/dashboard/app/today/page.tsx"), "utf8");

test("Today page identity and queue count are always present", () => {
  assert.match(TODAY, /data-testid="today-page"/);
  assert.match(TODAY, /data-testid="today-queue-count"/);
  assert.match(TODAY, /need you tonight/);
  // Mobile title is "Today"; desktop keeps the greeting line.
  assert.match(TODAY, /md:hidden">Today</);
  assert.match(TODAY, /hidden md:inline">\{greetingLine\}</);
});

test("mobile home exposes First up, Up next, and compact Tonight sections", () => {
  assert.match(TODAY, /data-testid="today-hero"/);
  assert.match(TODAY, /data-testid="today-up-next"/);
  assert.match(TODAY, /data-testid="today-tonight-compact"/);
  assert.match(TODAY, /data-testid="today-up-next-card"/);
  assert.match(TODAY, />\s*Up next\s*</);
  assert.match(TODAY, />\s*Tonight\s*</);
});

test("primary hero actions meet mobile touch-target guidance", () => {
  assert.match(TODAY, /data-testid="today-hero-actions"/);
  const actions = TODAY.match(
    /data-testid="today-hero-actions"[\s\S]*?<\/div>\s*\{queuePeek/
  );
  assert.ok(actions, "hero actions block must be present");
  const block = actions[0];
  assert.match(block, /min-h-\[44px\]/);
  assert.match(block, /Open &amp; reply|Open & reply/);
  assert.match(block, /Mark handled/);
  // Full-width primary on phones, auto width from sm up.
  assert.match(block, /col-span-2 min-h-\[44px\] w-full/);
});

test("mobile secondary content sits below the reply workflow", () => {
  assert.match(TODAY, /data-testid="today-mobile-secondary"/);
  assert.match(TODAY, /data-testid="today-secondary-rail"/);
  // Tour/setup lead on desktop only; mobile copies live under the workflow.
  assert.match(TODAY, /hidden md:block[\s\S]*?renderTourInvite\(\)/);
  assert.match(TODAY, /today-mobile-secondary[\s\S]*?renderTourInvite\(\)/);
});

test("desktop Then these + full Tonight progress remain intact", () => {
  assert.match(TODAY, /data-testid="today-then-these"/);
  assert.match(TODAY, /hidden md:block[\s\S]*?Then these, in order/);
  assert.match(TODAY, /data-testid="today-tonight-desktop"/);
  assert.match(TODAY, /Tonight's progress|Tonight’s progress/);
  assert.match(TODAY, /CategoryBar/);
  assert.match(TODAY, /lg:grid-cols-\[1fr_260px\]/);
});

test("layout does not introduce a nested vertical scroller on Today", () => {
  // App shell main remains the scroll owner; Today must not add overflow-y
  // containers that compete with it on mobile.
  const overflowY = [...TODAY.matchAll(/overflow-y-[a-z]+/g)].map((m) => m[0]);
  assert.deepEqual(
    overflowY,
    [],
    `Today must not declare overflow-y scroller classes, found: ${overflowY.join(", ")}`
  );
  assert.match(TODAY, /pb-\[calc\(96px\+env\(safe-area-inset-bottom\)\)\]/);
});

test("mobile Tonight uses a compact summary rather than full category bars", () => {
  assert.match(TODAY, /renderTonightProgress\("compact"\)/);
  assert.match(TODAY, /renderTonightProgress\("full"\)/);
  assert.match(TODAY, /variant === "compact"/);
  assert.match(TODAY, /All clear for tonight|Nothing queued yet/);
});

test("new mobile Today UI copy avoids em and en dashes", () => {
  // Only check short JSX text nodes that look like labels, not code comments.
  const uiStrings = [...TODAY.matchAll(/>([^<>{\n]{1,80})</g)]
    .map((m) => m[1].trim())
    .filter(
      (s) =>
        s.length > 0 &&
        /^(Today|Up next|Tonight|Open|Snooze|Mark handled|Inbox|\+\s|\d)/.test(s)
    );
  assert.ok(uiStrings.length >= 3, "expected several mobile UI labels");
  for (const s of uiStrings) {
    assert.doesNotMatch(s, /[—–]/, `UI copy must not use em/en dashes: ${JSON.stringify(s)}`);
  }
  // Explicit mobile labels introduced for #899.
  assert.match(TODAY, /md:hidden">Today</);
  assert.match(TODAY, />\s*Up next\s*</);
  assert.match(TODAY, />\s*Tonight\s*</);
  assert.match(TODAY, /Open &amp; reply/);
  assert.match(TODAY, /Mark handled/);
  assert.match(TODAY, /sm:hidden">Snooze</);
});
