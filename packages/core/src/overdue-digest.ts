// Shared types and pure helpers for the calm overdue-reply digest (#360).
//
// Keep this module framework-free and side-effect-free. Both the runner
// (services/overdue-digest.ts) and the dashboard (lib/notifications.ts,
// Settings page) import from here so the two sides agree on the wire
// shape and the cadence rule without re-implementing either.

export type OverdueDigestCadence = "off" | "daily" | "weekly";

export interface OverdueDigestPersonMemory {
  /** Display name kept for the Settings "Snoozed" list. Stable key is personId. */
  displayName: string;
  /** ISO timestamp of the most-recent digest that actually included this person. */
  lastIncludedAt: string | null;
  /**
   * State key from the most-recent digest that included this person. Used
   * to decide whether the person's actionable state has changed since.
   * See `buildStateKey` below for the field list.
   */
  lastIncludedStateKey: string | null;
  /** ISO timestamp until which this person is excluded from digest candidates. */
  snoozedUntil: string | null;
}

export interface OverdueDigestSettings {
  cadence: OverdueDigestCadence;
  /** ISO timestamp of the most-recent digest that fired. Null until `ack`. */
  lastDigestAt: string | null;
  /**
   * Local-date (YYYY-MM-DD) the operator dismissed today's digest. Compared
   * against the client-supplied `localDate` on each tick. Cleared on the
   * next calendar day automatically (we never persist server time-zones).
   */
  dismissForLocalDate: string | null;
  /** Per-person dedupe + snooze memory, keyed by personId. */
  perPerson: Record<string, OverdueDigestPersonMemory>;
}

export const DEFAULT_OVERDUE_DIGEST_SETTINGS: OverdueDigestSettings = {
  cadence: "off",
  lastDigestAt: null,
  dismissForLocalDate: null,
  perPerson: {}
};

export interface OverdueDigestCandidate {
  personId: string;
  personName: string;
  threadId: string;
  riskLevel: "RED" | "AMBER";
  lastInboundAt: string | null;
  /**
   * Stable key over the fields that genuinely change a person's actionable
   * state: thread id, last inbound minute, risk level, closed verdict.
   * Equal keys across two consecutive sent digests trigger the dedupe rule.
   */
  stateKey: string;
}

export interface OverdueDigestTickResult {
  due: boolean;
  /** Human-readable reason "due" is false (off, not-due, dismissed, quiet, no-candidates, …). */
  reason: string;
  candidates: OverdueDigestCandidate[];
}

/**
 * Cadence due-check. Pure: takes the cadence, the last sent timestamp, the
 * client's current ISO timestamp, and the client's local date.
 *
 * - `off` is never due.
 * - `daily` is due when there's no prior digest, or the prior digest fired
 *   on a different local date than today.
 * - `weekly` is due when there's no prior digest, or the prior digest fired
 *   more than 7 days ago.
 *
 * The function ignores quiet hours and tab visibility — those gates live in
 * the dashboard scheduler because the runner has no view onto them.
 */
export function isDigestDue(
  cadence: OverdueDigestCadence,
  lastDigestAt: string | null,
  nowIso: string,
  localDate: string
): boolean {
  if (cadence === "off") return false;
  if (!lastDigestAt) return true;
  const last = Date.parse(lastDigestAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(last) || Number.isNaN(now)) return true;
  if (cadence === "daily") {
    return localDateOf(lastDigestAt) !== localDate;
  }
  // weekly
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  return now - last >= SEVEN_DAYS_MS;
}

/**
 * Extracts the YYYY-MM-DD prefix of an ISO timestamp interpreted in the
 * SAME zone the caller is using. The runner stores client-supplied local
 * dates, so the most consistent comparison is to take the date portion of
 * the persisted ISO string. This is fine because every write goes through
 * the runner which always stores ISO timestamps generated locally on the
 * dashboard's clock — the dashboard's date and the timestamp's date are in
 * the same zone.
 */
function localDateOf(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match?.[1] ?? "";
}

/**
 * Inputs the candidate-selection step needs from a thread/person row. Kept
 * deliberately narrow so the runner can build it from a thread row source
 * without dragging Prisma types into core.
 */
export interface OverdueDigestRowInput {
  threadId: string;
  personId: string;
  personName: string;
  riskLevel: "GREEN" | "AMBER" | "RED";
  needsReply: boolean;
  lastInboundAt: string | null;
  lastMessageAt: string | null;
  lastMessageDirection: "IN" | "OUT" | null;
  preview: string | null;
  whatTheyWant: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
  scheduledSendAt: string | null;
  closedStatus: "closed" | "open" | null;
}

export function buildStateKey(row: OverdueDigestRowInput): string {
  const inbound = row.lastInboundAt ? roundToMinute(row.lastInboundAt) : "none";
  const closed = row.closedStatus ?? "null";
  return `${row.personId}|${row.threadId}|${inbound}|${row.riskLevel}|${closed}`;
}

function roundToMinute(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const rounded = Math.floor(ms / 60_000) * 60_000;
  return new Date(rounded).toISOString();
}

// Deleted-placeholder handling lives in `./deleted-placeholder.ts` (added
// in #364). The scan-queue already excludes those placeholders from the
// inbound aggregate, so the digest service no longer needs its own filter.
