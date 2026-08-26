/**
 * One-off backfill for the duplicate-outbound bug where the SAME physical
 * message survived as TWO Message rows:
 *
 *   - a send-side row: `sentVia="automation"`, keyed by
 *     `stableHash(threadId|sentAt|OUT|text)` (64 hex chars, no hyphens),
 *     holding the operator's composer text;
 *   - a scan-side row: keyed by the chat.db message guid (a UUID with
 *     hyphens), holding the attributedBody-decoded text.
 *
 * The two rows escaped the scan-side dedup because their text differed by a
 * byte chat.db normalised away — a space hugging a newline ("…heard.\n So"
 * vs "…heard.\nSo"). The forward fix (`normalizeOutboundTextForDedup` in
 * services/scan-queue.ts) compares on a whitespace-normalised form so new
 * sends dedup correctly; this script collapses the rows already persisted
 * (e.g. Lanre's thread, which rendered the same long message twice — once
 * "sent via automation ✓", once not).
 *
 * Self-contained in the app DB — it does NOT read chat.db, so it can be
 * dry-run against a copy of the sqlite file. For every synthetic-key
 * automation OUT row it looks for a guid-keyed OUT twin in the same thread OR
 * a sibling iMessage thread of the same person, within ±5 minutes, whose
 * NORMALISED text matches (using the very same comparison the forward fix
 * uses). When found it carries `sentVia="automation"` / `replyToMessageId`
 * onto the guid survivor and deletes the synthetic duplicate.
 *
 * Defaults to dry-run. `--apply` commits, writing a timestamped `.bak-…` copy
 * of the sqlite file first. `--thread <cuid>` narrows scope for testing.
 *
 *   npx tsx apps/runner/src/scripts/dedupe-outbound-whitespace.ts
 *   npx tsx apps/runner/src/scripts/dedupe-outbound-whitespace.ts --apply
 *   npx tsx apps/runner/src/scripts/dedupe-outbound-whitespace.ts \
 *     --apply --thread cmox6as18026znw2wghdn8iaq
 */
import { copyFileSync } from "node:fs";
import { prisma } from "../db";
import { normalizeOutboundTextForDedup } from "../services/scan-queue";

/** Send-side synthetic key shape: 64 lowercase hex chars, no hyphens. */
const STABLE_HASH_RE = /^[a-f0-9]{64}$/;
/** A recovered platform guid (chat.db row guid) is a hyphenated UUID. */
const GUID_RE = /-/;
/** Matches the ±5-minute window decideOutboundDedup uses for twins. */
const WINDOW_MS = 5 * 60 * 1000;

interface CliFlags {
  apply: boolean;
  threadId: string | null;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    apply: args.includes("--apply"),
    threadId: null
  };
  const threadIdx = args.indexOf("--thread");
  if (threadIdx >= 0 && args[threadIdx + 1]) {
    flags.threadId = args[threadIdx + 1]!;
  }
  return flags;
}

/**
 * Back up the sqlite file before any mutation. Derives the path from
 * DATABASE_URL (db.ts has already populated it with `file:<abs>` by the time
 * this runs). Returns the backup path, or null when the URL isn't a local
 * file (e.g. a future networked DB), in which case --apply refuses to run.
 */
