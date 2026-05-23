import { formatSlaCountdown, type PlatformName } from "@inbox-os/core";
import {
  isTemporaryLinkedInId,
  normalizeCanonicalLinkedInThreadId
} from "../linkedin/linkedinIdentity.js";

export type IdentityWarning = "unresolved_id";

export interface ThreadRowSource {
  id: string;
  platform: PlatformName;
  platformThreadId: string;
  threadUrl: string | null;
  personId: string;
  unreadCount: number;
  needsReply: boolean;
  lastMessagePreview: string | null;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  // Direction + text of the most-recent message regardless of sender. Used
  // to render "You: …" prefixes on outbound previews and the green/red
  // replied-vs-needs-reply indicator. Both nullable for older rows that
  // pre-date the Phase 2 schema additions.
  lastMessageDirection: "IN" | "OUT" | null;
  lastMessageText: string | null;
  riskLevel: "GREEN" | "AMBER" | "RED";
  riskReason: string | null;
  slaDueAt: Date | null;
  snoozedUntil: Date | null;
  whatTheyWant: string | null;
  rollingSummary: string | null;
  archivedAt: Date | null;
  category: string | null;
  /** "closed" | "open" | null - see Thread.closedStatus. The dashboard
   *  treats "closed" as a strong "set aside" signal even when the
   *  lightweight heuristic does not flag it. */
  closedStatus: string | null;
  /** AI reconnect-worthy score, 0-100. See Thread.reconnectScore. */
  reconnectScore: number | null;
  /** Short reason string the dashboard renders as a quiet "why" caption
   *  alongside top-ranked reconnect candidates. */
  reconnectScoreReason: string | null;
  updatedAt: Date;
  person: {
    id: string;
    displayName: string;
    inferredName: string | null;
    platform: PlatformName;
    avatarUrl: string | null;
    // Birthday synced from the operator's macOS Contacts: "MM-DD" plus an
    // optional four-digit year. Both null when no contact matched.
    birthday: string | null;
    birthYear: number | null;
  };
  _count?: {
    messages: number;
  };
}

export interface ShapedThreadRow {
  id: string;
  personId: string;
  personName: string;
  /**
   * Heuristic name guess for personas with phone/email displayNames
   * (iMessage). The dashboard shows "Maybe …" with confirm/edit/dismiss
   * actions. Null when the displayName is already a real name (LinkedIn)
   * or when no inference matched.
   */
  personInferredName: string | null;
  personAvatarUrl: string | null;
  /**
   * Birthday for this row's contact, synced from macOS Contacts: a "MM-DD"
   * string plus an optional four-digit year. Both null when no contact
   * matched. The dashboard derives the "birthday soon" badge from these.
   */
  personBirthday: string | null;
  personBirthYear: number | null;
  platform: PlatformName;
  preview: string;
  /**
   * "IN" when the latest message is from the other party, "OUT" when from
   * the operator. Drives the dashboard's "You: …" preview prefix and the
   * red/green replied-vs-needs-reply row indicator.
   */
  lastMessageDirection: "IN" | "OUT" | null;
  unreadCount: number;
  riskLevel: "GREEN" | "AMBER" | "RED";
  needsReply: boolean;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  riskReason?: string | null;
  slaCountdown: string;
  identityWarning?: IdentityWarning | null;
  messageCount: number;
  category: string | null;
  /**
   * AI-extracted one-line context, what would make a great reply or
   * what the contact is waiting on. Surfaced on Today + inbox rows as a
   * proactive nudge and used as the body of new-message notifications.
   * Null until the thread has been summarised.
   */
  whatTheyWant: string | null;
  /**
   * AI verdict on whether the conversation has wrapped up (#287 phase
   * 2.5). "closed" = last inbound is a natural endpoint and no reply
   * is owed; "open" = operator still owes a reply; null = unclassified
   * (provider unavailable on the relevant scan, or no inbound yet).
   * The dashboard treats "closed" as a strong "set aside" signal.
   */
  closedStatus: "closed" | "open" | null;
  /**
   * Reconnect-worthy score (#287 phase 3.5). 0-100 integer indicating
   * how much it makes sense to send a deliberate "hey, been a while"
   * message to this LinkedIn dormant. Null when not yet scored or the
   * AI provider was unavailable; the dashboard falls back to its
   * deterministic relationship-signal ranking in that case.
   */
  reconnectScore: number | null;
  /** Short reason for the AI score; rendered as a quiet "why" caption. */
  reconnectScoreReason: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
  /**
   * How many surviving inbox rows belong to the same person+platform.
   * 1 for the normal case; >1 when a contact has multiple distinct
   * conversations visible (typically LinkedIn recruiters pitching
   * different candidates in separate 1:1 threads). The dashboard
   * surfaces a "N threads" badge so the operator doesn't read repeat
   * names as accidental duplicates (issue #201).
   */
  personThreadCount: number;
}

