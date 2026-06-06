import test from "node:test";
import assert from "node:assert/strict";
import { toTypingUnits, humanType } from "../apps/runner/dist/platforms/humanize.js";

// Matches a lone (unpaired) UTF-16 surrogate — the corruption signature.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("toTypingUnits keeps emoji / non-BMP characters as single units", () => {
  const text = "hi \u{1F602}\u{1F602} there \u{1D54F}!"; // two 😂 + 𝕏
  const units = toTypingUnits(text);

  // Code-point count, not UTF-16 code-unit count.
  assert.equal(units.length, Array.from(text).length);
  assert.ok(units.length < text.length, "non-BMP text must have fewer units than code units");

  // No unit is a lone surrogate, and each emoji is exactly one unit.
  for (const unit of units) {
    assert.equal(LONE_SURROGATE.test(unit), false, `unit "${unit}" is an unpaired surrogate`);
  }
  assert.ok(units.includes("\u{1F602}"), "each 😂 must survive as one whole unit");
  assert.ok(units.includes("\u{1D54F}"), "𝕏 must survive as one whole unit");

  // Lossless round-trip.
  assert.equal(units.join(""), text);
});

test("toTypingUnits is a no-op shape for plain BMP/ASCII text", () => {
  const text = "Hello, world!";
  const units = toTypingUnits(text);
  assert.equal(units.length, text.length);
  assert.deepEqual(units, text.split(""));
  assert.equal(units.join(""), text);
});

test("humanType types each emoji as one whole keystroke, never a lone surrogate", async () => {
  const text = "ok \u{1F602} thanks \u{1F44D}"; // 😂 and 👍
  const typed = [];

  // Fake Playwright page: capture every string handed to keyboard.type.
  const page = {
    keyboard: {
      type: async (s) => {
        typed.push(s);
      },
    },
    mouse: { move: async () => {} },
  };
  // Fake target: alreadyFocused short-circuits the focus/click path, but keep
  // the methods present for safety.
  const target = {
    click: async () => {},
    focus: async () => {},
    boundingBox: async () => null,
  };

  await humanType(page, target, text, {
    alreadyFocused: true,
    reading: null,
    delay: { min: 0, max: 0 },
    noThink: true,
  });

  // Every typed chunk is a complete code point — none is an unpaired surrogate.
  for (const chunk of typed) {
    assert.equal(LONE_SURROGATE.test(chunk), false, `keyboard.type received unpaired surrogate: ${JSON.stringify(chunk)}`);
  }
  // The emoji arrived whole, and the full message reconstructs exactly.
  assert.ok(typed.includes("\u{1F602}"), "😂 must be typed as one keystroke");
  assert.ok(typed.includes("\u{1F44D}"), "👍 must be typed as one keystroke");
  assert.equal(typed.join(""), text);
});
