import test from "node:test";
import assert from "node:assert/strict";

// pilot-tour.ts is framework-free, so the tsx loader resolves this .ts
// import directly — see test:all in the root package.json.
const {
  PILOT_TOUR_SEEN_KEY,
  PILOT_TOUR_ACTIVE_KEY,
  getPilotTourSteps,
  isTourSeen,
  markTourSeen,
  clearTourSeen,
  isTourActive,
  markTourActive,
  clearTourActive
} = await import("../apps/dashboard/lib/pilot-tour.ts");

// In-memory storage matching the three methods pilot-tour.ts reads.
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
  // 6–10 steps keeps the walkthrough under two minutes.
  assert.ok(steps.length >= 6 && steps.length <= 10, `expected 6-10 steps, got ${steps.length}`);

  const keys = steps.map((s) => s.key);
  const required = [
    "today",
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

  // Every step body is short. 200 chars is roughly two short sentences.
  for (const step of steps) {
    assert.ok(step.body.length > 0, `step "${step.key}" has empty body`);
    assert.ok(step.body.length <= 200, `step "${step.key}" body too long (${step.body.length})`);
  }

  // No "not X, not Y" framing — the brief asked us to state what each
  // thing IS instead.
  const banned = [
    /\bnot a dashboard\b/i,
    /\bnot a crm\b/i,
    /\bnot a relationship score\b/i,
    /\bAI handles\b/i,
    /\blet AI reply\b/i
  ];
  for (const step of steps) {
    const copy = `${step.title} ${step.body}`;
    for (const re of banned) {
      assert.ok(!re.test(copy), `step "${step.key}" copy contains banned phrase ${re}`);
    }
  }
});

test("open-serena step is click-target so the operator drives navigation", () => {
  const steps = getPilotTourSteps();
  const openSerena = steps.find((s) => s.key === "open-serena");
  assert.ok(openSerena, "open-serena step missing");
  assert.equal(openSerena.continueMode, "click-target");
  // It should still declare a route so Back from a later step lands the
  // operator back on /today.
  assert.ok(typeof openSerena.navigateTo === "function");
  assert.equal(openSerena.navigateTo(), "/today");
});

test("destructive-action steps stay narrated with Next (no click-target)", () => {
  // clear-thread highlights Mark handled / Snooze / Archive. The brief
  // says: never auto-advance on a destructive action.
  const steps = getPilotTourSteps();
  const clearThread = steps.find((s) => s.key === "clear-thread");
  assert.notEqual(clearThread.continueMode, "click-target");
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
  // Seen flag is untouched.
  assert.equal(storage._raw.get(PILOT_TOUR_SEEN_KEY), undefined);
  // Active key has its own slot.
  assert.notEqual(PILOT_TOUR_ACTIVE_KEY, PILOT_TOUR_SEEN_KEY);
});

test("pilot tour anchors on existing data-demo-target attributes shared with full demo", () => {
  // Both flows resolve via the same selectors so the dashboard only has
  // to declare each anchor once. Anchors referenced by the pilot tour:
  const expected = new Set([
    "today-hero",
    "thread-row-demo-full-serena-imessage",
    "reply-brief",
    "reply-brief-where-it-stands",
    "reply-brief-on-you",
    "composer-input",
    "mark-handled",
    "snooze",
    "archive",
    "feedback"
  ]);
  const used = new Set();
  for (const step of getPilotTourSteps()) {
    for (const target of step.targets ?? []) {
      used.add(target);
    }
  }
  for (const name of used) {
    assert.ok(
      expected.has(name),
      `pilot tour references "${name}" — add it to expected anchors or the dashboard`
    );
  }
});
