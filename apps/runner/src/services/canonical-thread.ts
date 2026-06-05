// Canonical sibling-thread selection.
//
// iMessage splits ONE human across handle-specific chats: a contact who
// messages from both a phone number and an Apple ID email shows up as two
// `threads` rows pointing at the same Person. The thread view and the
// re-summarisation pipeline already MERGE messages across these siblings, but
// the AI analysis (reply brief, predraft, summary, what-they-want, open loops,
// remember, category) is persisted per-row. New inbound lands on whichever
// handle-chat the contact used last, and the scan refreshes THAT row's brief —
// so the freshest AI state lives on the most-recently-active sibling, which is
// NOT necessarily the row with the most messages (a long-running phone thread
// can dwarf a freshly-active email thread).
//
// Reading AI fields off an arbitrary sibling therefore surfaces a stale brief
// and a stale predraft (the bug this module fixes: a thread whose live
// messages had moved on, but whose rail still showed a days-old brief and a
// suggested reply answering the old state). The canonical sibling — the one
// the readers and the reassess writer must agree on — is defined here:
//
//   1. most recent `lastInboundAt`  (where the live conversation actually is)
//   2. tie-break: highest message count
//   3. tie-break: lexicographically-greatest id (deterministic)
//
// Pure and dependency-free so it can be unit-tested and shared by the thread
// endpoint, the reassess pipeline, and (mirrored) the inbox row shaper.

export interface CanonicalCandidate {
  id: string;
  lastInboundAt: Date | null;
  messageCount: number;
}

/**
 * True when `a` is the more canonical AI-analysis row than `b` under the
 * most-recent-inbound → most-messages → id ordering described above.
 */
export function isMoreCanonical(a: CanonicalCandidate, b: CanonicalCandidate): boolean {
  const aInbound = a.lastInboundAt?.getTime() ?? 0;
  const bInbound = b.lastInboundAt?.getTime() ?? 0;
  if (aInbound !== bInbound) return aInbound > bInbound;
  if (a.messageCount !== b.messageCount) return a.messageCount > b.messageCount;
  return a.id > b.id;
}

/**
 * Pick the canonical AI-analysis row from a set of sibling threads. Returns
 * null only for an empty input (callers fall back to the requested row).
 */
export function pickCanonicalThread<T extends CanonicalCandidate>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!best || isMoreCanonical(row, best)) {
      best = row;
    }
  }
  return best;
}
