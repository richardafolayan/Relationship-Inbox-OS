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
import { prisma } from "../db";
import { runnerConfig } from "../config";
import { IMessageDb, looksLikeAutomatedSender } from "../platforms/imessage-db";

async function main(): Promise<void> {
  const db = new IMessageDb(runnerConfig.imessage.dbPath);
  // Walk chat.db directly to enumerate every chat (no automated filter).
  // listThreads is the filtered/public path; this maintenance script
  // needs unfiltered rows so it can decide what to purge from MY DB.
  //
  // FIXME: this reaches into a private `db` field on IMessageDb via an
  // `unknown` cast. If that internal name changes the script silently
  // breaks. Migrate to a dedicated `IMessageDb.listChatIdentifiers()`
  // helper when it becomes worth touching the public surface.
  const allRows: Array<{ guid: string; chatIdentifier: string }> = [];
  const sqlite = (db as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
  const rawRows = sqlite.prepare("SELECT guid, chat_identifier AS chatIdentifier FROM chat").all() as Array<{
    guid: string;
    chatIdentifier: string;
  }>;
  for (const r of rawRows) allRows.push(r);

  const automatedGuids = new Set(
    allRows.filter((r) => looksLikeAutomatedSender(r.chatIdentifier ?? "")).map((r) => r.guid)
  );

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

void main().catch((error) => {
  console.error("[purge] failed", error);
  process.exit(1);
});
