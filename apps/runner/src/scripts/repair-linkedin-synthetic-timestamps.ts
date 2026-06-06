/**
 * One-shot repair for #407 ("Last reply computed wrong"). Before the
 * adapter fix, when LinkedIn's per-message timestamp parsing failed
 * the adapter synthesised a sequential fallback:
 *
 *   baseTimestamp = Date.now() - parsedMessages.length * 1_000
 *   message[i].timestamp = baseTimestamp + i * 1_000
 *
 * That landed every re-scrape on a fresh "today minus a few seconds"
 * cluster — pilots reported messages weeks/months old showing as
 * "3 mins ago".
 *
 * The forward-fix has the adapter return `timestamp: undefined` when
 * it can't parse a real time, so the scan-queue preserves existing
 * rows on re-scrape. But rows already written with synthetic
 * timestamps stay wrong until repaired.
 *
 * Detection (conservative — only obviously synthetic clusters):
 *   - LinkedIn thread
 *   - 4+ consecutive messages whose timestamps are spaced 0.9s–1.1s apart
 *   - cluster ends within the last 60 days (close to a scan run)
 *   - the cluster's max timestamp diverges from `thread.lastMessageAt`
 *     by more than 5 minutes (so we don't touch threads where the
 *     anchor already matches reality)
 *
 * Repair:
 *   - Anchor the cluster's most recent message to `thread.lastMessageAt`
 *   - Shift earlier messages backwards 1s/step from the anchor
 *   - Preserves visible order in the dashboard, gives the right
 *     calendar day for the most recent message (the "last reply" pill)
 *
 * Defaults to dry-run; pass `--apply` to commit. `--thread <cuid>` or
 * `--person <cuid>` scopes to a single chat/person.
 *
 *   npx tsx apps/runner/src/scripts/repair-linkedin-synthetic-timestamps.ts
 *   npx tsx apps/runner/src/scripts/repair-linkedin-synthetic-timestamps.ts --apply
 */
import { prisma } from "../db";

interface CliFlags {
  apply: boolean;
  threadId: string | null;
  personId: string | null;
}

function parseFlags(): CliFlags {
  const args = process.argv.slice(2);
  const flags: CliFlags = {
    apply: args.includes("--apply"),
    threadId: null,
    personId: null
  };
  const t = args.indexOf("--thread");
  if (t >= 0 && args[t + 1]) flags.threadId = args[t + 1]!;
  const p = args.indexOf("--person");
  if (p >= 0 && args[p + 1]) flags.personId = args[p + 1]!;
  return flags;
}

const MIN_CLUSTER_SIZE = 4;
const ONE_SECOND_LO_MS = 900;
const ONE_SECOND_HI_MS = 1_100;
const NEAR_SCAN_WINDOW_DAYS = 60;
const ANCHOR_DIVERGENCE_TOLERANCE_MS = 5 * 60 * 1_000;

interface SyntheticCluster {
  startIndex: number;
  endIndex: number;
}

/**
 * Walk a thread's messages (ordered ascending by timestamp) and return
 * runs of 4+ rows whose successive deltas are ~1 second apart. Exported
 * for unit tests.
 */
export function findSyntheticClusters(timestamps: Date[]): SyntheticCluster[] {
  const clusters: SyntheticCluster[] = [];
  let runStart = 0;
  let runLen = 1;

  for (let i = 1; i < timestamps.length; i += 1) {
    const delta = timestamps[i]!.getTime() - timestamps[i - 1]!.getTime();
    const oneSecondish = delta >= ONE_SECOND_LO_MS && delta <= ONE_SECOND_HI_MS;
    if (oneSecondish) {
      runLen += 1;
    } else {
      if (runLen >= MIN_CLUSTER_SIZE) {
        clusters.push({ startIndex: runStart, endIndex: runStart + runLen - 1 });
      }
      runStart = i;
      runLen = 1;
    }
  }
  if (runLen >= MIN_CLUSTER_SIZE) {
    clusters.push({ startIndex: runStart, endIndex: runStart + runLen - 1 });
  }
  return clusters;
}

/**
 * Decide what timestamp a cluster's tail (most recent row) should be
 * anchored to. Only a cluster that is genuinely the thread's last
 * cluster — i.e. no real messages exist after it — may be jumped onto
 * `thread.lastMessageAt`. For any earlier cluster, anchoring to
 * `lastMessageAt` would move the synthetic rows on top of (or past) the
 * later real messages and reorder the thread, so we keep it inside its
 * own local range by anchoring to its existing tail timestamp. Exported
 * for unit tests.
 */
