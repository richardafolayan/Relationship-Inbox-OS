import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Presenter-guard wiring for two mutation endpoints that previously had
// NO runner-side guard:
//
//   1. POST /control/threads/mark-all-for-reassess — wipes the cached AI
//      brief + predraft on every active thread. It IS a /control/ path so
//      the dashboard interceptor catches it on a tab that loaded the
//      interceptor, but a fresh/recovered tab (localStorage gone) skips
//      the interceptor and the request hits the runner directly. With no
//      threadId it must be gated as a thread-mutation (presenter-readonly
//      live, demo-mode-foreign-thread in sandbox).
//
//   2. POST /system/update — NOT a /control/ path, so the dashboard's
//      default-deny interceptor (shouldInterceptLive only matches
//      /control/) never sees it even when installed. Reachable from the
//      Settings update button during a live read-only demo.
//      Gated as an external-action.
//
// These pin the call-site at the source level, mirroring the established
// pattern in runner-presenter-readonly / runner-reassess-race-scope: the
// guard helper itself is unit-tested elsewhere, and a behavioural test of
// the route would require booting Express + Prisma + the settings store.
//
// If either route is removed or its guard dropped, these fail loudly.

function readSource(relativePath) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

const indexTs = readSource("apps/runner/src/index.ts");

test("mark-all-for-reassess route guards as a threadId-less thread-mutation", () => {
  // Isolate the handler body so the guard assertion can't pass against a
  // different route's guard. The block runs from the route registration
  // through its closing `);`.
  const routeMatch = indexTs.match(
    /app\.post\(\s*"\/control\/threads\/mark-all-for-reassess"[\s\S]*?\n\);/
  );
  assert.ok(routeMatch, "/control/threads/mark-all-for-reassess route not found");
  const routeBody = routeMatch[0];

  assert.match(
    routeBody,
    /checkPresenterGuard\(/,
    "mark-all-for-reassess must call checkPresenterGuard before mutating"
  );
  // No single threadId — it must be a thread-mutation so sandbox rejects
  // it as a foreign thread (it would touch real, non-seeded threads) and
  // live read-only rejects it outright.
  assert.match(
    routeBody,
    /kind:\s*"thread-mutation"/,
    "mark-all guard must use kind: 'thread-mutation' so it is blocked in live + sandbox"
  );
  // Must NOT smuggle a threadId into the guard — there is no single
  // target, and passing one would wrongly let it through in sandbox if
  // that id happened to be in the demo manifest.
  assert.doesNotMatch(
    routeBody,
    /checkPresenterGuard\([^)]*threadId/,
    "mark-all guard must not pass a threadId (there is no single target)"
  );
  // The guard must short-circuit (early return) before the mutation runs.
  assert.match(
    routeBody,
    /if\s*\(await checkPresenterGuard\([\s\S]*?\)\)\s*return;/,
    "mark-all guard must early-return so markAllThreadsForReassess never runs when blocked"
  );
});

test("/system/update guards as an external-action before staging", () => {
  const routeMatch = indexTs.match(
    /app\.post\(\s*"\/system\/update"[\s\S]*?\}\)\);/
  );
  assert.ok(routeMatch, "/system/update route not found");
  const routeBody = routeMatch[0];

  assert.match(
    routeBody,
    /checkPresenterGuard\(/,
    "/system/update must call checkPresenterGuard before staging an update"
  );
  assert.match(
    routeBody,
    /kind:\s*"external-action"/,
    "/system/update guard must use kind: 'external-action'"
  );
  // The guard must fire before the shared manual/automatic update path is reached.
  const guardIdx = routeBody.indexOf("checkPresenterGuard");
  const startIdx = routeBody.indexOf("startAvailableUpdate");
  assert.ok(startIdx > -1, "expected startAvailableUpdate in the /system/update handler");
  assert.ok(
    guardIdx > -1 && guardIdx < startIdx,
    "checkPresenterGuard must run before startAvailableUpdate so a blocked demo never stages an update"
  );
  const sharedUpdatePath = indexTs.match(
    /async function checkAndStartAvailableUpdate[\s\S]*?\n\}/
  );
  assert.ok(sharedUpdatePath, "shared update path not found");
  assert.match(sharedUpdatePath[0], /stagePendingUpdate\(/);
});
