import test from "node:test";
import assert from "node:assert/strict";
import {
  planNameBackfill,
} from "../apps/runner/dist/scripts/backfill-imessage-names-plan.js";

// Fake resolver: maps a known handle to a real name, everything else -> null.
const resolver = (table) => ({
  resolve: (handle) => table[handle] ?? null,
});

test("planNameBackfill: rewrites a handle-shaped displayName to the resolved name", () => {
  const plan = planNameBackfill(
    [{ id: "p1", displayName: "+15551234567" }],
    [],
    resolver({ "+15551234567": "Marianne" })
  );
  assert.deepEqual(plan.personChanges, [{ id: "p1", from: "+15551234567", to: "Marianne" }]);
  assert.equal(plan.skippedPersons, 0);
  assert.equal(plan.unmatchedPersons, 0);
});

test("planNameBackfill: leaves a real-name displayName untouched (counts as skipped)", () => {
  const plan = planNameBackfill(
    [{ id: "p1", displayName: "Marianne Okafor" }],
    [],
    resolver({})
  );
  assert.equal(plan.personChanges.length, 0);
  assert.equal(plan.skippedPersons, 1);
});

test("planNameBackfill: handle with no matching contact is unmatched, not changed", () => {
  const plan = planNameBackfill(
    [{ id: "p1", displayName: "+15559999999" }],
    [],
    resolver({ "+15551234567": "Marianne" })
  );
  assert.equal(plan.personChanges.length, 0);
  assert.equal(plan.unmatchedPersons, 1);
});

test("planNameBackfill: rewrites handle-shaped Message.senderName too", () => {
  const plan = planNameBackfill(
    [],
    [
      { id: "m1", senderName: "+15551234567" },
      { id: "m2", senderName: "Already Named" },
      { id: "m3", senderName: null },
    ],
    resolver({ "+15551234567": "Marianne" })
  );
  assert.deepEqual(plan.messageChanges, [{ id: "m1", from: "+15551234567", to: "Marianne" }]);
  assert.equal(plan.skippedMessages, 1, "the real-name senderName is skipped");
  assert.equal(plan.unmatchedMessages, 1, "a null/blank senderName resolves to nothing -> unmatched");
});

test("planNameBackfill: the plan is pure — it never mutates and a dry run can print it", () => {
  // Regression guard for the data-loss bug: the planner only DESCRIBES changes;
  // it performs no writes, so the executable can show every old -> new before
  // --apply. A non-empty plan from bad input must still be inspectable, never
  // auto-applied.
  const persons = [{ id: "p1", displayName: "+15551234567" }];
  const plan = planNameBackfill(persons, [], resolver({ "+15551234567": "WRONG NAME" }));
  assert.equal(plan.personChanges.length, 1, "intended change is surfaced for preview");
  assert.equal(persons[0].displayName, "+15551234567", "input rows are not mutated by planning");
});
