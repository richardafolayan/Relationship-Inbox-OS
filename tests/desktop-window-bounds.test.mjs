import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveWindowBounds } = require("../apps/desktop/window-bounds.cjs");

const displays = [
  { primary: true, workArea: { x: 0, y: 0, width: 1440, height: 900 } },
  { primary: false, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } }
];

test("saved window bounds are clamped inside the display they overlap", () => {
  assert.deepEqual(
    resolveWindowBounds({ x: 3200, y: 900, width: 1000, height: 800 }, displays),
    { x: 2360, y: 280, width: 1000, height: 800 }
  );
});

test("off-screen saved bounds are replaced with a centered primary window", () => {
  assert.deepEqual(
    resolveWindowBounds({ x: 9000, y: 9000, width: 1200, height: 700 }, displays),
    { x: 80, y: 40, width: 1280, height: 820 }
  );
});

test("oversized saved windows fit the available work area", () => {
  assert.deepEqual(
    resolveWindowBounds({ x: 0, y: 0, width: 2000, height: 1200 }, displays),
    { x: 0, y: 0, width: 1440, height: 900 }
  );
});
