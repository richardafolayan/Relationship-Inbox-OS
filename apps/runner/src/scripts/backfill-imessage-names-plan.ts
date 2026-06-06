/**
 * Pure planning logic for the IMESSAGE name backfill script. No DB access and
 * no side effects, so it is unit-testable in isolation (see
 * tests/runner-backfill-imessage-names.test.mjs). The executable script
 * (backfill-imessage-names.ts) loads the rows, prints the plan, and — only with
 * --apply — performs the writes.
 *
 * Mirrors the dedupe-imessage-people split (plan + thin DB wrapper) so this
 * destructive rewrite is dry-run-by-default and every intended old -> new
 * change is previewable before anything is mutated.
 */
import { looksLikeUnresolvedHandle } from "../services/name-inference";

/** Minimal slice of ContactResolver the planner needs — keeps it DB/vcf-free. */
export interface HandleResolver {
  /** Returns the resolved real name for a chat.db handle, or null when none matches. */
  resolve(handle: string): string | null;
}

/** A row whose displayName label may be an unresolved handle. */
export interface BackfillPersonRow {
  id: string;
  displayName: string;
}

/** A row whose senderName label may be an unresolved handle. */
export interface BackfillMessageRow {
  id: string;
  senderName: string | null;
}

/** One intended overwrite: rewrite `from` (the stored label) to `to`. */
export interface PlannedNameChange {
  id: string;
  from: string;
  to: string;
}

export interface BackfillPlan {
  /** Person.displayName rewrites (inferredName is also cleared on apply). */
  personChanges: PlannedNameChange[];
  /** Message.senderName rewrites. */
  messageChanges: PlannedNameChange[];
  /** Rows whose label is already a real name — left untouched. */
  skippedPersons: number;
  skippedMessages: number;
  /** Rows that look like a handle but no contact matched — left untouched. */
  unmatchedPersons: number;
  unmatchedMessages: number;
}

/**
 * Pure planner: decide which IMESSAGE Person.displayName / Message.senderName
 * labels should be rewritten to a resolved contact name. Only rows that (a)
 * still look like a bare handle AND (b) resolve to a real name produce a
 * change; everything else is counted as skipped (already a name) or unmatched
 * (handle with no contact). The caller is responsible for loading the rows and
 * (only with --apply) executing the plan.
 */
export function planNameBackfill(
  persons: BackfillPersonRow[],
  messages: BackfillMessageRow[],
  resolver: HandleResolver
): BackfillPlan {
  const personChanges: PlannedNameChange[] = [];
  let skippedPersons = 0;
  let unmatchedPersons = 0;
  for (const person of persons) {
    if (!looksLikeUnresolvedHandle(person.displayName)) {
      skippedPersons += 1;
      continue;
    }
    const realName = resolver.resolve(person.displayName);
    if (!realName) {
      unmatchedPersons += 1;
      continue;
    }
    personChanges.push({ id: person.id, from: person.displayName, to: realName });
  }

  const messageChanges: PlannedNameChange[] = [];
  let skippedMessages = 0;
  let unmatchedMessages = 0;
  for (const message of messages) {
    const sender = message.senderName ?? "";
    if (!looksLikeUnresolvedHandle(sender)) {
      skippedMessages += 1;
      continue;
    }
    const realName = resolver.resolve(sender);
    if (!realName) {
      unmatchedMessages += 1;
      continue;
    }
    messageChanges.push({ id: message.id, from: sender, to: realName });
  }

  return {
    personChanges,
    messageChanges,
    skippedPersons,
    skippedMessages,
    unmatchedPersons,
    unmatchedMessages,
  };
}
