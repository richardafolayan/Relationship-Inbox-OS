/**
 * Merge IMESSAGE Person rows that are the SAME conversation target into the
 * earliest row.
 *
 * Identity is the chat.db *handle* (a phone number / email / chat id), NOT the
 * displayName label. Grouping on the label was unsafe: iMessage displayNames
 * are non-unique — 1:1 chats fall back to the raw chatIdentifier, group chats
 * comma-join their participants, and the "Maybe …" inferred-name heuristic can
 * land two different people on the same guess — so a label-only merge could
 * fold two genuinely different people into one row and irreversibly delete the
 * other, with no preview. (See code-audit.md, CRITICAL.)
 *
 * Safety guarantees:
 *   - Rows with no usable handle are never merged (we cannot prove identity).
 *   - DRY RUN by default: prints the full plan and writes nothing. Pass
 *     `--apply` to perform the merge.
 *   - Notes are never dropped: when both rows carry notes they are concatenated.
 *   - Each duplicate merge runs in a transaction, so a failure can't leave a
 *     duplicate's threads re-parented while the row itself survives.
 *
 * Canonical rule: keep the Person with the earliest createdAt (it has the most
 * thread history attached). Move every duplicate's threads to the canonical
 * row, merge notes, then delete the duplicate. Cascades take care of
 * EnrichmentJob / PersonEnrichment.
 *
 * The grouping/notes logic lives in dedupe-imessage-people-plan.ts (pure,
 * unit-tested); this file is the DB-touching executable wrapper.
 *
 * Usage:
 *   tsx src/scripts/dedupe-imessage-people.ts                # dry run (default)
 *   tsx src/scripts/dedupe-imessage-people.ts --apply        # perform the merge
 *   tsx src/scripts/dedupe-imessage-people.ts --apply --force # also override the
 *                                                            # wide-delete cap
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db";
import {
  assessDeletionSafety,
  type DedupePersonRow,
  mergeNotes,
  planPersonDedupe,
} from "./dedupe-imessage-people-plan";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");

  const rows: DedupePersonRow[] = await prisma.person.findMany({
    where: { platform: "IMESSAGE" },
    orderBy: { createdAt: "asc" },
    select: { id: true, handle: true, displayName: true, createdAt: true, notes: true },
  });

  const plan = planPersonDedupe(rows);
  const totalDuplicates = plan.merges.reduce((n, m) => n + m.duplicateIds.length, 0);

  console.log(
    `[dedupe] ${rows.length} IMESSAGE persons · ${plan.groupsConsidered} handle groups · ` +
      `${plan.merges.length} mergeable groups (${totalDuplicates} duplicates) · ` +
      `${plan.skippedNoHandle} skipped (no handle).`
  );
  for (const m of plan.merges) {
    const notesNote = m.duplicatesWithNotes.length
      ? ` [notes preserved from ${m.duplicatesWithNotes.length}]`
      : "";
    console.log(
      `[dedupe] ${apply ? "MERGE" : "would merge"} ${m.duplicateIds.length} -> ${m.canonicalId} ` +
        `(${m.canonicalName}) key=${m.key} dups=${m.duplicateIds.join(",")}${notesNote}`
    );
  }

  if (!apply) {
    console.log("[dedupe] DRY RUN — nothing written. Re-run with --apply to perform the merge.");
    return;
  }

  const safety = assessDeletionSafety(plan, { apply, force });
  if (!safety.ok) {
    console.error(`[dedupe] ABORTED — ${safety.reason} Nothing written.`);
    process.exitCode = 1;
    return;
  }

  let merged = 0;
  for (const m of plan.merges) {
    for (const dupId of m.duplicateIds) {
      const dup = rows.find((r) => r.id === dupId);
      await prisma.$transaction(async (tx) => {
        await tx.thread.updateMany({ where: { personId: dupId }, data: { personId: m.canonicalId } });
        const canonical = await tx.person.findUnique({
          where: { id: m.canonicalId },
          select: { notes: true },
        });
        const nextNotes = mergeNotes(canonical?.notes ?? null, dup?.notes ?? null);
        if (nextNotes !== (canonical?.notes ?? null)) {
          await tx.person.update({ where: { id: m.canonicalId }, data: { notes: nextNotes } });
        }
        await tx.person.delete({ where: { id: dupId } });
      });
      console.log(`[dedupe] merged ${dupId} -> ${m.canonicalId} (${m.canonicalName})`);
      merged += 1;
    }
  }

  console.log(`[dedupe] done. merged=${merged}`);
}

const entryPoint = process.argv[1];
const isDirectExecution = entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main()
    .catch((error) => {
      console.error("[dedupe] failed", error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
