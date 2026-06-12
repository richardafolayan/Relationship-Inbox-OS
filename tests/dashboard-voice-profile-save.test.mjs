import test from "node:test";
import assert from "node:assert/strict";

// voice-profile-save.ts is framework-free, so the tsx loader resolves this
// .ts import directly (same pattern as dashboard-clean-ask-summary.test.mjs).
const { buildPendingSavePartial } = await import("../apps/dashboard/lib/voice-profile-save.ts");

// buildPendingSavePartial is the flush decision used by UserVoiceProfile's
// unmount cleanup: a text field auto-saves on a 600ms debounce, and if the
// component unmounts (onboarding card closing, navigation) before the timer
// fires, the queued save must be flushed instead of dropped — otherwise the
// just-typed name is lost (bug M20).

test("returns the partial for a pending name save so the typed value is flushed, not dropped", () => {
  const pending = { field: "displayName", value: "Sam" };
  assert.deepEqual(buildPendingSavePartial(pending), { displayName: "Sam" });
});

test("scopes the partial to exactly the queued field", () => {
  assert.deepEqual(buildPendingSavePartial({ field: "about", value: "Short and friendly." }), {
    about: "Short and friendly."
  });
});

test("returns null when nothing is pending (no flush on unmount)", () => {
  assert.equal(buildPendingSavePartial(null), null);
  assert.equal(buildPendingSavePartial(undefined), null);
});

test("preserves empty and whitespace values verbatim", () => {
  // The operator may have cleared a field; we persist exactly what was typed.
  assert.deepEqual(buildPendingSavePartial({ field: "interests", value: "" }), { interests: "" });
  assert.deepEqual(buildPendingSavePartial({ field: "interests", value: "  " }), {
    interests: "  "
  });
});
