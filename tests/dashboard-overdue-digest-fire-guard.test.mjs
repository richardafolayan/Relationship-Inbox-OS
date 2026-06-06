import test from "node:test";
import assert from "node:assert/strict";

// Pure dashboard-lib helpers for the overdue-digest fire/ack transaction
// guard (#P4L3). Imported directly via tsx; no React / Notification / runner
// build needed.
const {
  digestFireFingerprint,
  planDigestFire,
  classifyDigestAckError,
  nextDigestFireGuard,
  EMPTY_DIGEST_FIRE_GUARD
} = await import("../apps/dashboard/lib/overdue-digest.ts");

const candidate = (personId, stateKey, riskLevel = "RED") => ({
  personId,
  personName: personId.toUpperCase(),
  threadId: `t-${personId}`,
  riskLevel,
  lastInboundAt: null,
  stateKey
});

test("fingerprint is stable for the same lastDigestAt + candidate set", () => {
  const cands = [candidate("p-1", "k1"), candidate("p-2", "k2")];
  const a = digestFireFingerprint("2026-06-06T09:00:00.000Z", cands);
  const b = digestFireFingerprint("2026-06-06T09:00:00.000Z", [
    candidate("p-1", "k1"),
    candidate("p-2", "k2")
  ]);
  assert.equal(a, b);
});

test("fingerprint changes when lastDigestAt advances", () => {
  const cands = [candidate("p-1", "k1")];
  const before = digestFireFingerprint("2026-06-06T09:00:00.000Z", cands);
  const after = digestFireFingerprint("2026-06-06T09:05:00.000Z", cands);
  assert.notEqual(before, after);
});

test("fingerprint changes when the candidate set changes", () => {
  const last = "2026-06-06T09:00:00.000Z";
  const one = digestFireFingerprint(last, [candidate("p-1", "k1")]);
  const two = digestFireFingerprint(last, [candidate("p-1", "k1"), candidate("p-2", "k2")]);
  const sameSize = digestFireFingerprint(last, [candidate("p-1", "k1b")]);
  assert.notEqual(one, two);
  assert.notEqual(one, sameSize);
});

test("fingerprint dedupes by personId (mirrors the ack summary)", () => {
  const last = "2026-06-06T09:00:00.000Z";
  const deduped = digestFireFingerprint(last, [candidate("p-1", "k1")]);
  const withDup = digestFireFingerprint(last, [
    candidate("p-1", "k1"),
    candidate("p-1", "k1-other", "AMBER")
  ]);
  assert.equal(deduped, withDup);
});

test("a null lastDigestAt still yields a usable fingerprint", () => {
  const fp = digestFireFingerprint(null, [candidate("p-1", "k1")]);
  assert.equal(typeof fp, "string");
  assert.notEqual(fp, digestFireFingerprint("2026-06-06T09:00:00.000Z", [candidate("p-1", "k1")]));
});

test("planDigestFire fires on first sight, ack-only while the same ack is owed", () => {
  const fp = digestFireFingerprint("2026-06-06T09:00:00.000Z", [candidate("p-1", "k1")]);
  assert.equal(planDigestFire(fp, EMPTY_DIGEST_FIRE_GUARD), "fire-then-ack");
  assert.equal(planDigestFire(fp, { pendingFingerprint: fp }), "ack-only");
  // A different pending fingerprint must not suppress a new digest.
  assert.equal(planDigestFire(fp, { pendingFingerprint: "something-else" }), "fire-then-ack");
});

test("classifyDigestAckError: 409 is cadence_off, everything else transient", () => {
  assert.equal(classifyDigestAckError({ status: 409, name: "ApiRequestError" }), "cadence_off");
  assert.equal(classifyDigestAckError({ status: 500 }), "transient");
  assert.equal(classifyDigestAckError(new TypeError("Failed to fetch")), "transient");
  assert.equal(classifyDigestAckError(undefined), "transient");
  assert.equal(classifyDigestAckError(null), "transient");
  assert.equal(classifyDigestAckError("boom"), "transient");
});

test("nextDigestFireGuard arms only on a transient failure", () => {
  const fp = "fp-1";
  assert.deepEqual(nextDigestFireGuard(fp, "ok"), { pendingFingerprint: null });
  assert.deepEqual(nextDigestFireGuard(fp, "cadence_off"), { pendingFingerprint: null });
  assert.deepEqual(nextDigestFireGuard(fp, "transient"), { pendingFingerprint: fp });
});

test("full transition: transient ack failure suppresses a re-fire, success re-enables", () => {
  // Poll 1: fresh guard, fire, ack fails transiently -> guard armed.
  let guard = EMPTY_DIGEST_FIRE_GUARD;
  const last = "2026-06-06T09:00:00.000Z";
  const cands = [candidate("p-1", "k1"), candidate("p-2", "k2")];
  const fp1 = digestFireFingerprint(last, cands);
  assert.equal(planDigestFire(fp1, guard), "fire-then-ack");
  guard = { pendingFingerprint: fp1 }; // armed before await
  guard = nextDigestFireGuard(fp1, classifyDigestAckError({ status: 503 }));
  assert.deepEqual(guard, { pendingFingerprint: fp1 });

  // Poll 2: lastDigestAt has NOT advanced (ack never landed); same fingerprint.
  // Must NOT re-fire, only retry the ack. This time the ack succeeds.
  const fp2 = digestFireFingerprint(last, cands);
  assert.equal(fp2, fp1);
  assert.equal(planDigestFire(fp2, guard), "ack-only");
  guard = nextDigestFireGuard(fp2, "ok");
  assert.deepEqual(guard, { pendingFingerprint: null });

  // Poll 3: ack advanced lastDigestAt -> new fingerprint -> fires again.
  const fp3 = digestFireFingerprint("2026-06-06T09:05:00.000Z", cands);
  assert.notEqual(fp3, fp1);
  assert.equal(planDigestFire(fp3, guard), "fire-then-ack");
});

test("409 cadence_off clears the guard (no retry this window)", () => {
  const fp = digestFireFingerprint("2026-06-06T09:00:00.000Z", [candidate("p-1", "k1")]);
  let guard = { pendingFingerprint: fp };
  guard = nextDigestFireGuard(fp, classifyDigestAckError({ status: 409 }));
  assert.deepEqual(guard, { pendingFingerprint: null });
});
