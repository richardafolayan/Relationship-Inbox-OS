/**
 * Walk every IMESSAGE thread, look up the underlying chat.db
 * chat_identifier, and delete threads whose sender is an automated
 * service (alphanumeric sender ID like "StripeLink"/"giffgaff",
 * short-code numbers like "12345", etc.). Person rows whose last
 * thread got deleted are removed too.
 *
 * One-shot cleanup. The iMessage adapter applies the same filter at
 * scan time so future scans don't re-add these.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { prisma } from "../db";
import { runnerConfig } from "../config";
import { IMessageDb, looksLikeAutomatedSender } from "../platforms/imessage-db";

/** chat.db `chat.style` value for a group conversation. */
const GROUP_CHAT_STYLE = 43;

export interface PurgeChatRow {
  guid: string;
  chatIdentifier: string | null;
  /** chat.db `chat.style`; 43 means a group chat. */
  style: number | null;
}

/**
 * Pick the chat.db guids whose sender looks automated, EXEMPTING group
 * chats. Mirrors the adapter's scan-time filter (imessage-db.ts): group
 * chats (style === 43) carry synthetic "chatNNN" identifiers that the
 * heuristic mistakes for an alphanumeric service ID, so they must never
 * be purged.
 */
export function classifyAutomatedGuids(rows: PurgeChatRow[]): Set<string> {
  return new Set(
    rows
      .filter((r) => r.style !== GROUP_CHAT_STYLE && looksLikeAutomatedSender(r.chatIdentifier ?? ""))
      .map((r) => r.guid)
  );
}

async function main(): Promise<void> {
  // Destructive: default to a dry run, only delete under an explicit flag.
  const apply = process.argv.includes("--apply");
  const db = new IMessageDb(runnerConfig.imessage.dbPath);
  // Precompute chat-identifier per chat.db guid for fast lookup.
  const chats = db.listThreads(2000, { unreadOnly: false });
  // listThreads already filters out automated, so the easier route:
  // walk chat.db separately for the lookup we need.
  // Use a side query through the underlying sqlite handle by re-listing
  // without the filter — quickest is a direct SQL query.

  const allRows: PurgeChatRow[] = [];
  // Re-open chat.db for the unfiltered query. Fetch `style` so group chats
  // (style 43) can be exempted, matching the adapter's scan-time filter.
  const sqlite = (db as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
  const rawRows = sqlite
    .prepare("SELECT guid, chat_identifier AS chatIdentifier, style FROM chat")
    .all() as PurgeChatRow[];
  for (const r of rawRows) allRows.push(r);
  void chats;

  const automatedGuids = classifyAutomatedGuids(allRows);

  console.log(`[purge] ${automatedGuids.size} chat.db chats classified automated`);

  const threads = await prisma.thread.findMany({
    where: { platform: "IMESSAGE" },
    select: { id: true, platformThreadId: true, personId: true }
  });

  const targetThreadIds: string[] = [];
  const personIdsToCheck = new Set<string>();
  for (const t of threads) {
    if (automatedGuids.has(t.platformThreadId)) {
      targetThreadIds.push(t.id);
      personIdsToCheck.add(t.personId);
    }
  }

  if (targetThreadIds.length === 0) {
    console.log("[purge] no automated threads found in DB");
    db.close();
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log(
      `[purge] DRY RUN — would delete ${targetThreadIds.length} threads (and their messages, drafts, sendRequests) ` +
        `and any newly-orphaned people. Nothing written. Re-run with --apply to perform the purge.`
    );
    db.close();
    await prisma.$disconnect();
    return;
  }

  console.log(`[purge] deleting ${targetThreadIds.length} threads (and their messages, drafts, sendRequests)…`);
  await prisma.thread.deleteMany({ where: { id: { in: targetThreadIds } } });

  // Delete Person rows that no longer have any threads attached.
  let deletedPeople = 0;
  for (const personId of personIdsToCheck) {
    const remaining = await prisma.thread.count({ where: { personId } });
    if (remaining === 0) {
      await prisma.person.delete({ where: { id: personId } });
      deletedPeople += 1;
    }
  }

  console.log(`[purge] done. threads=${targetThreadIds.length} orphan_people=${deletedPeople}`);
  db.close();
  await prisma.$disconnect();
}

const entryPoint = process.argv[1];
const isDirectExecution = entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void main().catch((error) => {
    console.error("[purge] failed", error);
    process.exit(1);
  });
}
