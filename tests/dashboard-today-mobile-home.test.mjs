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

test("setup slot is a single stable instance repositioned by CSS order", () => {
  assert.match(TODAY, /data-testid="today-setup-slot"/);
  assert.match(TODAY, /data-testid="today-secondary-rail"/);
  // Visual position only: mobile after workflow (order-10), desktop leads (order-first).
  assert.match(TODAY, /order-10 col-span-full md:order-first/);
  assert.match(TODAY, /order-20[\s\S]*?today-secondary-rail|today-secondary-rail[\s\S]*?order-20/);
});

test("stateful tour invite and voice setup mount only once (stable, no breakpoint remount)", () => {
  // No media-query branch that unmounts/remounts UserVoiceProfile across 768px
  // (rotation and SSR→client hydration would lose partial voice draft).
  assert.doesNotMatch(TODAY, /\buseMdUp\b|\bisMdUp\b/);
  assert.doesNotMatch(TODAY, /min-width:\s*768px/);

  // Not the old CSS dual-slot pattern (two trees both mounted, one hidden).
  assert.doesNotMatch(
    TODAY,
    /className="hidden md:block"[\s\S]{0,120}renderTourInvite\(\)[\s\S]{0,80}renderVoiceSetup\(\)/
  );
  assert.doesNotMatch(
    TODAY,
    /className="md:hidden"[\s\S]{0,80}renderTourInvite\(\)[\s\S]{0,80}renderVoiceSetup\(\)/
  );

  // Exactly one UserVoiceProfile JSX site and one call site for each setup helper.
  const voiceMounts = [...TODAY.matchAll(/<UserVoiceProfile\b/g)];
  assert.equal(
    voiceMounts.length,
    1,
    "exactly one <UserVoiceProfile> JSX site (renderVoiceSetup)"
  );

  const tourCalls = [...TODAY.matchAll(/renderTourInvite\(\)/g)];
  const voiceCalls = [...TODAY.matchAll(/renderVoiceSetup\(\)/g)];
  // Definition is `const renderTourInvite = () =>` - only one invocation in JSX.
  assert.equal(tourCalls.length, 1, "renderTourInvite called once");
  assert.equal(voiceCalls.length, 1, "renderVoiceSetup called once");

  // Single setup slot owns both surfaces (stable React identity across breakpoint).
  assert.match(
    TODAY,
    /data-testid="today-setup-slot"[\s\S]{0,200}renderTourInvite\(\)[\s\S]{0,80}renderVoiceSetup\(\)/
  );
});

test("partial voice setup draft is not tied to a breakpoint remount branch", () => {
  // Contract: draft state lives inside one UserVoiceProfile instance; Today
  // must not re-key or dual-branch that instance when the viewport crosses md.
  assert.doesNotMatch(TODAY, /key=\{[^}]*isMdUp/);
  assert.doesNotMatch(TODAY, /key=\{[^}]*mdUp/);
  assert.match(TODAY, /variant="onboarding"/);
  // Slot position is CSS-only (order), not a ternary that swaps trees.
  const setupSlot = TODAY.match(
    /data-testid="today-setup-slot"[\s\S]{0,400}<\/div>/
  );
  assert.ok(setupSlot, "setup slot present");
  assert.doesNotMatch(setupSlot[0], /\?\s*\(/);
  assert.doesNotMatch(setupSlot[0], /isMdUp|useMdUp|matchMedia/);
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
  assert.match(TODAY, /pb-8 md:pb-10/);
  assert.doesNotMatch(TODAY, /safe-area-inset-bottom/);
});

test("mobile Tonight uses a compact summary rather than full category bars", () => {
  assert.match(TODAY, /renderTonightProgress\("compact"\)/);
  assert.match(TODAY, /renderTonightProgress\("full"\)/);
  assert.match(TODAY, /variant === "compact"/);
  assert.match(TODAY, /All clear for tonight|Nothing queued yet/);
});

test("new mobile Today UI copy avoids em and en dashes", () => {
  // Only check short JSX text nodes that look like labels, not code comments.
  const textNodeStrings = [...TODAY.matchAll(/>([^<>{\n]{1,80})</g)]
    .map((m) => m[1].trim())
    .filter(
      (s) =>
        s.length > 0 &&
        /^(Today|Up next|Tonight|Open|Snooze|Mark handled|Inbox|\+\s|\d)/.test(s)
    );
  const inlineStatusStrings = [...TODAY.matchAll(/["']([^"'\n]{1,80})["']/g)]
    .map((m) => m[1].trim())
    .filter((s) => /^(Snooze|Snoozing|Mark handled|Marking)/.test(s));
  const uiStrings = [...textNodeStrings, ...inlineStatusStrings];
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
  assert.match(
    TODAY,
    /sm:hidden">\s*\{heroActionPending === "snooze" \? "Snoozing\.\.\." : "Snooze"\}/
  );
});
