import test from "node:test";
import assert from "node:assert/strict";
import { decidePersonNameAction } from "../apps/runner/dist/services/person-name-action.js";

// POST /control/person/:id/rename backs the "Maybe <name>" pill. The operator
// reported the pill working (a refresh showed the confirmed name) yet throwing
// a "no inferred name to confirm" error: a duplicate/stale confirm (a fast
// double-click, or a re-click when nothing visibly happened) hit the endpoint
// after the first confirm had already cleared `inferredName`, and the old
// handler answered 409 — which surfaced on Next.js's dev error overlay.
//
// The fix makes "confirm" idempotent. These tests pin that, plus the
// rename/dismiss paths, against the extracted pure decision.

test("confirm with an inferredName promotes it and locks the name", () => {
  const d = decidePersonNameAction(
    { inferredName: "Niyi", displayName: "+44 7700 900000" },
    { action: "confirm" }
  );
  assert.equal(d.status, 200);
  assert.deepEqual(d.write, {
    displayName: "Niyi",
    displayNameSource: "manual",
    inferredName: null
  });
  assert.deepEqual(d.body, { status: "ok", displayName: "Niyi" });
});

test("confirm with no inferredName is an idempotent no-op, NOT a 409", () => {
  // The exact reported case: the first confirm already promoted "Niyi" and
  // cleared inferredName; the duplicate confirm finds it null.
  const d = decidePersonNameAction(
    { inferredName: null, displayName: "Niyi" },
    { action: "confirm" }
  );
  assert.equal(d.status, 200, "must not be 409 - the action already succeeded");
  assert.equal(d.write, null, "no DB write on a no-op");
  assert.deepEqual(
    d.body,
    { status: "ok", displayName: "Niyi" },
    "echoes the already-confirmed displayName so the client can reconcile"
  );
});

test("rename with a name sets it and locks the name", () => {
  const d = decidePersonNameAction(
    { inferredName: "Niyi", displayName: "+44 7700 900000" },
    { action: "rename", name: "Adeniyi" }
  );
  assert.equal(d.status, 200);
  assert.deepEqual(d.write, {
    displayName: "Adeniyi",
    displayNameSource: "manual",
    inferredName: null
  });
  assert.deepEqual(d.body, { status: "ok", displayName: "Adeniyi" });
});

test("rename without a name is a 400 with no write", () => {
  const d = decidePersonNameAction(
    { inferredName: "Niyi", displayName: "+44 7700 900000" },
    { action: "rename" }
  );
  assert.equal(d.status, 400);
  assert.equal(d.write, null);
  assert.deepEqual(d.body, { error: "name is required for rename" });
});

test("dismiss clears the suggestion and keeps displayName", () => {
  const d = decidePersonNameAction(
    { inferredName: "Niyi", displayName: "+44 7700 900000" },
    { action: "dismiss" }
  );
  assert.equal(d.status, 200);
  assert.deepEqual(d.write, { inferredName: null });
  assert.deepEqual(d.body, { status: "ok" }, "dismiss does not echo a displayName");
});
