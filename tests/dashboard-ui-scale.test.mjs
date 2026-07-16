import test from "node:test";
import assert from "node:assert/strict";

function installBrowserShim() {
  const attrs = new Map();
  const store = new Map();
  const events = [];
  globalThis.document = {
    documentElement: {
      getAttribute: (key) => (attrs.has(key) ? attrs.get(key) : null),
      setAttribute: (key, value) => attrs.set(key, String(value)),
      removeAttribute: (key) => attrs.delete(key)
    }
  };
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key)
  };
  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail ?? null;
    }
  }
  globalThis.CustomEvent = FakeCustomEvent;
  globalThis.window = {
    localStorage: globalThis.localStorage,
    CustomEvent: FakeCustomEvent,
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  return { attrs, store, events };
}

const shim = installBrowserShim();

const {
  parseUiScale,
  stepUiScale,
  applyUiScale,
  readUiScale,
  nudgeUiScale,
  UI_SCALE_STORAGE_KEY,
  UI_SCALE_CHANGE_EVENT,
  UI_SCALE_ORDER
} = await import("../apps/dashboard/lib/ui-scale.ts");

test("constants match the values the native menu bar pins", () => {
  // apps/desktop/main.cjs hard-codes these; if they drift the menu and the
  // Settings control silently stop sharing state.
  assert.equal(UI_SCALE_STORAGE_KEY, "inbox_os_ui_scale");
  assert.equal(UI_SCALE_CHANGE_EVENT, "inbox-ui-scale");
  assert.deepEqual([...UI_SCALE_ORDER], ["normal", "large", "extra"]);
});

test("parseUiScale only accepts the three known levels", () => {
  assert.equal(parseUiScale("large"), "large");
  assert.equal(parseUiScale("extra"), "extra");
  assert.equal(parseUiScale("normal"), "normal");
  assert.equal(parseUiScale(null), "normal");
  assert.equal(parseUiScale("huge"), "normal");
});

test("stepUiScale walks the levels and clamps at both ends", () => {
  assert.equal(stepUiScale("normal", "up"), "large");
  assert.equal(stepUiScale("large", "up"), "extra");
  assert.equal(stepUiScale("extra", "up"), "extra"); // clamp high
  assert.equal(stepUiScale("extra", "down"), "large");
  assert.equal(stepUiScale("large", "down"), "normal");
  assert.equal(stepUiScale("normal", "down"), "normal"); // clamp low
});

test("applyUiScale sets the attribute, persists, and fans out the change", () => {
  shim.attrs.clear();
  shim.store.clear();
  shim.events.length = 0;

  assert.equal(applyUiScale("large"), "large");
  assert.equal(shim.attrs.get("data-ui-scale"), "large");
  assert.equal(shim.store.get(UI_SCALE_STORAGE_KEY), "large");
  assert.equal(readUiScale(), "large");
  assert.equal(shim.events.at(-1)?.type, UI_SCALE_CHANGE_EVENT);
  assert.equal(shim.events.at(-1)?.detail?.scale, "large");
});

test("applyUiScale('normal') clears the attribute and the stored value", () => {
  shim.attrs.clear();
  shim.store.clear();
  applyUiScale("extra");
  assert.equal(shim.attrs.get("data-ui-scale"), "extra");

  applyUiScale("normal");
  assert.equal(shim.attrs.has("data-ui-scale"), false);
  assert.equal(shim.store.has(UI_SCALE_STORAGE_KEY), false);
  assert.equal(readUiScale(), "normal");
});

test("nudgeUiScale steps from the live value", () => {
  shim.attrs.clear();
  shim.store.clear();
  applyUiScale("normal");
  assert.equal(nudgeUiScale("up"), "large");
  assert.equal(nudgeUiScale("up"), "extra");
  assert.equal(nudgeUiScale("up"), "extra");
  assert.equal(nudgeUiScale("down"), "large");
});
