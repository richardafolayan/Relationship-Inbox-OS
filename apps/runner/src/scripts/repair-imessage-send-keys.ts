/**
 * One-shot cleanup for the duplicate-iMessage-on-rescan bug fixed in
 * #265. Before that PR, the send service persisted outbound Message
 * rows with a stableHash-shaped `platformMessageKey`
 * (sha256(thread|sentAt|OUT|text) → 64 hex chars), while subsequent
 * scans of chat.db wrote the SAME physical iMessage keyed by chat.db's
 * row guid (UUID with hyphens). The two keys didn't match, so the
 * dedup upsert inserted a second row, and the dashboard rendered the
 * outbound bubble twice.
 *
 * #265 aligns future sends, but the rows already persisted with
 * stableHash keys stay duplicated until cleaned up. This script walks
 * every OUT iMessage row whose key matches the stableHash shape, looks
 * up the matching chat.db row by `(threadId, sentAt±tolerance, text)`,
 * and either:
 *
 *   - Repoint: rewrite the row's `platformMessageKey` to the chat.db
 *     guid so the next scan dedups against it (most common — usually
 *     happens when the operator never rescanned after the original
 *     send, so no twin row was inserted yet).
 *   - Collapse: when a twin row keyed by the real guid already exists
 *     (the duplicate the user sees), delete the stableHash row. The
 *     twin keeps the inbound-style row from the scan and the
 *     "sentVia=automation" attribution carries over via a copy.
 *
 * Defaults to dry-run; pass `--apply` to commit changes. Per-thread
 * `--thread <cuid>` narrows scope for testing on a single chat.
 *
 *   npx tsx apps/runner/src/scripts/repair-imessage-send-keys.ts
 *   npx tsx apps/runner/src/scripts/repair-imessage-send-keys.ts --apply
 *   npx tsx apps/runner/src/scripts/repair-imessage-send-keys.ts \
 *     --apply --thread cmox6amku01h7nw2w06u2cwn9
 */
import Database from "better-sqlite3";
import { prisma } from "../db";
import { appleTimeToIso, IMessageDb } from "../platforms/imessage-db";

const STABLE_HASH_RE = /^[a-f0-9]{64}$/;
/**
 * Send-side `receipt.sentAt` (which became the Message.timestamp) is
 * polled from chat.db so it should match the scan's view of the same
 * message, but Messages.app can update `is_delivered` after the row is
 * first written. A small window absorbs the few seconds of drift.
 */
const TIMESTAMP_TOLERANCE_MS = 30_000;