function backupSqlite(): string | null {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("file:")) return null;
  const dbPath = url.slice("file:".length);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.bak-dedupe-whitespace-${stamp}`;
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

interface OutRow {
  id: string;
  threadId: string;
  platformMessageKey: string;
  text: string;
  timestamp: Date;
  sentVia: string | null;
  replyToMessageId: string | null;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const tag = flags.apply ? "[apply]" : "[dry-run]";
  console.log(`${tag} dedupe-outbound-whitespace starting`);
  if (flags.threadId) console.log(`${tag} scoped to thread ${flags.threadId}`);

  if (flags.apply) {
    const backupPath = backupSqlite();
    if (!backupPath) {
      console.error(
        "[apply] refusing to mutate: DATABASE_URL is not a local file: URL, cannot take a backup."
      );
      process.exit(1);
    }
    console.log(`[apply] backed up sqlite → ${backupPath}`);
  }

  // Candidate set: OUT automation rows whose key is the synthetic stableHash
  // shape. Prisma can't regex on sqlite, so pull the cohort (operator-sent
  // messages only — small) and filter the shape in JS.
  const candidates = (await prisma.message.findMany({
    where: {
      direction: "OUT",
      sentVia: "automation",
      ...(flags.threadId ? { threadId: flags.threadId } : {})
    },
    select: {
      id: true,
      threadId: true,
      platformMessageKey: true,
      text: true,
      timestamp: true,
      sentVia: true,
      replyToMessageId: true,
      thread: {
        select: { platform: true, personId: true, person: { select: { displayName: true } } }
      }
    },
    orderBy: { timestamp: "asc" }
  })) as Array<OutRow & { thread: { platform: string; personId: string | null; person: { displayName: string } | null } }>;

  const synthetic = candidates.filter((m) => STABLE_HASH_RE.test(m.platformMessageKey));
  console.log(
    `${tag} ${candidates.length} OUT automation rows scanned; ${synthetic.length} have synthetic (stableHash) keys`
  );

  let collapsed = 0;
  let noTwin = 0;
  // Resolve sibling-thread sets once per person to avoid repeat queries.
  const siblingCache = new Map<string, string[]>();

  for (const row of synthetic) {
    const personLabel = row.thread.person?.displayName ?? "?";

    // Twin search scope: the same thread, plus every sibling iMessage thread
    // of the same person (a contact with both a phone + an iMessage email
    // gets one Prisma thread per handle; send.ts writes to the active thread
    // while pickBestSendHandle may route the actual send through the sibling).
    let threadIds = [row.threadId];
    if (row.thread.platform === "IMESSAGE" && row.thread.personId) {
      let siblings = siblingCache.get(row.thread.personId);
      if (!siblings) {
        const rows = await prisma.thread.findMany({
          where: { platform: "IMESSAGE", personId: row.thread.personId },
          select: { id: true }
        });
        siblings = rows.map((r) => r.id);
        siblingCache.set(row.thread.personId, siblings);
      }
      if (siblings.length > 1) threadIds = siblings;
    }

    const windowRows = (await prisma.message.findMany({
      where: {
        threadId: { in: threadIds },
        direction: "OUT",
        timestamp: {
          gte: new Date(row.timestamp.getTime() - WINDOW_MS),
          lte: new Date(row.timestamp.getTime() + WINDOW_MS)
        },
        NOT: { id: row.id }
      },
      select: {
        id: true,
        threadId: true,
        platformMessageKey: true,
        text: true,
        timestamp: true,
        sentVia: true,
        replyToMessageId: true
      }
    })) as OutRow[];

    const normalizedRow = normalizeOutboundTextForDedup(row.text);
    const guidTwins = windowRows.filter(
      (t) =>
        GUID_RE.test(t.platformMessageKey) &&
        normalizeOutboundTextForDedup(t.text) === normalizedRow
    );
    if (guidTwins.length === 0) {
      console.log(
        `  [no-twin] (${personLabel}) synthetic row id=${row.id} sentAt=${row.timestamp.toISOString()} text=${JSON.stringify(row.text.slice(0, 50))} — left as-is`
      );
      noTwin++;
      continue;
    }

    // Survivor = the guid-keyed twin closest in time (the scan-side canonical).
    const survivor = guidTwins.reduce((best, t) =>
      Math.abs(t.timestamp.getTime() - row.timestamp.getTime()) <
      Math.abs(best.timestamp.getTime() - row.timestamp.getTime())
        ? t
        : best
    );
    console.log(
      `  [collapse] (${personLabel}) deleting synthetic id=${row.id} (${row.platformMessageKey.slice(0, 12)}…) → keeping guid twin id=${survivor.id} (${survivor.platformMessageKey})`
    );
    if (flags.apply) {
      // Carry the send-side attribution onto the survivor before deleting.
      // The scan row doesn't know we sent it via the runner, and a focused-
      // thread reply may have set replyToMessageId only on the synthetic row.
      const data: { sentVia?: string; replyToMessageId?: string } = {};
      if (survivor.sentVia !== "automation") data.sentVia = "automation";
      if (!survivor.replyToMessageId && row.replyToMessageId) {
        data.replyToMessageId = row.replyToMessageId;
      }
      if (Object.keys(data).length > 0) {
        await prisma.message.update({ where: { id: survivor.id }, data });
      }
      await prisma.message.delete({ where: { id: row.id } });
    }
    collapsed++;
  }

  console.log(`\n${tag} done · collapsed=${collapsed} no-twin=${noTwin}`);
  if (!flags.apply) {
    console.log("Re-run with --apply to commit changes (writes a .bak-… copy first).");
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