export interface ShapedThreadGroupRow {
  source: ThreadRowSource;
  dedupeKey: string;
  messageCount: number;
  needsReply: boolean;
  identityWarning: IdentityWarning | null;
}

function resolveLinkedInCanonicalId(row: ThreadRowSource): string | null {
  const canonical = normalizeCanonicalLinkedInThreadId({
    platformThreadId: row.platformThreadId,
    threadUrl: row.threadUrl ?? undefined
  });
  if (!canonical || isTemporaryLinkedInId(canonical)) {
    return null;
  }
  return canonical;
}

function identityWarningForRow(row: ThreadRowSource): IdentityWarning | null {
  if (row.platform !== "LINKEDIN") {
    return null;
  }
  return resolveLinkedInCanonicalId(row) ? null : "unresolved_id";
}

function messageCountForRow(row: ThreadRowSource): number {
  return row._count?.messages ?? 0;
}

function shouldPreferSourceRow(current: ThreadRowSource, next: ThreadRowSource): boolean {
  const nextCount = messageCountForRow(next);
  const currentCount = messageCountForRow(current);
  if (nextCount !== currentCount) {
    return nextCount > currentCount;
  }
  const nextUpdated = next.updatedAt.getTime();
  const currentUpdated = current.updatedAt.getTime();
  if (nextUpdated !== currentUpdated) {
    return nextUpdated > currentUpdated;
  }
  const nextTime = next.lastMessageAt?.getTime() ?? 0;
  const currentTime = current.lastMessageAt?.getTime() ?? 0;
  if (nextTime !== currentTime) {
    return nextTime > currentTime;
  }
  return next.id > current.id;
}

function deriveNeedsReply(row: ThreadRowSource): boolean {
  if (row.lastInboundAt) {
    return !row.lastOutboundAt || row.lastInboundAt.getTime() > row.lastOutboundAt.getTime();
  }
  return row.needsReply;
}

export function shapeThreadRows(rows: ThreadRowSource[]): ShapedThreadGroupRow[] {
  const byThreadId = new Map<string, ThreadRowSource>();
  for (const row of rows) {
    const existing = byThreadId.get(row.id);
    if (!existing || shouldPreferSourceRow(existing, row)) {
      byThreadId.set(row.id, row);
    }
  }

  const deduped = new Map<string, ShapedThreadGroupRow>();

  for (const row of byThreadId.values()) {
    const messageCount = messageCountForRow(row);
    const identityWarning = identityWarningForRow(row);
    const unresolvedZeroMessageLinkedIn =
      row.platform === "LINKEDIN" && identityWarning === "unresolved_id" && messageCount <= 0;

    if (unresolvedZeroMessageLinkedIn) {
      continue;
    }

    // For iMessage we collapse threads-per-person so the same human with
    // a phone + email handle (two chat.db chats, one Person) shows as a
    // single row. The thread page merges messages from sibling threads
    // when rendering. LinkedIn keeps thread-level dedupe because separate
    // LinkedIn threads with the same person are intentional.
    const dedupeKey =
      row.platform === "IMESSAGE"
        ? `person:${row.platform}:${row.personId}`
        : `thread:${row.id}`;
    const candidate: ShapedThreadGroupRow = {
      source: row,
      dedupeKey,
      messageCount,
      needsReply: deriveNeedsReply(row),
      identityWarning
    };

    const existing = deduped.get(dedupeKey);
    if (!existing || prefersCandidate(existing, candidate)) {
      deduped.set(dedupeKey, candidate);
    }
  }

  return Array.from(deduped.values());
}

