import test from "node:test";
import assert from "node:assert/strict";

// The dashboard ships ESM TypeScript. This test must be invoked with
// `node --import tsx --test ...` so the tsx hook resolves the .ts
// import below — see test:all in the root package.json.
const { FULL_DEMO_SCRIPT, SHOWCASE_THREAD_IDS, isStepInMode, getStepIndex } = await import(
  "../apps/dashboard/lib/full-demo-script.ts"
);

const VALID_MODES = new Set(["sandbox", "live", "both"]);
const VALID_PLACEMENTS = new Set(["top", "bottom", "left", "right", "center", undefined]);
const VALID_CONTINUE_MODES = new Set(["next", "click-target", undefined]);

test("every step has a unique id", () => {
  const ids = FULL_DEMO_SCRIPT.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every step has a non-empty title and body", () => {
  for (const step of FULL_DEMO_SCRIPT) {
    assert.ok(step.title?.length > 0, `${step.id} title is empty`);
    assert.ok(step.body?.length > 0, `${step.id} body is empty`);
  }
});

test("every step's mode is valid", () => {
  for (const step of FULL_DEMO_SCRIPT) {
    assert.ok(VALID_MODES.has(step.mode ?? "both"), `${step.id} has invalid mode: ${step.mode}`);
  }
});

test("every step's placement (when set) is valid", () => {
  for (const step of FULL_DEMO_SCRIPT) {
    assert.ok(
      VALID_PLACEMENTS.has(step.placement),
      `${step.id} has invalid placement: ${step.placement}`
    );
  }
});

test("every step's continueMode (when set) is valid", () => {
  for (const step of FULL_DEMO_SCRIPT) {
    assert.ok(
      VALID_CONTINUE_MODES.has(step.continueMode),
      `${step.id} has invalid continueMode: ${step.continueMode}`
    );
  }
});

test("script covers the documented surfaces", () => {
  const ids = new Set(FULL_DEMO_SCRIPT.map((s) => s.id));
  for (const required of [
    "opening",
    "today",
    "inbox",
    "open-serena",
    "serena-reply-brief",
    "serena-composer",
    "open-timi",
    "user-voice",
    "feedback",
    "settings",
    "closing"
  ]) {
    assert.ok(ids.has(required), `script is missing step "${required}"`);
  }
});

test("script copy drops the banned 'not X, not Y' framings the brief flagged", () => {
  // Keep this list tight — only phrases the brief specifically flagged.
  // Other negative phrasings ('blocked', 'no longer') are valid because
  // they state a guarantee, not a meaningless comparison.
  const banned = [
    /\bnot a dashboard\b/i,
    /\bnot a crm\b/i,
    /\bnot a relationship score\b/i,
    /\bAI handles\b/i,
    /\blet AI reply\b/i
  ];
  for (const step of FULL_DEMO_SCRIPT) {
    const copy = `${step.title} ${step.body}`;
    for (const re of banned) {
      assert.ok(!re.test(copy), `step "${step.id}" copy contains banned phrase ${re}`);
    }
  }
});

test("script body length stays calm (≤ 220 chars per step)", () => {
  for (const step of FULL_DEMO_SCRIPT) {
    assert.ok(
      step.body.length <= 220,
      `step "${step.id}" body too long (${step.body.length} chars)`
    );
  }
});

test("click-target steps land the operator on an inbox-style page so the click can happen", () => {
  // Click-target steps drive navigation through the operator clicking
  // the anchor (e.g. a thread row). The step's own `route` should be
  // an inbox-style listing — never a deep thread URL — so the row Link
  // is visible to be clicked.
  for (const step of FULL_DEMO_SCRIPT) {
    if (step.continueMode !== "click-target") continue;
    assert.ok(
      step.route && !step.route.startsWith("/thread/"),
      `click-target step "${step.id}" should have a non-thread route`
    );
    assert.equal(
      step.threadPlatformId,
      undefined,
      `click-target step "${step.id}" should not set threadPlatformId — the click drives that nav`
    );
  }
});

test("showcase thread ids match the runner's stable platformThreadIds", () => {
  assert.equal(SHOWCASE_THREAD_IDS.serena, "demo-full-serena-imessage");
  assert.equal(SHOWCASE_THREAD_IDS.timi, "demo-full-timi-linkedin");
  assert.equal(SHOWCASE_THREAD_IDS.brandon, "demo-full-brandon-linkedin");
  assert.equal(SHOWCASE_THREAD_IDS.multiLoop, "demo-full-multi-open-loop");
  assert.equal(SHOWCASE_THREAD_IDS.reconnect, "demo-full-reconnect");
  assert.equal(SHOWCASE_THREAD_IDS.snoozed, "demo-full-snoozed");
  assert.equal(SHOWCASE_THREAD_IDS.archived, "demo-full-archived");
});

test("isStepInMode honours mode filter and treats unset as both", () => {
  const sandboxOnly = { id: "x", title: "x", body: "x", mode: "sandbox" };
  const liveOnly = { id: "x", title: "x", body: "x", mode: "live" };
  const both = { id: "x", title: "x", body: "x" };
  assert.equal(isStepInMode(sandboxOnly, "sandbox"), true);
  assert.equal(isStepInMode(sandboxOnly, "live"), false);
  assert.equal(isStepInMode(liveOnly, "sandbox"), false);
  assert.equal(isStepInMode(liveOnly, "live"), true);
  assert.equal(isStepInMode(both, "sandbox"), true);
  assert.equal(isStepInMode(both, "live"), true);
});

test("getStepIndex returns 0 when the id is unknown or null", () => {
  assert.equal(getStepIndex(null), 0);
  assert.equal(getStepIndex("does-not-exist"), 0);
});

test("getStepIndex returns the correct index for a known id", () => {
  const knownId = FULL_DEMO_SCRIPT[2].id;
  assert.equal(getStepIndex(knownId), 2);
});

test("script ends on the closing step", () => {
  assert.equal(FULL_DEMO_SCRIPT[FULL_DEMO_SCRIPT.length - 1].id, "closing");
});

test("threadPlatformId references known showcase ids only", () => {
  const known = new Set(Object.values(SHOWCASE_THREAD_IDS));
  for (const step of FULL_DEMO_SCRIPT) {
    if (step.threadPlatformId) {
      assert.ok(
        known.has(step.threadPlatformId),
        `step "${step.id}" references unknown threadPlatformId "${step.threadPlatformId}"`
      );
    }
  }
});

test("steps never use /thread/{platformThreadId} in `route` (resolve via threadPlatformId instead)", () => {
  // Catch the regression that caused /thread/demo-full-serena-imessage to 404:
  // /thread/[id] takes the runner's internal cuid, not the platformThreadId,
  // so the script must use `threadPlatformId` and let the provider resolve.
  const platformIds = new Set(Object.values(SHOWCASE_THREAD_IDS));
  for (const step of FULL_DEMO_SCRIPT) {
    if (step.route?.startsWith("/thread/")) {
      const last = step.route.slice("/thread/".length);
      assert.equal(
        platformIds.has(last),
        false,
        `step "${step.id}" hardcodes a platformThreadId in route — use threadPlatformId instead`
      );
    }
  }
});
