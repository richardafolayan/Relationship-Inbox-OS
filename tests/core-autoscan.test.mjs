import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAutoScanDisabled,
  resolveAutoScanInitialEnabled
} from "../packages/core/dist/autoscan.js";

// Auto-scan now defaults to ENABLED regardless of NODE_ENV. The earlier
// "disabled-by-default-in-dev" rule meant operators had to set
// NEXT_PUBLIC_DISABLE_AUTOSCAN=0 AND restart the Next.js dev server for
// the env-var change to land in the client bundle — heavy lift for a
// localStorage-governed toggle. Now the user opts out explicitly via the
// env var instead, and the topbar toggle plus localStorage govern the
// active state.
test("resolveAutoScanDisabled defaults to enabled in dev when unset", () => {
  assert.equal(
    resolveAutoScanDisabled({
      nodeEnv: "development",
      disableAutoScan: undefined,
      legacyDisableAutoScan: undefined
    }),
    false
  );
});

test("resolveAutoScanDisabled defaults to enabled in production when unset", () => {
  assert.equal(
    resolveAutoScanDisabled({
      nodeEnv: "production",
      disableAutoScan: undefined,
      legacyDisableAutoScan: undefined
    }),
    false
  );
});

test("resolveAutoScanDisabled honors explicit env overrides", () => {
  assert.equal(
    resolveAutoScanDisabled({
      nodeEnv: "development",
      disableAutoScan: "0",
      legacyDisableAutoScan: undefined
    }),
    false
  );
  assert.equal(
    resolveAutoScanDisabled({
      nodeEnv: "development",
      disableAutoScan: "1",
      legacyDisableAutoScan: undefined
    }),
    true
  );
  assert.equal(
    resolveAutoScanDisabled({
      nodeEnv: "production",
      disableAutoScan: "0",
      legacyDisableAutoScan: "1"
    }),
    true
  );
});

test("resolveAutoScanInitialEnabled only restores explicit true state when allowed", () => {
  assert.equal(
    resolveAutoScanInitialEnabled({
      envDisabled: true,
      storedValue: "true"
    }),
    false
  );
  assert.equal(
    resolveAutoScanInitialEnabled({
      envDisabled: false,
      storedValue: "true"
    }),
    true
  );
  assert.equal(
    resolveAutoScanInitialEnabled({
      envDisabled: false,
      storedValue: "false"
    }),
    false
  );
  assert.equal(
    resolveAutoScanInitialEnabled({
      envDisabled: false,
      storedValue: null
    }),
    false
  );
});
