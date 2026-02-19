import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAutoScanDisabled,
  resolveAutoScanInitialEnabled
} from "../packages/core/dist/autoscan.js";

test("resolveAutoScanDisabled defaults to disabled in dev when unset", () => {
  assert.equal(
    resolveAutoScanDisabled({
      nodeEnv: "development",
      disableAutoScan: undefined,
      legacyDisableAutoScan: undefined
    }),
    true
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
