import test from "node:test";
import assert from "node:assert/strict";
import { parseComposedFocusNote } from "../apps/runner/dist/services/ai.js";

// "Help me phrase this" (Focus setup sheet) — the response parser is the
// load-bearing safety piece: both notes must keep [Name] and [until] as
// LITERAL tokens (a baked-in real name or clock time would mis-personalise
// or go stale at send time), and a response that drops either token throws,
// which makes modelJson walk to the next provider instead of accepting a
// broken note. Pure + exported precisely so this file can pin it.

const good = {
  close: "Yo [Name], on the road till [until], will reply properly after.",
  professional: "Hi [Name], heads-down until [until], I'll come back to this properly after.",
  reason: "driving",
  untilTime: "21:00"
};

test("compose-note: a well-formed response passes through with tokens intact", () => {
  const out = parseComposedFocusNote(good);
  assert.ok(out.close.includes("[Name]") && out.close.includes("[until]"));
  assert.ok(out.professional.includes("[Name]") && out.professional.includes("[until]"));
  assert.equal(out.reason, "driving");
  assert.equal(out.untilTime, "21:00");
});

test("compose-note: a note that drops [until] is rejected (provider chain retries)", () => {
  assert.throws(() =>
    parseComposedFocusNote({ ...good, close: "Yo [Name], back at 9pm, reply after." })
  );
});

test("compose-note: a note that drops [Name] is rejected", () => {
  assert.throws(() =>
    parseComposedFocusNote({ ...good, professional: "Hi there, heads-down until [until]." })
  );
});

test("compose-note: em and en dashes are rewritten by the voice rules", () => {
  const out = parseComposedFocusNote({
    ...good,
    close: "Yo [Name] — locked in till [until] — reply after."
  });
  assert.equal(out.close.includes("—"), false);
  assert.equal(out.close.includes("–"), false);
  assert.ok(out.close.includes("[Name]") && out.close.includes("[until]"));
});

test("compose-note: reason is normalised to a short lowercase label", () => {
  assert.equal(parseComposedFocusNote({ ...good, reason: "  Driving!  " }).reason, "driving");
  assert.equal(
    parseComposedFocusNote({ ...good, reason: "Long Family Dinner Out East" }).reason,
    "long family dinner"
  );
  assert.equal(parseComposedFocusNote({ ...good, reason: "" }).reason, "");
});

test("compose-note: untilTime only survives as strict 24-hour HH:MM", () => {
  assert.equal(parseComposedFocusNote({ ...good, untilTime: "9pm" }).untilTime, null);
  assert.equal(parseComposedFocusNote({ ...good, untilTime: "25:00" }).untilTime, null);
  assert.equal(parseComposedFocusNote({ ...good, untilTime: null }).untilTime, null);
  assert.equal(parseComposedFocusNote({ ...good }).untilTime, "21:00");
  assert.equal(parseComposedFocusNote({ ...good, untilTime: "06:30" }).untilTime, "06:30");
});

test("compose-note: sentence starts are capitalised in both notes", () => {
  const out = parseComposedFocusNote({
    ...good,
    close: "yo [Name], gym till [until]. catch you after."
  });
  assert.match(out.close, /^Yo \[Name\]/);
  assert.ok(out.close.includes(". Catch you after"));
});
