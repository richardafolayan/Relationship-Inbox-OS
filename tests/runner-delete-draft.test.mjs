import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Issue #486 / pilot R-0067: "I need to be able to delete a draft."
//
// Before this, the save route (POST .../draft) was an upsert with no
// inverse — once an operator saved a draft it reloaded into the composer
// on every visit with no way to remove it. These tests pin the new
// delete-draft seam at the source level (the runner app isn't exported
// for behavioural HTTP tests; the wiring is small enough that source is
// the source of truth, matching runner-reassess-race-scope.test.mjs).

function readSource(relativePath) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

test("runner exposes POST /control/thread/:threadId/delete-draft", () => {
  const indexTs = readSource("apps/runner/src/index.ts");
  const routeMatch = indexTs.match(
    /app\.post\(\s*"\/control\/thread\/:threadId\/delete-draft"[\s\S]*?\}\)\);/
  );
  assert.ok(routeMatch, "/control/thread/:threadId/delete-draft route not found");
  const routeBody = routeMatch[0];

  // Delete only the exact revision the operator saw. A newer cross-window
  // save must survive and the response tells the dashboard to refresh it.
  assert.match(
    routeBody,
    /z\.object\(\{\s*draft:\s*z\.object\(\{[\s\S]*?text:\s*z\.string\(\)\.max\(5000\)[\s\S]*?updatedAt:\s*z\.string\(\)\.datetime\(\)[\s\S]*?\}\)[\s\S]*?\}\)\.parse\(req\.body\)/,
    "delete-draft route must require the exact saved draft revision"
  );
  assert.match(
    routeBody,
    /deleteDraftRevision\(prisma,\s*threadId,\s*payload\.draft\)/,
    "delete-draft route must compare and delete through deleteDraftRevision"
  );
  assert.match(
    routeBody,
    /res\.json\(\{\s*status:\s*"ok",\s*deleted\s*\}\)/,
    "delete-draft route must report whether the exact revision was deleted"
  );

  // Same presenter guard as every other thread mutation, with its own verb.
  assert.match(
    routeBody,
    /checkPresenterGuard\([\s\S]*?action:\s*"delete a draft"[\s\S]*?kind:\s*"thread-mutation"/,
    "delete-draft route must be behind checkPresenterGuard with action 'delete a draft'"
  );
});

test("dashboard thread page wires a Delete draft button to the endpoint", () => {
  const pageTsx = readSource("apps/dashboard/app/thread/[id]/page.tsx");

  // POSTs to the new endpoint (template literal: path then closing backtick).
  assert.ok(
    pageTsx.includes("/delete-draft`"),
    "thread page must POST to the delete-draft endpoint"
  );
  // Gated on a persisted draft existing — never shown for an AI predraft
  // (its own local-only "Discard") or unsaved typing.
  assert.ok(
    pageTsx.includes("hasSavedDraft ?"),
    "Delete draft button must be gated on hasSavedDraft"
  );
  assert.ok(pageTsx.includes("Delete draft"), "Delete draft button label missing");
  // Inline running feedback (matches the app's notification-style split).
  assert.ok(pageTsx.includes("Deleting…"), "Delete draft button must show inline running state");
});

test("live-demo interceptor labels delete-draft distinctly from save", async () => {
  const { describeInterceptedAction, shouldInterceptLive } = await import(
    "../apps/dashboard/lib/full-demo-fetch.ts"
  );
  assert.equal(
    describeInterceptedAction("/runner/control/thread/abc/delete-draft"),
    "delete a draft"
  );
  // The /draft$ matcher must NOT swallow the delete-draft path.
  assert.equal(
    describeInterceptedAction("/runner/control/thread/abc/draft"),
    "save a draft"
  );
  // And it's intercepted as a mutation in live presenter mode.
  assert.equal(
    shouldInterceptLive("POST", "/runner/control/thread/abc/delete-draft"),
    true
  );
});
