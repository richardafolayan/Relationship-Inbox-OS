// Decision helper for syncing the People-page Internal-notes textarea against
// server-fetched person data. Background refreshes (the 10s poll and
// runner-resync events on /people) replace the `people` list, which re-derives
// the selected person and re-fires the notes-sync effect. Without a guard that
// effect overwrites the textarea with the (stale) server value, discarding
// whatever the user is typing.
//
// This is the pure, framework-free core so it can be unit-tested directly via
// the tsx loader (see tests/dashboard-notes-sync.test.mjs).

export interface AdoptIncomingNotesInput {
  /** The selected person changed since the draft was last synced. */
  personChanged: boolean;
  /** The draft has unsaved keystrokes (diverged from the last synced value). */
  draftIsDirty: boolean;
}

/**
 * Whether an incoming server notes value should overwrite the local draft.
 *
 * - Person changed: always adopt (the draft belongs to a different person).
 * - Same person, draft clean: adopt (a genuine background update, no edits to
 *   lose).
 * - Same person, draft dirty: do NOT adopt — the user is mid-edit and adopting
 *   would clobber their keystrokes. This is the bug this guard prevents.
 */
export function shouldAdoptIncomingNotes({
  personChanged,
  draftIsDirty
}: AdoptIncomingNotesInput): boolean {
  if (personChanged) return true;
  return !draftIsDirty;
}
