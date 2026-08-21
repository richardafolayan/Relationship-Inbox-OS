import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// First-run setup wizard (#845): the gating decision that controls whether
// a fresh app open shows the wizard, silently auto-completes an already
// set-up install, or stays hidden. setup-wizard.ts is framework-free, so
// the tsx loader resolves the .ts import directly.
const {
  isSetupComplete,
  markSetupComplete,
  persistSetupCompletion,
  persistSetupProfile,
  resolveReconciledSetupGate,
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

test("a stale browser completion flag cannot hide incomplete runner setup", () => {
  assert.equal(
    resolveReconciledSetupGate({
      storedComplete: true,
      durableComplete: false,
      setupStarted: true,
      aiConfigured: false,
      anyPlatformConnected: false
    }),
    "show"
  );
});

test("runner reconciliation failure opens a blocking retry state", async () => {
  const source = await readFile(
    new URL("../apps/dashboard/components/common/SetupWizard.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /setSetupLoadState\("error"\);\s*setOpen\(true\);/);
  assert.match(source, /Setup will stay open until its saved state can be confirmed\./);
  assert.match(source, /setReconcileAttempt\(\(attempt\) => attempt \+ 1\)/);
});

test("durable completion and existing upgrades remain hidden", () => {
  assert.equal(
    resolveReconciledSetupGate({
      storedComplete: true,
      durableComplete: true,
      setupStarted: true,
      aiConfigured: false,
      anyPlatformConnected: false
    }),
    "hidden"
  );
  assert.equal(
    resolveReconciledSetupGate({
      storedComplete: false,
      durableComplete: false,
      setupStarted: false,
      aiConfigured: false,
      anyPlatformConnected: true
    }),
    "auto-complete"
  );
});

test("profile persistence failure cannot emit success or advance", async () => {
  let successEffects = 0;
  await assert.rejects(
    persistSetupProfile(
      async () => {
        throw new Error("runner offline");
      },
      () => {
        successEffects += 1;
      }
    ),
    /runner offline/
  );
  assert.equal(successEffects, 0);
});

test("completion marks the browser only after both durable writes succeed", async () => {
  const calls = [];
  await assert.rejects(
    persistSetupCompletion({
      persistProfileCompletion: async () => {
        calls.push("profile");
        throw new Error("profile unavailable");
      },
      persistPreferencesCompletion: async () => {
        calls.push("preferences");
      },
      markBrowserComplete: () => calls.push("browser")
    }),
    /profile unavailable/
  );
  assert.deepEqual(calls, ["profile"]);

  calls.length = 0;
  await assert.rejects(
    persistSetupCompletion({
      persistProfileCompletion: async () => {
        calls.push("profile");
      },
      persistPreferencesCompletion: async () => {
        calls.push("preferences");
        throw new Error("disk full");
      },
      markBrowserComplete: () => calls.push("browser")
    }),
    /disk full/
  );
  assert.deepEqual(calls, ["profile", "preferences"]);

  calls.length = 0;
  await persistSetupCompletion({
    persistProfileCompletion: async () => {
      calls.push("profile");
    },
    persistPreferencesCompletion: async () => {
      calls.push("preferences");
    },
    markBrowserComplete: () => calls.push("browser")
  });
  assert.deepEqual(calls, ["profile", "preferences", "browser"]);
});
