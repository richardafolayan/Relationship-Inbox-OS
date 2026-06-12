import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-contract guard for the send/scan focus-steal fix (companion to the
// #420 bringToFront guard). The window only becomes visible via
// revealBrowserWindow; that call must live ONLY in operator-initiated methods
// of the LinkedIn adapter (openThread / openProfileUrl). If a regression adds
// it to a scan/send path it would surface Chrome mid-task again.

const ADAPTER_PATH = "apps/runner/src/platforms/linkedin-adapter.ts";
const SESSION_MANAGER_PATH = "apps/runner/src/services/session-manager.ts";
const INDEX_PATH = "apps/runner/src/index.ts";

const OPERATOR_INITIATED_METHODS = new Set(["openThread", "openProfileUrl"]);

function stripComments(source) {
  let stripped = source.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  stripped = stripped.replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
  return stripped;
}

function locateContainingMethodName(source, offset) {
  const prefix = source.slice(0, offset);
  const matches = [
    ...prefix.matchAll(
      /(?:^|\n)\s*(?:public |private |protected )?(?:async )?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^\n{]+)?\s*\{/g
    )
  ];
  return matches.length ? matches[matches.length - 1][1] : null;
}

test("revealBrowserWindow appears only in operator-initiated adapter methods", () => {
  const source = stripComments(readFileSync(resolve(process.cwd(), ADAPTER_PATH), "utf8"));
  const occurrences = [...source.matchAll(/\brevealBrowserWindow\s*\(/g)].filter(
    // skip the import line
    (m) => !source.slice(Math.max(0, m.index - 40), m.index).includes("import")
  );
  assert.ok(occurrences.length >= 2, "openThread and openProfileUrl both reveal the window");
  const offenders = [];
  for (const occ of occurrences) {
    const containing = locateContainingMethodName(source, occ.index ?? 0);
    if (!containing || !OPERATOR_INITIATED_METHODS.has(containing)) {
      offenders.push(containing ?? "(unknown)");
    }
  }
  assert.deepEqual(offenders, [], `revealBrowserWindow in non-operator method(s): ${JSON.stringify(offenders)}`);
});

test("the LinkedIn send path does not reveal or foreground the window", () => {
  const source = stripComments(readFileSync(resolve(process.cwd(), ADAPTER_PATH), "utf8"));
  const start = source.search(/\basync sendMessage\s*\(/);
  assert.notEqual(start, -1, "sendMessage found");
  const end = source.indexOf("\n  }\n", start);
  const body = source.slice(start, end === -1 ? undefined : end);
  assert.doesNotMatch(body, /\brevealBrowserWindow\s*\(/, "sendMessage must not reveal the window");
  assert.doesNotMatch(body, /\bbringToFront\s*\(/, "sendMessage must not bringToFront");
  assert.doesNotMatch(body, /markVisibleLaunch/, "sendMessage must not request a visible launch");
});

test("only the operator connect / open-browser endpoints request a visible launch", () => {
  const source = stripComments(readFileSync(resolve(process.cwd(), INDEX_PATH), "utf8"));
  const marks = [...source.matchAll(/markVisibleLaunch\s*\(/g)];
  // Exactly the two operator endpoints (connect, open-browser) opt in.
  assert.equal(marks.length, 2, `expected 2 markVisibleLaunch call sites, found ${marks.length}`);
  // Each must sit near an ensureConnected call (the operator login path).
  for (const m of marks) {
    const window = source.slice(m.index, m.index + 400);
    assert.match(window, /ensureConnected\s*\(/, "markVisibleLaunch wraps an ensureConnected call");
  }
});

test("session manager hides launches by default (off-screen args + minimize)", () => {
  const source = stripComments(readFileSync(resolve(process.cwd(), SESSION_MANAGER_PATH), "utf8"));
  // The hide decision defaults on, gated only by visible-intent / kill-switch /
  // headless.
  assert.match(source, /hideLaunch\s*=/, "computes a hideLaunch decision");
  assert.match(source, /isVisibleBrowserLaunchForced\(\)/, "honours the kill-switch");
  assert.match(source, /visibleLaunchRefcount/, "honours operator visible-intent");
  assert.match(source, /hideBrowserWindow\(/, "hides the window after a background launch");
  assert.match(source, /backgroundWindowLaunchArgs\(\)/, "passes off-screen launch args");
});
