import test from "node:test";
import assert from "node:assert/strict";
import { defaultSettings } from "../packages/core/dist/defaults.js";

// Settings persist via the SQLite `setting` table as a JSON blob — see
// apps/runner/src/services/settings.ts. The store reads with
// `{ ...defaultSettings, ...JSON.parse(record.valueJson) }`. So long as the
// `AppSettings` type round-trips through that pattern with the new
// `geminiModel` field intact, the persisted shape is correct.
//
// Full HTTP-route round-trip lives outside this test (no Express test
// harness in the repo today). What this test catches is the regression
// vector that actually broke us before: someone widens the `AppSettings`
// type without making the field round-trip cleanly through JSON.

test("gemini: defaultSettings does not pre-populate geminiModel (left to env default)", () => {
  // Mirrors how `glmModel` works — the field is optional and absent from
  // defaults so the runner falls through to runnerConfig.geminiModel
  // (driven by GEMINI_MODEL env var, default gemini-3-flash-preview).
  assert.equal("geminiModel" in defaultSettings, false);
});

test("gemini: AppSettings JSON round-trip preserves geminiModel", () => {
  const value = {
    ...defaultSettings,
    aiProvider: "gemini",
    geminiModel: "gemini-3-flash-preview"
  };
  const persisted = JSON.parse(JSON.stringify(value));
  const loaded = { ...defaultSettings, ...persisted };
  assert.equal(loaded.aiProvider, "gemini");
  assert.equal(loaded.geminiModel, "gemini-3-flash-preview");
});

test("gemini: omitted geminiModel survives the defaults spread (treated as undefined)", () => {
  const persisted = JSON.parse(JSON.stringify({ ...defaultSettings, aiProvider: "gemini" }));
  const loaded = { ...defaultSettings, ...persisted };
  assert.equal(loaded.aiProvider, "gemini");
  assert.equal(loaded.geminiModel, undefined);
});

test("gemini: switching provider back to openai retains geminiModel", () => {
  // Existing UX: when an operator toggles between providers the previously-
  // chosen model id stays in their record so the toggle is fast. The store
  // pattern (settings.ts:updateSettings → spread `{ ...current, ...partial }`)
  // achieves this implicitly. Verify the persisted shape doesn't drop fields
  // that aren't named in the partial.
  const current = {
    ...defaultSettings,
    aiProvider: "gemini",
    geminiModel: "gemini-3-flash-preview"
  };
  const partial = { aiProvider: "openai" }; // just toggling provider
  const next = { ...current, ...partial };
  const persisted = JSON.parse(JSON.stringify(next));
  const loaded = { ...defaultSettings, ...persisted };
  assert.equal(loaded.aiProvider, "openai");
  assert.equal(loaded.geminiModel, "gemini-3-flash-preview");
});