export function resolveClusterAnchor(
  cluster: SyntheticCluster,
  timestamps: Date[],
  lastMessageAt: Date
): Date {
  const isLastCluster = cluster.endIndex === timestamps.length - 1;
  return isLastCluster ? lastMessageAt : timestamps[cluster.endIndex]!;
}

async function main(): Promise<void> {
  const flags = parseFlags();
  const tag = flags.apply ? "[apply]" : "[dry-run]";
  console.log(`${tag} repair-linkedin-synthetic-timestamps starting`);

  const threadWhere: {
    platform: "LINKEDIN";
    id?: string;
    personId?: string;
  } = { platform: "LINKEDIN" };
  if (flags.threadId) threadWhere.id = flags.threadId;
  if (flags.personId) threadWhere.personId = flags.personId;

  const threads = await prisma.thread.findMany({
    where: threadWhere,
    select: {
      id: true,
      lastMessageAt: true,
      person: { select: { displayName: true } }
    }
  });
  console.log(`${tag} scanning ${threads.length} LinkedIn thread(s)`);

  const nearScanCutoff = new Date(Date.now() - NEAR_SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1_000);
  let threadsTouched = 0;
  let clustersRewritten = 0;
  let rowsRewritten = 0;

  for (const thread of threads) {
    if (!thread.lastMessageAt) continue;

    const messages = await prisma.message.findMany({
      where: { threadId: thread.id },
      select: { id: true, timestamp: true },
      orderBy: { timestamp: "asc" }
    });
    if (messages.length < MIN_CLUSTER_SIZE) continue;

    const clusters = findSyntheticClusters(messages.map((m) => m.timestamp));
    if (clusters.length === 0) continue;

    const timestamps = messages.map((m) => m.timestamp);
    let threadDidChange = false;
    for (const cluster of clusters) {
      const tail = messages[cluster.endIndex]!.timestamp;
      // Only the thread's genuinely-last cluster may be anchored onto
      // thread.lastMessageAt; an earlier cluster anchors within its own
      // local range so it can't be reordered past later real messages.
      const anchor = resolveClusterAnchor(cluster, timestamps, thread.lastMessageAt);
      // Only repair clusters whose tail is recent (i.e. plausibly a
      // scan-time synthesis) AND whose tail diverges from the cluster's
      // anchor by more than the tolerance. (For a non-last cluster the
      // anchor is its own tail, so divergence is 0 and it is skipped.)
      if (tail < nearScanCutoff) continue;
      const divergence = Math.abs(tail.getTime() - anchor.getTime());
      if (divergence <= ANCHOR_DIVERGENCE_TOLERANCE_MS) continue;

      const clusterSize = cluster.endIndex - cluster.startIndex + 1;
      const personLabel = thread.person?.displayName ?? "?";
      console.log(
        `  [cluster] thread=${thread.id} (${personLabel}) rows=${clusterSize} ` +
          `tail=${tail.toISOString()} anchor=${anchor.toISOString()} ` +
          `divergence=${Math.round(divergence / 60_000)}m`
      );

      // Anchor the last message in the cluster to its resolved anchor;
      // shift earlier rows 1s backwards each. Preserves the dashboard's
      // visible ordering while landing the "last reply" on the right
      // calendar day.
      for (let i = cluster.startIndex; i <= cluster.endIndex; i += 1) {
        const offsetFromTail = cluster.endIndex - i;
        const newTs = new Date(anchor.getTime() - offsetFromTail * 1_000);
        const row = messages[i]!;
        if (flags.apply) {
          await prisma.message.update({
            where: { id: row.id },
            data: { timestamp: newTs }
          });
        }
        rowsRewritten += 1;
      }
      clustersRewritten += 1;
      threadDidChange = true;
    }
    if (threadDidChange) threadsTouched += 1;
  }

  console.log(
    `\n${tag} done · threads=${threadsTouched} clusters=${clustersRewritten} rows=${rowsRewritten}`
  );
  if (!flags.apply) {
    console.log("Re-run with --apply to commit changes.");
  }
}

if (process.argv[1]?.includes("repair-linkedin-synthetic-timestamps")) {
  main()
    .catch((error) => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
