// Issue #287 phase 3: when an old thread drops out of the active inbox
// (recency horizon, phase 1) it does not just become noise to ignore -
// some of those people are worth a gentle hello after the lull. The
// Reconnect page surfaces those candidates without ever auto-sending
// anything; the operator decides whether to reach out.
//
// Every platform is a candidate. Reconnect started LinkedIn-only (the
// original worry: nudging "you should message your sister" about natural
// friends-and-family lulls would feel wrong) but the operator asked for
// iMessage and the rest too. The personal-lull caution now lives in the
// AI scorer instead: the runner's per-platform prompt framing keeps
// iMessage scores conservative unless there is a real beat to pick up.
// Group chats stay out - the page's per-person "worth a hello" framing
// and the 1:1 relationship scorer do not fit a group thread.
//
// The heuristic stays conservative: only threads that are clearly dormant
// AND clearly not auto-pitch outreach are flagged. Operator-archived
// threads stay out too - if the operator already closed the chapter,
// the Reconnect page should respect that.

import { isWithinHorizon } from "./horizon";

/**
 * The minimum shape of an inbox row needed to decide whether it belongs
 * on the Reconnect page. The component passes full InboxRow values but
 * the helper only reads these few fields, which keeps it easy to test.
 */
export interface ReconnectCandidate {
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE";
  lastMessageAt: string | null;
  /** True for group threads (iMessage group chats). Groups are not
   *  reconnect candidates: the page suggests a 1:1 hello to a person.
   *  Absent on legacy payloads, which only carried 1:1 rows. */
  isGroup?: boolean;
  archivedAt?: string | null;
  /** "outreach" | "genuine" | null - see InboxRow.category in types.ts. */
  category?: string | null;
  /** Scheduled outbound send; if present, the operator already has a
   *  reply teed up and the thread should stay out of the suggestions. */
  scheduledSendAt?: string | null;
  /**
   * Total message count on the thread (operator + contact). Used by the
   * deterministic relationship-signal scorer as a depth proxy when no
   * AI score is available. Optional because legacy rows may not surface
   * it.
   */
  messageCount?: number;
  /**
   * AI reconnect-worthiness score, 0-100 (#287 phase 3.5). Null until a
   * scan has called the runner's /control/reconnect/refresh-scores
   * endpoint OR the AI provider was unavailable. When present, this
   * overrides the deterministic relationship-signal score below.
   */
  reconnectScore?: number | null;
  /** Short one-line reason rendered as a quiet "why" caption alongside
   *  top-ranked candidates. */
  reconnectScoreReason?: string | null;
}

/**
 * Whether the thread is a reconnect candidate under the conservative
 * heuristic above. Returns true only for 1:1 threads (any platform) that
 * are outside the recency horizon, not archived, not outreach-tagged,
 * and not already queued for a reply.
 */
export function isReconnectCandidate(row: ReconnectCandidate): boolean {
  if (row.isGroup) return false;
  if (row.archivedAt) return false;
  if (row.scheduledSendAt) return false;
  if (row.category === "outreach") return false;
  // Active threads belong in the Inbox; Reconnect only lists the ones
  // that have already aged out of the recency horizon.
  if (isWithinHorizon(row.lastMessageAt)) return false;
  return true;
}

/**
 * Deterministic "is this relationship worth a hello?" score, 0-100,
 * computed entirely client-side from the signals already on the row.
 * Two inputs: depth (total message count, capped) and recency (days
 * since the dormancy started, fading after the horizon). The result is
 * stable, free, and gives a useful ranking before any AI score lands.
 *
 *   depth   = min(60, messageCount * 3)
 *   recency = max(0, 40 - max(0, daysDormant - 30) / 4)
 *
 * A 6-turn relationship that went dormant 35 days ago scores ~58 (18
 * depth + 39 recency). A 30-turn relationship dormant for a year scores
 * ~60 (60 depth + 0 recency). A 1-turn pitch dormant for 18 months
 * scores ~3. Tuned to be conservative: this is a ranking aid, not a
 * recommendation.
 */
export function relationshipSignalScore(
  row: ReconnectCandidate,
  now: number = Date.now()
): number {
  const messageCount = row.messageCount ?? 0;
  const daysDormant = row.lastMessageAt
    ? Math.max(0, (now - Date.parse(row.lastMessageAt)) / (24 * 60 * 60 * 1000))
    : 365;

  const depth = Math.min(60, messageCount * 3);
  const recencyDecay = Math.max(0, daysDormant - 30) / 4;
  const recency = Math.max(0, 40 - recencyDecay);

  return Math.round(depth + recency);
}

/**
 * The score the dashboard sorts and surfaces by. AI score (#287 phase
 * 3.5) wins when present; otherwise we fall back to the deterministic
 * relationship-signal score so the page is useful with no AI provider
 * configured.
 */
export function combinedReconnectScore(
  row: ReconnectCandidate,
  now: number = Date.now()
): number {
  if (typeof row.reconnectScore === "number") return row.reconnectScore;
  return relationshipSignalScore(row, now);
}

/**
 * Order candidates so the highest-scoring (most worth a hello) threads
 * sit at the top. Ties break by most-recent dormancy. Threads with an
 * unknown last-activity timestamp sink to the bottom.
 */
export function rankReconnectCandidates<T extends ReconnectCandidate>(
  rows: T[],
  now: number = Date.now()
): T[] {
  return [...rows].sort((a, b) => {
    const aScore = combinedReconnectScore(a, now);
    const bScore = combinedReconnectScore(b, now);
    if (aScore !== bScore) return bScore - aScore;
    const aTs = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
    const bTs = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
    return bTs - aTs;
  });
}

/** Status the runner's POST /control/reconnect/refresh-scores can return. */
export type RefreshScoresStatus = "ok" | "ai_unavailable" | "disabled_by_settings";

/**
 * Map a refresh-scores result to the operator-facing summary + tone for the
 * Reconnect "Refresh AI scores" button. Mirrors the Inbox "Refresh closed
 * verdicts" handler so the two consumers of the identical runner contract
 * agree. The runner short-circuits to `disabled_by_settings` (scored 0,
 * skipped 0) whenever the operator's AI tier is `memory_only`; without this
 * branch the button fell through to a neutral "Scored 0", implying the scorer
 * ran and found nothing rather than telling the operator AI is off.
 */
export function interpretRefreshScoresResult(result: {
  status: RefreshScoresStatus;
  scored: number;
  skipped: number;
}): { summary: string; tone: "ok" | "warn" } {
  const summary =
    result.status === "disabled_by_settings"
      ? "AI is off (Settings)"
      : result.scored === 0 && result.skipped > 0
        ? "Already up to date"
        : result.status === "ai_unavailable"
          ? `Scored ${result.scored}, then AI went quiet`
          : `Scored ${result.scored}${result.skipped > 0 ? `, skipped ${result.skipped} already done` : ""}`;
  const tone: "ok" | "warn" =
    result.status === "ai_unavailable" || result.status === "disabled_by_settings" ? "warn" : "ok";
  return { summary, tone };
}