function prefersCandidate(current: ShapedThreadGroupRow, next: ShapedThreadGroupRow): boolean {
  // Pick the more-active sibling thread: highest message count, then
  // most-recent activity. Ties break deterministically on id.
  if (next.messageCount !== current.messageCount) {
    return next.messageCount > current.messageCount;
  }
  const a = next.source.lastMessageAt?.getTime() ?? 0;
  const b = current.source.lastMessageAt?.getTime() ?? 0;
  if (a !== b) return a > b;
  return next.source.id > current.source.id;
}

export function toInboxRow(
  row: ShapedThreadGroupRow,
  personThreadCount: number = 1
): ShapedThreadRow {
  const source = row.source;
  // Prefer the latest-message text (which respects direction) over the
  // legacy lastMessagePreview field (which only tracks inbound). Falls
  // through to AI-summary fields when neither is set, then a constant.
  const previewText =
    source.lastMessageText ??
    source.lastMessagePreview ??
    source.whatTheyWant ??
    source.rollingSummary ??
    "No summary yet";
  return {
    id: source.id,
    personId: source.personId,
    personName: source.person.displayName,
    personInferredName: source.person.inferredName ?? null,
    personAvatarUrl: source.person.avatarUrl ?? null,
    personBirthday: source.person.birthday ?? null,
    personBirthYear: source.person.birthYear ?? null,
    platform: source.platform,
    preview: previewText,
    lastMessageDirection: source.lastMessageDirection ?? null,
    unreadCount: source.unreadCount,
    riskLevel: source.riskLevel,
    needsReply: row.needsReply,
    lastMessageAt: source.lastMessageAt?.toISOString() ?? null,
    lastInboundAt: source.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: source.lastOutboundAt?.toISOString() ?? null,
    riskReason: source.riskReason,
    // `row.needsReply` is recomputed from lastInboundAt vs lastOutboundAt;
    // `source.slaDueAt` is the raw DB value written by the last risk scan.
    // If the operator has replied since that scan, slaDueAt is stale and
    // would render as "Overdue Xh" on a row that no longer needs a reply
    // (issue #200). Suppress the countdown when nothing is owed.
    slaCountdown: row.needsReply ? formatSlaCountdown(source.slaDueAt) : "",
    identityWarning: row.identityWarning,
    messageCount: row.messageCount,
    category: source.category ?? null,
    whatTheyWant: source.whatTheyWant ?? null,
    closedStatus: (source.closedStatus as "closed" | "open" | null) ?? null,
    reconnectScore: source.reconnectScore ?? null,
    reconnectScoreReason: source.reconnectScoreReason ?? null,
    archivedAt: source.archivedAt?.toISOString() ?? null,
    snoozedUntil: source.snoozedUntil?.toISOString() ?? null,
    personThreadCount
  };
}

// Count surviving rows per person+platform so the dashboard can flag
// rows where the same contact has multiple distinct conversations (issue
// #201). LinkedIn recruiters frequently start a separate 1:1 thread per
// candidate they pitch — these look like duplicate name rows but
// actually carry distinct content. Collapsing them would hide pitches
// the operator still needs to act on.
export function personThreadCounts(rows: ShapedThreadGroupRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.source.platform}:${row.source.personId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function personThreadCountKey(platform: PlatformName, personId: string): string {
  return `${platform}:${personId}`;
}
