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
  riskLevel: "GREEN" | "AMBER" | "RED";
  riskReason: string | null;
  slaDueAt: Date | null;
  whatTheyWant: string | null;
  rollingSummary: string | null;
  updatedAt: Date;
  person: {
    id: string;
    displayName: string;
    platform: PlatformName;
  };
  _count?: {
    messages: number;
  };
}

export interface ShapedThreadRow {
  id: string;
  personId: string;
  personName: string;
  platform: PlatformName;
  preview: string;
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
}

export interface ShapedThreadGroupRow {
  source: ThreadRowSource;
  dedupeKey: string;
  messageCount: number;
  needsReply: boolean;
  identityWarning: IdentityWarning | null;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
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

function unresolvedDedupKey(row: ThreadRowSource): string {
  const threadUrlKey = clean(row.threadUrl);
  const previewKey = clean(row.lastMessagePreview);
  const timeKey = row.lastMessageAt ? row.lastMessageAt.toISOString().slice(0, 19) : "no_time";
  return `${row.platform}:unresolved:${row.personId}:${threadUrlKey}:${previewKey}:${timeKey}`;
}

function dedupeKeyForRow(row: ThreadRowSource): {
  key: string;
  identityWarning: IdentityWarning | null;
  canonicalId: string | null;
} {
  if (row.platform !== "LINKEDIN") {
    const stable = clean(row.platformThreadId) || row.id;
    return {
      key: `${row.platform}:${stable}`,
      identityWarning: null,
      canonicalId: stable
    };
  }

  const canonicalId = resolveLinkedInCanonicalId(row);
  if (canonicalId) {
    return {
      key: `LINKEDIN:${canonicalId}`,
      identityWarning: null,
      canonicalId
    };
  }

  return {
    key: unresolvedDedupKey(row),
    identityWarning: "unresolved_id",
    canonicalId: null
  };
}

function shouldPreferRow(current: ShapedThreadGroupRow, next: ShapedThreadGroupRow): boolean {
  if (next.messageCount !== current.messageCount) {
    return next.messageCount > current.messageCount;
  }
  const nextUpdated = next.source.updatedAt.getTime();
  const currentUpdated = current.source.updatedAt.getTime();
  if (nextUpdated !== currentUpdated) {
    return nextUpdated > currentUpdated;
  }
  const nextTime = next.source.lastMessageAt?.getTime() ?? 0;
  const currentTime = current.source.lastMessageAt?.getTime() ?? 0;
  if (nextTime !== currentTime) {
    return nextTime > currentTime;
  }
  return next.source.id > current.source.id;
}

function deriveNeedsReply(row: ThreadRowSource): boolean {
  if (row.lastInboundAt) {
    return !row.lastOutboundAt || row.lastInboundAt.getTime() > row.lastOutboundAt.getTime();
  }
  return row.needsReply;
}

export function shapeThreadRows(rows: ThreadRowSource[]): ShapedThreadGroupRow[] {
  const deduped = new Map<string, ShapedThreadGroupRow>();

  for (const row of rows) {
    const messageCount = row._count?.messages ?? 0;
    const identity = dedupeKeyForRow(row);
    const unresolvedZeroMessageLinkedIn =
      row.platform === "LINKEDIN" && identity.identityWarning === "unresolved_id" && messageCount <= 0;

    if (unresolvedZeroMessageLinkedIn) {
      continue;
    }

    const candidate: ShapedThreadGroupRow = {
      source: row,
      dedupeKey: identity.key,
      messageCount,
      needsReply: deriveNeedsReply(row),
      identityWarning: identity.identityWarning
    };

    const existing = deduped.get(identity.key);
    if (!existing || shouldPreferRow(existing, candidate)) {
      deduped.set(identity.key, candidate);
    }
  }

  return Array.from(deduped.values());
}

export function toInboxRow(row: ShapedThreadGroupRow): ShapedThreadRow {
  const source = row.source;
  return {
    id: source.id,
    personId: source.personId,
    personName: source.person.displayName,
    platform: source.platform,
    preview: source.lastMessagePreview ?? source.whatTheyWant ?? source.rollingSummary ?? "No summary yet",
    unreadCount: source.unreadCount,
    riskLevel: source.riskLevel,
    needsReply: row.needsReply,
    lastMessageAt: source.lastMessageAt?.toISOString() ?? null,
    lastInboundAt: source.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: source.lastOutboundAt?.toISOString() ?? null,
    riskReason: source.riskReason,
    slaCountdown: formatSlaCountdown(source.slaDueAt),
    identityWarning: row.identityWarning,
    messageCount: row.messageCount
  };
}
