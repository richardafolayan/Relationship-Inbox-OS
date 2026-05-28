import test from "node:test";
import assert from "node:assert/strict";

// localStorage isn't defined in Node, so we stub window with a tiny
// in-memory store before importing the helpers. This lets us assert
// the helpers round-trip values, treat missing entries as defaults,
// and never throw on quota / private-browsing failures.

function installFakeWindow() {
  const store = new Map();
  // Some tests will simulate "quota error" by throwing in setItem.
  let setShouldThrow = false;
  globalThis.window = {
    localStorage: {
      getItem(k) {
        return store.has(k) ? store.get(k) : null;
      },
      setItem(k, v) {
        if (setShouldThrow) throw new Error("quota");
        store.set(k, String(v));
      },
      removeItem(k) {
        store.delete(k);
      }
    }
  };
  return {
    store,
    setSetShouldThrow(value) {
      setShouldThrow = value;
    }
  };
}

const fake = installFakeWindow();

const { readFullDemoState, writeFullDemoState, clearFullDemoState, KEYS } = await import(
  "../apps/dashboard/lib/full-demo-state.ts"
);

test("readFullDemoState returns inactive defaults when storage is empty", () => {
  fake.store.clear();
  const state = readFullDemoState();
  assert.equal(state.active, false);
  assert.equal(state.mode, null);
  assert.equal(state.stepId, null);
  assert.equal(state.autoplay, false);
  assert.deepEqual(state.liveThreadIds, []);
});

test("writeFullDemoState / readFullDemoState round-trip", () => {
  fake.store.clear();
  writeFullDemoState({
    active: true,
    mode: "sandbox",
    stepId: "today",
    autoplay: true,
    liveThreadIds: ["a", "b"]
  });
  const state = readFullDemoState();
  assert.equal(state.active, true);
  assert.equal(state.mode, "sandbox");
  assert.equal(state.stepId, "today");
  assert.equal(state.autoplay, true);
  assert.deepEqual(state.liveThreadIds, ["a", "b"]);
});

test("clearFullDemoState removes every namespaced key", () => {
  fake.store.clear();
  writeFullDemoState({
    active: true,
    mode: "live",
    stepId: "x",
    autoplay: true,
    liveThreadIds: ["a"]
  });
  clearFullDemoState();
  for (const key of Object.values(KEYS)) {
    assert.equal(fake.store.get(key), undefined);
  }
});

test("readFullDemoState ignores invalid mode values", () => {
  fake.store.clear();
  fake.store.set(KEYS.mode, "not-a-valid-mode");
  const state = readFullDemoState();
  assert.equal(state.mode, null);
});

test("readFullDemoState ignores malformed live-threads JSON", () => {
  fake.store.clear();
  fake.store.set(KEYS.liveThreads, "{this is not json}");
  const state = readFullDemoState();
  assert.deepEqual(state.liveThreadIds, []);
});

test("readFullDemoState filters non-string entries from live-threads", () => {
  fake.store.clear();
  fake.store.set(KEYS.liveThreads, JSON.stringify(["a", 1, "b", null]));
  const state = readFullDemoState();
  assert.deepEqual(state.liveThreadIds, ["a", "b"]);
});

test("writeFullDemoState silently swallows storage failures", () => {
  fake.store.clear();
  fake.setSetShouldThrow(true);
  // Should NOT throw.
  writeFullDemoState({ active: true });
  fake.setSetShouldThrow(false);
});

test("writeFullDemoState with empty liveThreadIds clears the key", () => {
  fake.store.clear();
  writeFullDemoState({ liveThreadIds: ["x"] });
  assert.ok(fake.store.get(KEYS.liveThreads));
  writeFullDemoState({ liveThreadIds: [] });
  assert.equal(fake.store.get(KEYS.liveThreads), undefined);
});
