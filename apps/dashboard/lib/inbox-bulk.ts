// Inbox bulk-action semantics (BUG H2).
//
// The Inbox bulk-action bar runs every selected action through runBulk, which
// optimistically hides the selected rows by adding their ids to `removedIds`.
// applyInbox then self-heals that set: on the next payload it keeps an id only
// if the row is gone OR its needsReply flipped to false. That self-heal works
// for membership-changing actions (mark-done clears needsReply,
// snooze flips needsReply), but Rescan only re-parses messages and changes
// neither — so optimistically removing a still-needs-reply thread would strand
// it in `removedIds` until a full page reload.
//
// This helper is the single source of truth for which bulk actions change a
// thread's inbox membership. runBulk consults it to decide whether to do the
// optimistic removal at all.

/**
 * Whether a bulk action removes its rows from the active inbox (so the rows
 * should be hidden optimistically), as opposed to merely refreshing them in
 * place. Keyed on the action label passed to runBulk.
 *
 * Membership-changing labels: "Mark done", "Snooze 16h".
 * In-place refresh labels (e.g. "Rescan"): everything else.
 *
 * Defaulting unknown labels to false is the safe choice: a non-membership
 * action that is mistakenly treated as removing would strand its rows, whereas
 * a membership action mistakenly treated as in-place merely loses the
 * optimistic flourish until the next refresh.
 */
export function bulkActionRemovesRow(label: string): boolean {
  return label === "Mark done" || label === "Snooze 16h";
}
