/**
 * Pure planning logic for the IMESSAGE Person dedupe script. No DB access and
 * no side effects, so it is unit-testable in isolation (see
 * tests/runner-dedupe-imessage-people.test.mjs). The executable script
 * (dedupe-imessage-people.ts) loads the rows, prints the plan, and — only with
 * --apply — performs the writes.
 */
import { normalizeEmail, normalizePhone } from "../services/contact-resolver";

export interface DedupePersonRow {
  id: string;
  handle: string | null;
  displayName: string;
  createdAt: Date;
  notes: string | null;
}

export interface PlannedMerge {
  key: string;
  canonicalId: string;
  canonicalName: string;
  duplicateIds: string[];
  /** Duplicate ids that carry notes — surfaced so the dry run can show they survive. */
  duplicatesWithNotes: string[];
}

export interface DedupePlan {
  merges: PlannedMerge[];
  groupsConsidered: number;
  skippedNoHandle: number;
}

/**
 * Stable identity for a Person row. Phone handles collapse to their trailing
 * 10 digits and emails are lowercased (so "+44 7…", "07…" and "447…" for one
 * number agree); anything else (e.g. a group-chat id) falls back to the
 * trimmed, lowercased raw handle — still the *handle*, never the displayName.
 * Returns null when there is no usable handle, which excludes the row from any
 * merge.
 */
export function personIdentityKey(handle: string | null): string | null {
  if (!handle) return null;
  const trimmed = handle.trim();
  if (!trimmed) return null;
  return normalizePhone(trimmed) ?? normalizeEmail(trimmed) ?? trimmed.toLowerCase();
}

/**
 * Pure planner: decide which IMESSAGE Person rows to merge. The caller is
 * responsible for loading the rows and (only with --apply) executing the plan.
 */
export function planPersonDedupe(rows: DedupePersonRow[]): DedupePlan {
  const groups = new Map<string, DedupePersonRow[]>();
  let skippedNoHandle = 0;
  for (const row of rows) {
    const key = personIdentityKey(row.handle);
    if (!key) {
      skippedNoHandle += 1;
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const merges: PlannedMerge[] = [];
  for (const [key, membersRaw] of groups) {
    if (membersRaw.length < 2) continue;
    // Earliest createdAt is canonical; stable tiebreak on id.
    const members = [...membersRaw].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)
    );
    const [canonical, ...duplicates] = members;
    if (!canonical) continue;
    merges.push({
      key,
      canonicalId: canonical.id,
      canonicalName: canonical.displayName,
      duplicateIds: duplicates.map((d) => d.id),
      duplicatesWithNotes: duplicates.filter((d) => d.notes && d.notes.trim()).map((d) => d.id),
    });
  }
  return { merges, groupsConsidered: groups.size, skippedNoHandle };
}

/**
 * Merge a duplicate's notes onto the canonical's without ever dropping content.
 * Empty canonical → copy; both present → concatenate with a divider; duplicate
 * already contained → no-op (so re-runs don't keep appending).
 */
export function mergeNotes(canonicalNotes: string | null, dupNotes: string | null): string | null {
  const existing = (canonicalNotes ?? "").trim();
  const incoming = (dupNotes ?? "").trim();
  if (!incoming) return canonicalNotes ?? null;
  if (!existing) return dupNotes;
  if (existing.includes(incoming)) return canonicalNotes ?? null;
  return `${canonicalNotes}\n\n--- merged from duplicate ---\n${dupNotes}`;
}
