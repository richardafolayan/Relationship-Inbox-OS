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
  whatTheyWant: string | null;
  rollingSummary: string | null;
  archivedAt: Date | null;
  category: string | null;
  updatedAt: Date;
  person: {
    id: string;
    displayName: string;
    inferredName: string | null;
    platform: PlatformName;
    avatarUrl: string | null;
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
  archivedAt: string | null;
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

export function toInboxRow(row: ShapedThreadGroupRow): ShapedThreadRow {
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
    slaCountdown: formatSlaCountdown(source.slaDueAt),
    identityWarning: row.identityWarning,
    messageCount: row.messageCount,
    category: source.category ?? null,
    archivedAt: source.archivedAt?.toISOString() ?? null
  };
}
