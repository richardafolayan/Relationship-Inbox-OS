import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../apps/dashboard/app/globals.css", import.meta.url), "utf8");

function oklchToLinearRgb(lightness, chroma, hueDegrees) {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ].map((channel) => Math.max(0, Math.min(1, channel)));
}

function hexToLinearRgb(hex) {
  return hex
    .match(/[a-f\d]{2}/gi)
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    );
}

function contrast(first, second) {
  const luminance = ([red, green, blue]) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

test("tertiary text and semantic status colours meet normal-text contrast", () => {
  const paper = oklchToLinearRgb(0.985, 0.005, 80);
  assert.ok(contrast(oklchToLinearRgb(0.555, 0.006, 80), paper) >= 4.5);
  assert.ok(contrast(oklchToLinearRgb(0.56, 0.11, 75), paper) >= 4.5);
  assert.ok(contrast(oklchToLinearRgb(0.54, 0.09, 155), paper) >= 4.5);

  const black = [0, 0, 0];
  assert.ok(contrast(oklchToLinearRgb(0.56, 0.01, 260), black) >= 4.5);
  assert.ok(contrast(oklchToLinearRgb(0.7, 0.11, 75), black) >= 4.5);
  assert.ok(contrast(oklchToLinearRgb(0.64, 0.09, 155), black) >= 4.5);
  assert.ok(contrast(hexToLinearRgb("c84b4b"), black) >= 4.5);
  assert.ok(contrast(hexToLinearRgb("c84b4b"), hexToLinearRgb("ffffff")) >= 4.5);
});

test("the audited contrast tokens remain wired into both themes", () => {
  assert.match(css, /--ink-4: oklch\(55\.5% 0\.006 80\)/);
  assert.match(css, /--ink-4:\s+oklch\(56% 0\.010 260\)/);
  assert.match(css, /--accent: #c84b4b/);
});
