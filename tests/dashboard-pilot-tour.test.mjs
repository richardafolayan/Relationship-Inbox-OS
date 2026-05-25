import test from "node:test";
import assert from "node:assert/strict";

// pilot-tour.ts is framework-free, so the tsx loader resolves this .ts
// import directly — see test:all in the root package.json.
const {
  PILOT_TOUR_SEEN_KEY,
  PILOT_TOUR_ACTIVE_KEY,
  PILOT_TOUR_SERENA_THREAD_KEY,
  PILOT_TOUR_TIMI_THREAD_KEY,
  getPilotTourSteps,
  emptyDemoIds,
  isTourSeen,
  markTourSeen,
  clearTourSeen,
  isTourActive,
  markTourActive,
  clearTourActive,
  nextStepIndex,
  prevStepIndex,
  isLastStep
} = await import("../apps/dashboard/lib/pilot-tour.ts");

// In-memory storage that matches the three methods pilot-tour.ts reads.
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: map
  };
}

test("pilot tour step list is calm, ordered, and covers the brief", () => {
  const steps = getPilotTourSteps();
  // The brief caps the tour at 7-10 steps; assert both bounds so we
  // notice when copy creep pushes the tour over the cap.
  assert.ok(steps.length >= 7 && steps.length <= 10, `expected 7-10 steps, got ${steps.length}`);

  const keys = steps.map((s) => s.key);
  // The mandatory beats from the brief should each appear once, in this order.
  const required = [
    "today-nav",
    "scanning-beat",
    "today-list",
    "open-serena",
    "reply-brief",
    "composer",
    "clear-thread",
    "feedback"
  ];
  for (const key of required) {
    assert.ok(keys.includes(key), `missing required step "${key}"`);
  }
  for (let i = 1; i < required.length; i += 1) {
    assert.ok(
      keys.indexOf(required[i]) > keys.indexOf(required[i - 1]),
      `step "${required[i]}" should come after "${required[i - 1]}"`
    );
  }

  // Reply Brief step prefers the new selectors but falls back to the
  // current right rail so the tour works before / after that branch lands.
  const replyBrief = steps.find((s) => s.key === "reply-brief");
  assert.deepEqual(replyBrief.targets, [
    "reply-brief-where-it-stands",
    "reply-brief-on-you",
    "reply-brief"
  ]);

  // Every step body is a couple of sentences max — the brief asked for
  // a calm tour, not paragraphs. 280 chars is roughly two sentences.
  for (const step of steps) {
    assert.ok(step.body.length > 0, `step "${step.key}" has empty body`);
    assert.ok(step.body.length <= 280, `step "${step.key}" body too long`);
  }
});

test("open-serena step navigates to the demo Serena thread when an id is known", () => {
  const steps = getPilotTourSteps();
  const serenaStep = steps.find((s) => s.key === "open-serena");
  assert.ok(serenaStep.navigateTo, "open-serena should declare a navigation target");
  // Without seeded ids, it stays put (returns null) rather than driving
  // the user to a broken /thread/null route.
  assert.equal(serenaStep.navigateTo(emptyDemoIds()), null);
  // With a seeded id, navigation lands on /thread/<cuid>.
  const target = serenaStep.navigateTo({ serena: "tid-serena", timi: "tid-timi" });
  assert.equal(target, "/thread/tid-serena");
});

test("seen-flag helpers read and write the documented localStorage key", () => {
  const storage = createStorage();
  assert.equal(isTourSeen(storage), false);
  markTourSeen(storage);
  assert.equal(storage._raw.get(PILOT_TOUR_SEEN_KEY), "1");
  assert.equal(isTourSeen(storage), true);
  clearTourSeen(storage);
  assert.equal(isTourSeen(storage), false);
});

test("active-flag helpers do not collide with the seen flag", () => {
  const storage = createStorage();
  markTourActive(storage);
  assert.equal(isTourActive(storage), true);
  assert.equal(isTourSeen(storage), false);
  clearTourActive(storage);
  assert.equal(isTourActive(storage), false);
  // The seen flag still hasn't been touched.
  assert.equal(storage._raw.get(PILOT_TOUR_SEEN_KEY), undefined);
});

test("step traversal advances and stops at the end", () => {
  const steps = getPilotTourSteps();
  // Walk all the way through; null = tour finished.
  let idx = 0;
  while (idx !== null && !isLastStep(steps, idx)) {
    idx = nextStepIndex(steps, idx);
  }
  assert.notEqual(idx, null);
  assert.ok(isLastStep(steps, idx));
  assert.equal(nextStepIndex(steps, idx), null);
  // prevStepIndex never underflows.
  assert.equal(prevStepIndex(steps, 0), 0);
  assert.equal(prevStepIndex(steps, 3), 2);
});

test("demo thread keys match the runner's seed", () => {
  // Cross-checked against apps/runner/src/services/demo.ts. Renaming
  // either constant would break the tour's "open Serena's thread" step
  // because it looks the row up by platformThreadId.
  assert.equal(PILOT_TOUR_SERENA_THREAD_KEY, "demo-pilot-serena-imessage");
  assert.equal(PILOT_TOUR_TIMI_THREAD_KEY, "demo-pilot-timi-linkedin");
});

test("the active and seen storage keys carry the documented namespace", () => {
  // The brief specifies these exact key strings; tests pin them down so
  // a localStorage migration doesn't silently leave testers in
  // "permanently dismissed" state.
  assert.equal(PILOT_TOUR_SEEN_KEY, "relationship-inbox-os:pilot-guided-demo-seen:v1");
  assert.equal(PILOT_TOUR_ACTIVE_KEY, "relationship-inbox-os:pilot-guided-demo-active:v1");
});
