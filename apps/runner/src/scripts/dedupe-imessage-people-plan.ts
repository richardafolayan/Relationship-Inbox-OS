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
 *
 * Classification is @-first, mirroring resolveName (contact-resolver.ts): a
 * handle containing "@" is ALWAYS treated as an email and never run through
 * normalizePhone. normalizePhone strips non-digits and keeps the trailing 10
 * with no shape guard, so without this an email whose local-part carries 7+
 * digits would key as a phone — collapsing two distinct digit-bearing emails
 * (or an email and a phone) that happen to share a 10-digit suffix onto one
 * key, which --apply would then reparent + irreversibly delete.
 */
export function personIdentityKey(handle: string | null): string | null {
  if (!handle) return null;
  const trimmed = handle.trim();
  if (!trimmed) return null;
  if (trimmed.includes("@")) {
    return normalizeEmail(trimmed) ?? trimmed.toLowerCase();
  }
  return normalizePhone(trimmed) ?? trimmed.toLowerCase();
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

/** Default cap on how many Person rows one --apply run may delete before it
 *  must be re-confirmed with --force. A correctly-keyed dedupe touches a
 *  handful of rows; a plan that wants to delete more than this is the
 *  signature of a keying mistake, so we fail closed rather than delete wide. */
export const DEFAULT_MAX_DELETIONS = 25;

export interface DeletionSafetyOptions {
  /** True only when the caller passed --apply (writes are about to happen). */
  apply: boolean;
  /** True only when the caller passed --force (override the deletion cap). */
  force: boolean;
  /** Override the deletion cap (tests / explicit operator choice). */
  maxDeletions?: number;
}

export interface DeletionSafetyVerdict {
  /** Whether the destructive apply loop may proceed. */
  ok: boolean;
  /** How many Person rows the plan would delete. */
  deletions: number;
  /** The cap that was applied. */
  cap: number;
  /** Operator-facing reason when ok is false (empty when ok). */
  reason: string;
}

/**
 * Fail-closed gate for the destructive apply path. Pure: no DB, no I/O. Dry
 * runs are always allowed (they write nothing). An --apply run is blocked when
 * it would delete more Person rows than the cap, unless --force is also set —
 * so a wide/ambiguous delete (the symptom of a keying bug) cannot run silently.
 */
export function assessDeletionSafety(
  plan: DedupePlan,
  opts: DeletionSafetyOptions
): DeletionSafetyVerdict {
  const deletions = plan.merges.reduce((n, m) => n + m.duplicateIds.length, 0);
  const cap = opts.maxDeletions ?? DEFAULT_MAX_DELETIONS;
  if (!opts.apply) {
    return { ok: true, deletions, cap, reason: "" };
  }
  if (deletions > cap && !opts.force) {
    return {
      ok: false,
      deletions,
      cap,
      reason:
        `refusing to delete ${deletions} Person rows in one run (cap ${cap}). ` +
        `This wide a delete usually means handles are mis-keyed. ` +
        `Re-run with --force if this is genuinely intended.`,
    };
  }
  return { ok: true, deletions, cap, reason: "" };
}

/** Divider that precedes every appended duplicate note. Used both to build the
 *  merged block and to detect a genuine re-run (so we don't drop a note merely
 *  because it happens to be a substring of the canonical's existing text). */
const MERGED_NOTES_DIVIDER = "\n\n--- merged from duplicate ---\n";

/**
 * Merge a duplicate's notes onto the canonical's without ever dropping content.
 * Empty canonical → copy; both present → append under a divider. The ONLY
 * no-op (so re-runs don't keep appending) is a genuine re-run: the incoming
 * note IS the whole canonical, or it has already been appended as its own
 * '--- merged from duplicate ---' block. A note that is merely a coincidental
 * substring of a larger note is still appended — distinct operator-authored
 * notes are never silently lost.
 */
export function mergeNotes(canonicalNotes: string | null, dupNotes: string | null): string | null {
  const existing = (canonicalNotes ?? "").trim();
  const incoming = (dupNotes ?? "").trim();
  if (!incoming) return canonicalNotes ?? null;
  if (!existing) return dupNotes;
  const alreadyMerged =
    existing === incoming || existing.includes(`${MERGED_NOTES_DIVIDER}${incoming}`);
  if (alreadyMerged) return canonicalNotes ?? null;
  return `${canonicalNotes}${MERGED_NOTES_DIVIDER}${incoming}`;
}
