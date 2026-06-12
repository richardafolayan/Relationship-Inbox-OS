import test from "node:test";
import assert from "node:assert/strict";

// notes-sync.ts is framework-free, so the tsx loader resolves this .ts import
// directly (same pattern as dashboard-horizon.test.mjs).
const { shouldAdoptIncomingNotes } = await import("../apps/dashboard/lib/notes-sync.ts");

// Guards the People-page Internal-notes textarea against background refreshes
// (10s poll / runner-resync) overwriting in-progress edits and losing
// keystrokes. Regression for M23.

test("adopts incoming notes when the selected person changes", () => {
  // Switching person must always load that person's notes, even if the prior
  // draft was dirty.
  assert.equal(
    shouldAdoptIncomingNotes({ personChanged: true, draftIsDirty: false }),
    true
  );
  assert.equal(
    shouldAdoptIncomingNotes({ personChanged: true, draftIsDirty: true }),
    true
  );
});

test("adopts a same-person background update when the draft is clean", () => {
  // No unsaved keystrokes -> a fresh server value should sync in.
  assert.equal(
    shouldAdoptIncomingNotes({ personChanged: false, draftIsDirty: false }),
    true
  );
});

test("does NOT clobber a dirty draft on a same-person background refresh", () => {
  // The bug: user is mid-edit (draft dirty) and a background loadList lands.
  // Adopting here would discard their keystrokes, so it must be refused.
  assert.equal(
    shouldAdoptIncomingNotes({ personChanged: false, draftIsDirty: true }),
    false
  );
});
