import test from "node:test";
import assert from "node:assert/strict";
import {
  personIdentityKey,
  planPersonDedupe,
  mergeNotes,
} from "../apps/runner/dist/scripts/dedupe-imessage-people-plan.js";

const row = (over) => ({
  id: "x",
  handle: null,
  displayName: "Someone",
  createdAt: new Date("2024-01-01T00:00:00Z"),
  notes: null,
  ...over,
});

test("personIdentityKey: same human in different phone formats collapses to one key", () => {
  assert.equal(personIdentityKey("+44 7700 900123"), personIdentityKey("07700900123"));
  assert.equal(personIdentityKey("447700900123"), personIdentityKey("+447700900123"));
  assert.equal(personIdentityKey("Foo@Bar.COM"), "foo@bar.com");
});

test("personIdentityKey: no usable handle returns null (so the row is never merged)", () => {
  assert.equal(personIdentityKey(null), null);
  assert.equal(personIdentityKey(""), null);
  assert.equal(personIdentityKey("   "), null);
});

test("planPersonDedupe: merges same-handle rows even when the displayName drifted", () => {
  const rows = [
    row({ id: "a", handle: "+447700900123", displayName: "Unknown", createdAt: new Date("2024-01-01") }),
    row({ id: "b", handle: "07700 900123", displayName: "Marianne", createdAt: new Date("2024-02-01") }),
  ];
  const plan = planPersonDedupe(rows);
  assert.equal(plan.merges.length, 1);
  assert.equal(plan.merges[0].canonicalId, "a", "earliest createdAt is canonical");
  assert.deepEqual(plan.merges[0].duplicateIds, ["b"]);
});

test("planPersonDedupe: does NOT merge different people who share a label (the CRITICAL bug)", () => {
  const rows = [
    row({ id: "a", handle: "+15550001111", displayName: "John Smith", createdAt: new Date("2024-01-01") }),
    row({ id: "b", handle: "+15550002222", displayName: "John Smith", createdAt: new Date("2024-02-01") }),
  ];
  const plan = planPersonDedupe(rows);
  assert.equal(plan.merges.length, 0, "distinct handles must never merge on the label alone");
});

test("planPersonDedupe: rows with no handle are skipped, not merged", () => {
  const rows = [
    row({ id: "a", handle: null, displayName: "Group chat" }),
    row({ id: "b", handle: "   ", displayName: "Group chat" }),
  ];
  const plan = planPersonDedupe(rows);
  assert.equal(plan.merges.length, 0);
  assert.equal(plan.skippedNoHandle, 2);
});

test("planPersonDedupe: flags duplicates that carry notes so they are preserved", () => {
  const rows = [
    row({ id: "a", handle: "+15551234567", createdAt: new Date("2024-01-01"), notes: "canonical" }),
    row({ id: "b", handle: "15551234567", createdAt: new Date("2024-02-01"), notes: "dup note" }),
  ];
  const plan = planPersonDedupe(rows);
  assert.equal(plan.merges.length, 1);
  assert.deepEqual(plan.merges[0].duplicatesWithNotes, ["b"]);
});

test("mergeNotes: never drops the duplicate's notes", () => {
  assert.equal(mergeNotes(null, "dup note"), "dup note", "copy into an empty canonical");
  assert.equal(mergeNotes("keep me", null), "keep me", "nothing to add");
  const both = mergeNotes("canonical note", "dup note");
  assert.match(both, /canonical note/);
  assert.match(both, /dup note/, "both notes retained when both are present");
  assert.equal(mergeNotes("same", "same"), "same", "no re-append when already contained");
});

test("mergeNotes: appends a note that is only a COINCIDENTAL substring of the canonical (P3-PL12)", () => {
  // "follow up" is a substring of the canonical but a DISTINCT operator-authored
  // note on the duplicate. The old `existing.includes(incoming)` no-op'd here and
  // the dup Person row was then irreversibly deleted, silently losing the note.
  // It must now be appended under the divider; the canonical text is preserved.
  const merged = mergeNotes("Met at the conference, follow up re funding", "follow up");
  assert.match(merged, /Met at the conference, follow up re funding/, "keeps the canonical note");
  assert.match(merged, /--- merged from duplicate ---\nfollow up$/, "appends the distinct dup note");
  // A genuine re-run (the note already present as its own merged block) stays a no-op.
  const alreadyMerged = "canon note\n\n--- merged from duplicate ---\nfollow up";
  assert.equal(
    mergeNotes(alreadyMerged, "follow up"),
    alreadyMerged,
    "no double-append when the note is already a merged block"
  );
});
