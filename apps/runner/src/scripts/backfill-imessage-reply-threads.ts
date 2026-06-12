/**
 * Backfill Apple-native reply threading onto messages scanned before the
 * pointer was captured.
 *
 * chat.db stores which message a threaded reply points at
 * (`message.thread_originator_guid`); the scan has persisted it as
 * `rawJson.replyToGuid` since #255, and the dashboard renders the
 * quote/curve/"N Replies" affordances off it. But the #682 watermark gate
 * skips chats with no new traffic, so rows scanned before #255 never get
 * re-upserted and their threads render flat forever. This script walks
 * chat.db's reply pointers once and merges the missing `replyToGuid` keys
 * into our existing Message rows.
 *
 * Additive only: the merge writes the single `replyToGuid` key and
 * preserves every other rawJson field; rows that already carry the key and
 * rows whose rawJson does not parse are skipped (and counted).
 *
 * DRY RUN by default: prints the full count breakdown and writes NOTHING.
 * Pass `--apply` to perform the merge. chat.db itself is opened read-only.
 *
 * The merge/skip decision lives in backfill-imessage-reply-threads-plan.ts
 * (pure, unit-tested); this file is the DB-touching executable wrapper.
 *
 * Usage:
 *   tsx src/scripts/backfill-imessage-reply-threads.ts            # dry run
 *   tsx src/scripts/backfill-imessage-reply-threads.ts --apply    # perform the merge
 */
import Database from "better-sqlite3";
import { prisma } from "../db";
import { runnerConfig } from "../config";
import {
  buildReplyPointerMap,
  planReplyThreadBackfill,
  type BackfillReplyMessageRow,
  type ChatDbReplyRow
} from "./backfill-imessage-reply-threads-plan";

/** SQLite parameter limit is 999 in older builds - stay well under it. */
const IN_CHUNK = 400;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const dbPath = runnerConfig.imessage.dbPath;
  let chatDb: InstanceType<typeof Database>;
  try {
    chatDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    console.error(
      `[reply-backfill] cannot open chat.db at ${dbPath} - needs Full Disk Access ` +
        "and an unsandboxed shell. Set IMESSAGE_DB_PATH to point at a copy for testing.",
      error
    );
    process.exit(1);
  }
  let replyRows: ChatDbReplyRow[];
  try {
    replyRows = chatDb
      .prepare(
        `SELECT guid, thread_originator_guid AS threadOriginatorGuid
           FROM message
          WHERE thread_originator_guid IS NOT NULL
            AND thread_originator_guid != ''`
      )
      .all() as ChatDbReplyRow[];
  } finally {
    chatDb.close();
  }
  const pointerByGuid = buildReplyPointerMap(replyRows);
  console.log(
    `[reply-backfill] chat.db: ${replyRows.length} reply rows, ${pointerByGuid.size} usable pointers`
  );

  // Pull only OUR rows whose guid chat.db marks as a reply - chunked IN
  // queries keep this far away from both SQLite's bind-parameter limit
  // and loading 150k rawJson blobs for nothing. The same guid can appear
  // on sibling thread rows (multi-handle contacts); every copy gets the
  // pointer so pickCanonicalThread never changes the answer.
  const replyGuids = [...pointerByGuid.keys()];
  const ourRows: BackfillReplyMessageRow[] = [];
  for (const guids of chunk(replyGuids, IN_CHUNK)) {
    const rows = await prisma.message.findMany({
      where: {
        platformMessageKey: { in: guids },
        thread: { platform: "IMESSAGE" }
      },
      select: { id: true, platformMessageKey: true, rawJson: true }
    });
    ourRows.push(...rows);
  }

  // Honesty stat: how many cited parents exist in our DB at all. Replies
  // whose parent was never synced still render (the dashboard falls back
  // to "Earlier message no longer available"), but the operator should
  // know how common that is before trusting the threads view.
  const parentGuids = [...new Set(pointerByGuid.values())];
  let parentsFound = 0;
  for (const guids of chunk(parentGuids, IN_CHUNK)) {
    parentsFound += await prisma.message.count({
      where: {
        platformMessageKey: { in: guids },
        thread: { platform: "IMESSAGE" }
      }
    });
  }

  const plan = planReplyThreadBackfill(ourRows, pointerByGuid);
  const missingInAppDb = pointerByGuid.size - new Set(ourRows.map((r) => r.platformMessageKey)).size;

  console.log(
    `[reply-backfill] app rows inspected=${plan.inspected} ` +
      `alreadyLinked=${plan.alreadyLinked} eligible=${plan.changes.length} ` +
      `malformedRawJson=${plan.malformedRawJson}`
  );
  console.log(
    `[reply-backfill] replies chat.db knows but our DB never synced: ${missingInAppDb} · ` +
      `cited parents found in our DB: ${parentsFound}/${parentGuids.length}`
  );
  for (const change of plan.changes.slice(0, 10)) {
    console.log(
      `[reply-backfill] ${apply ? "linking" : "would link"} ${change.platformMessageKey} -> ${change.replyToGuid}`
    );
  }
  if (plan.changes.length > 10) {
    console.log(`[reply-backfill] ... and ${plan.changes.length - 10} more`);
  }

  if (!apply) {
    console.log(
      `[reply-backfill] DRY RUN - nothing written. ${plan.changes.length} rows would gain ` +
        "replyToGuid. Re-run with --apply to perform the merge."
    );
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  for (const batch of chunk(plan.changes, 200)) {
    await prisma.$transaction(
      batch.map((change) =>
        prisma.message.update({
          where: { id: change.id },
          data: { rawJson: change.nextRawJson }
        })
      )
    );
    updated += batch.length;
    console.log(`[reply-backfill] updated ${updated}/${plan.changes.length}`);
  }

  console.log(
    `[reply-backfill] DONE updated=${updated} alreadyLinked=${plan.alreadyLinked} ` +
      `malformedRawJson=${plan.malformedRawJson}`
  );
  await prisma.$disconnect();
}

void main().catch((error) => {
  console.error("[reply-backfill] failed", error);
  process.exit(1);
});
