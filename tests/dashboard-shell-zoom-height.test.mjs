import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the app-shell height strategy under the big-screen zoom layer
// (globals.css). The shell must be sized via the html/body height: 100%
// percentage chain, never with viewport units: Chrome keeps 100vh
// physical inside a zoomed subtree while Safari divides viewport units
// by the effective zoom (standardized CSS zoom), so any vh-based shell
// height is wrong in one of the two engines. The original
// calc(100vh / var(--app-zoom)) double-divided in Safari and rendered
// the whole app at ~77% of the window (blank band under the inbox).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "apps/dashboard/app/globals.css"), "utf8");

function ruleBody(source, selectorStart) {
  const start = source.indexOf(selectorStart);
  assert.notEqual(start, -1, `expected globals.css to contain "${selectorStart}"`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

test("h-app-screen is sized by the percentage chain, not viewport units", () => {
  const body = ruleBody(css, ".h-app-screen");
  assert.match(body, /height:\s*100%/, ".h-app-screen must use height: 100%");
  assert.doesNotMatch(
    body,
    /\b\d+(\.\d+)?(vh|dvh|svh|lvh)\b/,
    ".h-app-screen must not use viewport units (Chrome and Safari resolve vh differently under CSS zoom)"
  );
});

test("html/body provide the 100% height chain the shell relies on", () => {
  const body = ruleBody(css, "html, body");
  assert.match(body, /height:\s*100%/, "html, body must set height: 100% so .h-app-screen resolves");
});

test("the zoom layer itself is still present for big screens", () => {
  // The fix changes how the shell height is computed, not the scale-up
  // behaviour: a 2200px+ window should still zoom the UI.
  assert.match(css, /@media \(min-width: 2200px\)/);
  assert.match(css, /zoom:\s*1\.3/);
});
