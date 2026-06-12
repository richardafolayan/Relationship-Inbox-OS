/**
 * Pure planning logic for the iMessage reply-thread backfill. No DB access
 * and no side effects, so it is unit-testable in isolation (see
 * tests/runner-backfill-reply-threads.test.mjs). The executable script
 * (backfill-imessage-reply-threads.ts) loads the rows, prints the plan, and -
 * only with --apply - performs the writes.
 *
 * Why this exists: the scan captures chat.db's `thread_originator_guid` as
 * `rawJson.replyToGuid` on every (re)synced message, but the #682 watermark
 * gate stopped re-syncing chats with no new traffic - so messages scanned
 * before threading shipped never pick the pointer up and their replies render
 * unthreaded forever. This backfill merges the pointer into the existing
 * rows once, additively: only the `replyToGuid` key is written, everything
 * else in rawJson is preserved byte-for-byte as parsed JSON.
 */

/** chat.db reply row: message guid -> its thread originator guid. */
export interface ChatDbReplyRow {
  guid: string;
  threadOriginatorGuid: string;
}

/** Minimal slice of our Message rows the planner needs. */
export interface BackfillReplyMessageRow {
  id: string;
  platformMessageKey: string;
  rawJson: string | null;
}

/** One intended update: merge replyToGuid into the row's rawJson. */
export interface PlannedReplyLink {
  id: string;
  platformMessageKey: string;
  replyToGuid: string;
  /** Full merged rawJson string to write. */
  nextRawJson: string;
}

export interface ReplyBackfillPlan {
  /** App rows handed to the planner (rows whose guid chat.db marks as a reply). */
  inspected: number;
  /** Rows whose rawJson already carries replyToGuid - left untouched. */
  alreadyLinked: number;
  /** Rows whose rawJson did not parse - left untouched (never clobber). */
  malformedRawJson: number;
  /** Rows to update. */
  changes: PlannedReplyLink[];
}

/**
 * chat.db stores thread_originator_guid as the bare guid, but
 * associated_message_guid-style prefixes ("p:0/", "bp:") have leaked into
 * adjacent columns across macOS versions - normalise defensively, exactly
 * like IMessageDb.fetchMessages does.
 */
export function normalizeOriginatorGuid(guid: string | null | undefined): string | null {
  if (typeof guid !== "string") return null;
  const trimmed = guid.trim().replace(/^(?:p:\d+\/|bp:)/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Fold chat.db reply rows into a guid -> normalized originator guid map. */
export function buildReplyPointerMap(rows: ChatDbReplyRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const originator = normalizeOriginatorGuid(row.threadOriginatorGuid);
    if (!originator || !row.guid) continue;
    // A reply citing itself would render as a degenerate one-message
    // thread - chat.db should never produce this, but skip defensively.
    if (originator === row.guid) continue;
    map.set(row.guid, originator);
  }
  return map;
}

/**
 * Pure planner: decide which Message rows get `replyToGuid` merged into
 * their rawJson. Additive only - rows that already carry the key (even a
 * different value: the scan wrote it from the same source of truth) and
 * rows whose rawJson does not parse are left untouched and counted.
 */
export function planReplyThreadBackfill(
  rows: BackfillReplyMessageRow[],
  replyPointerByGuid: Map<string, string>
): ReplyBackfillPlan {
  const changes: PlannedReplyLink[] = [];
  let alreadyLinked = 0;
  let malformedRawJson = 0;
  for (const row of rows) {
    const replyToGuid = replyPointerByGuid.get(row.platformMessageKey);
    if (!replyToGuid) continue;
    let raw: Record<string, unknown> = {};
    if (row.rawJson !== null && row.rawJson.trim().length > 0) {
      try {
        const parsed: unknown = JSON.parse(row.rawJson);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          malformedRawJson += 1;
          continue;
        }
        raw = parsed as Record<string, unknown>;
      } catch {
        malformedRawJson += 1;
        continue;
      }
    }
    if (typeof raw.replyToGuid === "string" && raw.replyToGuid.length > 0) {
      alreadyLinked += 1;
      continue;
    }
    changes.push({
      id: row.id,
      platformMessageKey: row.platformMessageKey,
      replyToGuid,
      nextRawJson: JSON.stringify({ ...raw, replyToGuid })
    });
  }
  return { inspected: rows.length, alreadyLinked, malformedRawJson, changes };
}