interface CliFlags {
  apply: boolean;
  threadId: string | null;
  dbPath: string;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    apply: args.includes("--apply"),
    threadId: null,
    dbPath: process.env.IMESSAGE_DB_PATH
      ?? `${process.env.HOME ?? ""}/Library/Messages/chat.db`
  };
  const threadIdx = args.indexOf("--thread");
  if (threadIdx >= 0 && args[threadIdx + 1]) {
    flags.threadId = args[threadIdx + 1]!;
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const tag = flags.apply ? "[apply]" : "[dry-run]";
  console.log(`${tag} repair-imessage-send-keys starting`);
  console.log(`${tag} chat.db: ${flags.dbPath}`);
  if (flags.threadId) console.log(`${tag} scoped to thread ${flags.threadId}`);

  // Pull all OUT iMessage rows whose key is the legacy stableHash shape.
  // Filtering server-side is awkward (Prisma can't apply a regex on
  // SQLite), so we pull the candidate set and filter in JS — the cohort
  // is small in practice (operator-sent messages only).
  const candidateWhere = {
    direction: "OUT" as const,
    thread: {
      platform: "IMESSAGE" as const,
      ...(flags.threadId ? { id: flags.threadId } : {})
    }
  };
  const candidates = await prisma.message.findMany({
    where: candidateWhere,
    include: { thread: { select: { id: true, platformThreadId: true, person: { select: { displayName: true } } } } },
    orderBy: { timestamp: "asc" }
  });
  const stableHashed = candidates.filter((m) => STABLE_HASH_RE.test(m.platformMessageKey));
  console.log(
    `${tag} ${candidates.length} OUT iMessage rows scanned; ${stableHashed.length} have legacy stableHash keys`
  );
  if (stableHashed.length === 0) {
    console.log(`${tag} nothing to do`);
    return;
  }

  // Open chat.db read-only. We don't use the IMessageDb helper here
  // because we need a flexible "find OUT row across ANY chat by text
  // + timestamp" query — IMessageAdapter normally merges sibling
  // chats (phone + email for the same person), so a single chat-
  // scoped fetch would miss messages the runner actually sent via the
  // email sibling when our Prisma thread is keyed by the phone.
  const db = new Database(flags.dbPath, { readonly: true, fileMustExist: true });
  // Apple stores date in ns since 2001-01-01; convert to JS ms range.
  const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;
  // Modern Messages.app stores OUT message text inside an
  // NSAttributedString blob on `attributedBody`, not the plain `text`
  // column (which is NULL for anything sent after iOS 16 / macOS
  // Ventura). So we can't filter by text in SQL — pull candidates by
  // date window only and verify by decoding the blob in JS.
  const findOutboundByDate = db.prepare<{ lo: bigint; hi: bigint }>(
    `SELECT guid, text, attributedBody, date FROM message
     WHERE is_from_me = 1
       AND date BETWEEN @lo AND @hi
     ORDER BY date ASC
     LIMIT 20`
  );

  let collapsed = 0;
  let repointed = 0;
  let unmatched = 0;
  let skippedTwinMissing = 0;

  try {
    for (const row of stableHashed) {
      const { threadId } = row;
      const personLabel = row.thread.person?.displayName ?? "?";
      // Attachment-only sends end up with `text === ""` in Prisma and
      // decode to the object-replacement char `￼` in chat.db.
      // Matching them by text alone is ambiguous (multiple attachments
      // in the same minute all look identical), and the duplicate-
      // bubble symptom the user reported is text-only. Skip — they're
      // safe to leave keyed by stableHash.
      if (row.text === "" || /^\[(?:Voice note|Audio|Photo|Video)\]$/i.test(row.text)) {
        console.log(`  [skip-attachment] msgId=${row.id} (${personLabel}) sentAt=${row.timestamp.toISOString()}`);
        skippedTwinMissing++;
        continue;
      }
      const targetMs = row.timestamp.getTime();
      const targetNs = BigInt(targetMs - APPLE_EPOCH_OFFSET_MS) * 1_000_000n;
      const toleranceNs = BigInt(TIMESTAMP_TOLERANCE_MS) * 1_000_000n;
      const rawCandidates = findOutboundByDate.all({
        lo: targetNs - toleranceNs,
        hi: targetNs + toleranceNs
      }) as Array<{ guid: string; text: string | null; attributedBody: Buffer | null; date: bigint | number }>;
      const decodedCandidates = rawCandidates.map((c) => ({
        guid: c.guid,
        date: c.date,
        decodedText:
          c.text && c.text.length > 0
            ? c.text
            : IMessageDb.decodeAttributedBody(c.attributedBody)
      }));
      // Normalise quotes / whitespace for comparison — Messages.app's
      // attributedBody often round-trips curly apostrophes that the
      // Prisma row never had, and vice-versa.
      const normalise = (s: string) =>
        s
          .normalize("NFC")
          .replace(/[‘’]/g, "'")
          .replace(/[“”]/g, '"')
          .replace(/\s+/g, " ")
          .trim();
      const wantedText = normalise(row.text);
      const candidates = decodedCandidates.filter(
        (c) => normalise(c.decodedText) === wantedText
      );
      if (candidates.length === 0) {
        const previews = decodedCandidates
          .slice(0, 3)
          .map((c) => JSON.stringify(c.decodedText.slice(0, 60)))
          .join(", ");
        console.log(
          `  [unmatched] msgId=${row.id} (${personLabel}) sentAt=${row.timestamp.toISOString()} text=${JSON.stringify(row.text.slice(0, 60))} | chat.db nearby: ${previews || "(none)"}`
        );
        unmatched++;
        continue;
      }
      const closest = candidates.reduce((best, c) => {
        const bestTs = appleTimeToIso(typeof best.date === "bigint" ? best.date : (best.date ?? null));
        const cTs = appleTimeToIso(typeof c.date === "bigint" ? c.date : (c.date ?? null));
        const bestDelta = bestTs ? Math.abs(new Date(bestTs).getTime() - targetMs) : Infinity;
        const cDelta = cTs ? Math.abs(new Date(cTs).getTime() - targetMs) : Infinity;
        return cDelta < bestDelta ? c : best;
      });
      const realGuid = closest.guid;

      // Twin: a row in OUR DB already keyed by the real chat.db guid
      // for this same thread. That's the duplicate the user sees.
      const twin = await prisma.message.findUnique({
        where: { threadId_platformMessageKey: { threadId, platformMessageKey: realGuid } }
      });

      if (twin) {
        if (twin.id === row.id) {
          // Shouldn't happen — stableHash row matched its own key.
          console.log(`  [skip] row ${row.id} already keyed by guid? bailing`);
          skippedTwinMissing++;
          continue;
        }
        console.log(
          `  [collapse] (${personLabel}) dup row id=${row.id} → keeping twin id=${twin.id} (guid=${realGuid})`
        );
        if (flags.apply) {
          // Carry forward the automation attribution + any
          // dashboard-set replyToMessageId before deleting. Twin came
          // from a scan so it doesn't know we sent it via the runner.
          await prisma.message.update({
            where: { id: twin.id },
            data: {
              sentVia: twin.sentVia ?? row.sentVia,
              replyToMessageId: twin.replyToMessageId ?? row.replyToMessageId
            }
          });
          await prisma.message.delete({ where: { id: row.id } });
        }
        collapsed++;
      } else {
        console.log(
          `  [repoint] (${personLabel}) row id=${row.id} stableHash=${row.platformMessageKey.slice(0, 12)}… → guid=${realGuid}`
        );
        if (flags.apply) {
          await prisma.message.update({
            where: { id: row.id },
            data: { platformMessageKey: realGuid }
          });
        }
        repointed++;
      }
    }
  } finally {
    db.close();
  }

  console.log(
    `\n${tag} done · repointed=${repointed} collapsed=${collapsed} unmatched=${unmatched} skipped=${skippedTwinMissing}`
  );
  if (!flags.apply) {
    console.log("Re-run with --apply to commit changes.");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
