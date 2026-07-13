import test from "node:test";
import assert from "node:assert/strict";

// First-run setup wizard (#845): the gating decision that controls whether
// a fresh app open shows the wizard, silently auto-completes an already
// set-up install, or stays hidden. setup-wizard.ts is framework-free, so
// the tsx loader resolves the .ts import directly.
const {
  isSetupComplete,
  markSetupComplete,
  resolveSetupGate,
  SETUP_WIZARD_COMPLETE_KEY
} = await import("../apps/dashboard/lib/setup-wizard.ts");

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key)
  };
}

test("a fresh install with nothing configured shows the wizard", () => {
  assert.equal(
    resolveSetupGate({ storedComplete: false, aiConfigured: false, anyPlatformConnected: false }),
    "show"
  );
});

test("an already set-up install auto-completes instead of showing", () => {
  assert.equal(
    resolveSetupGate({ storedComplete: false, aiConfigured: true, anyPlatformConnected: false }),
    "auto-complete"
  );
  assert.equal(
    resolveSetupGate({ storedComplete: false, aiConfigured: false, anyPlatformConnected: true }),
    "auto-complete"
  );
  assert.equal(
    resolveSetupGate({ storedComplete: false, aiConfigured: true, anyPlatformConnected: true }),
    "auto-complete"
  );
});

test("a completed or dismissed wizard never comes back on its own", () => {
  assert.equal(
    resolveSetupGate({ storedComplete: true, aiConfigured: false, anyPlatformConnected: false }),
    "hidden"
  );
});

test("unknown runner state never shows the wizard", () => {
  assert.equal(
    resolveSetupGate({ storedComplete: false, aiConfigured: null, anyPlatformConnected: false }),
    "hidden"
  );
  assert.equal(
    resolveSetupGate({ storedComplete: false, aiConfigured: false, anyPlatformConnected: null }),
    "hidden"
  );
  assert.equal(
    resolveSetupGate({ storedComplete: false, aiConfigured: null, anyPlatformConnected: null }),
    "hidden"
  );
});

test("complete flag round-trips through storage", () => {
  const storage = memoryStorage();
  assert.equal(isSetupComplete(storage), false);
  markSetupComplete(storage);
  assert.equal(isSetupComplete(storage), true);
  assert.equal(storage.getItem(SETUP_WIZARD_COMPLETE_KEY), "1");
});
