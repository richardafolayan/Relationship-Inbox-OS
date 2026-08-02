import test from "node:test";
import assert from "node:assert/strict";
import {
  personIdentityKey,
  planPersonDedupe,
  assessDeletionSafety,
  DEFAULT_MAX_DELETIONS,
} from "../apps/runner/dist/scripts/dedupe-imessage-people-plan.js";

const row = (over) => ({
  id: "x",
  handle: null,
  displayName: "Someone",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  notes: null,
  ...over,
});

// --- Regression for BUG H5: digit-rich email handles must NOT key as phones ---

test("personIdentityKey: two DISTINCT digit-bearing emails get DISTINCT keys", () => {
  // Before the fix both keyed as the phone "1234567890" (the trailing 10 digits
  // of the local-part) and would be merged + one Person irreversibly deleted.
  const a = personIdentityKey("contact01234567890@alpha.com");
  const b = personIdentityKey("user01234567890@beta.org");
  assert.notEqual(a, b, "different emails must never share a key");
  assert.equal(a, "contact01234567890@alpha.com");
  assert.equal(b, "user01234567890@beta.org");
});

test("personIdentityKey: an email handle keys to its lowercased self, not a 10-digit phone", () => {
  const key = personIdentityKey("User01234567890@Example.COM");
  assert.equal(key, "user01234567890@example.com");
  assert.notEqual(key, "1234567890", "must not collapse to the trailing 10 digits");
});

test("personIdentityKey: a digit-bearing email and a phone sharing a 10-digit suffix do NOT collide", () => {
  const emailKey = personIdentityKey("team1234567890@corp.com");
  const phoneKey = personIdentityKey("+44 1234 567890");
  assert.notEqual(emailKey, phoneKey, "email and phone must classify into different keyspaces");
  assert.equal(phoneKey, "+441234567890");
});

test("personIdentityKey: real phones still collapse across formats (no regression)", () => {
  assert.equal(personIdentityKey("+44 7700 900123"), personIdentityKey("07700900123"));
  assert.equal(personIdentityKey("447700900123"), personIdentityKey("+447700900123"));
});

test("planPersonDedupe: two distinct digit-bearing emails are NOT merged", () => {
  const rows = [
    row({ id: "a", handle: "contact01234567890@alpha.com", createdAt: new Date("2024-01-01") }),
    row({ id: "b", handle: "user01234567890@beta.org", createdAt: new Date("2024-02-01") }),
  ];
  const plan = planPersonDedupe(rows);
  assert.equal(plan.merges.length, 0, "distinct digit-bearing emails must never merge");
});

test("planPersonDedupe: the SAME email in different cases still merges (no regression)", () => {
  const rows = [
    row({ id: "a", handle: "Person99@Mail.com", createdAt: new Date("2024-01-01") }),
    row({ id: "b", handle: "person99@mail.com", createdAt: new Date("2024-02-01") }),
  ];
  const plan = planPersonDedupe(rows);
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].canonicalId, "a");
  assert.deepEqual(plan.merges[0].duplicateIds, ["b"]);
});

// --- Fail-closed deletion guard ---

function planWithDeletions(count) {
  return {
    merges: [
      {
        key: "k",
        canonicalId: "c",
        canonicalName: "Canonical",
        duplicateIds: Array.from({ length: count }, (_, i) => `d${i}`),
        duplicatesWithNotes: [],
      },
    ],
    groupsConsidered: 1,
    skippedNoHandle: 0,
  };
}

test("assessDeletionSafety: dry run is always allowed and writes nothing", () => {
  const verdict = assessDeletionSafety(planWithDeletions(9999), { apply: false, force: false });
  assert.equal(verdict.ok, true);
});

test("assessDeletionSafety: a small --apply run is allowed", () => {
  const verdict = assessDeletionSafety(planWithDeletions(3), { apply: true, force: false });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.deletions, 3);
});

test("assessDeletionSafety: a wide --apply run is BLOCKED without --force", () => {
  const over = DEFAULT_MAX_DELETIONS + 1;
  const verdict = assessDeletionSafety(planWithDeletions(over), { apply: true, force: false });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.deletions, over);
  assert.match(verdict.reason, /refusing to delete/);
});

test("assessDeletionSafety: --force overrides the wide-delete cap", () => {
  const over = DEFAULT_MAX_DELETIONS + 50;
  const verdict = assessDeletionSafety(planWithDeletions(over), { apply: true, force: true });
  assert.equal(verdict.ok, true);
});

test("assessDeletionSafety: a custom cap is honoured", () => {
  const verdict = assessDeletionSafety(planWithDeletions(2), {
    apply: true,
    force: false,
    maxDeletions: 1,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.cap, 1);
});
