import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePermissionResetGuard } from "../apps/runner/dist/scripts/imessage-permission-reset.js";

// `tccutil reset AppleEvents` clears EVERY Apple-Events / Automation grant
// on the machine and is irreversible, so the script must fail-closed: it
// only runs under an explicit --confirm. These tests pin the guard.

test("without --confirm the reset is refused, fail-closed (exit 2)", () => {
  const guard = evaluatePermissionResetGuard([]);

  assert.equal(guard.confirmed, false);
  assert.equal(guard.exitCode, 2);
  assert.ok(Array.isArray(guard.warning) && guard.warning.length > 0);

  const text = guard.warning.join("\n");
  // Operator must be told it is machine-wide and irreversible...
  assert.match(text, /ALL/);
  assert.match(text, /irreversible/i);
  // ...and shown the exact command that would run...
  assert.match(text, /tccutil reset AppleEvents/);
  // ...and how to proceed deliberately.
  assert.match(text, /--confirm/);
});

test("unrelated flags still do not count as confirmation", () => {
  const guard = evaluatePermissionResetGuard(["--dry-run", "--verbose"]);

  assert.equal(guard.confirmed, false);
  assert.equal(guard.exitCode, 2);
});

test("--confirm authorises the reset", () => {
  const guard = evaluatePermissionResetGuard(["--confirm"]);

  assert.equal(guard.confirmed, true);
  assert.equal(guard.exitCode, 0);
  assert.deepEqual(guard.warning, []);
});

test("--confirm alongside other args still authorises (matches the npm script)", () => {
  const guard = evaluatePermissionResetGuard(["--verbose", "--confirm"]);

  assert.equal(guard.confirmed, true);
  assert.equal(guard.exitCode, 0);
});
