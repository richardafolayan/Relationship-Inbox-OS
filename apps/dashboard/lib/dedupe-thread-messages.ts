/**
 * Collapse duplicate bubbles at the final thread render boundary (#881).
 *
 * Prefer a stable platformMessageKey on every platform. Content-key fallback
 * (threadId|direction|timestamp|normalizedText) is WhatsApp-only: WA can
 * persist the same physical message under two Prisma ids when send-time and
 * scan-time keys diverge. Other platforms can legitimately repeat the same
 * text at the same timestamp, so content dedupe stays off.
 *
 * Media: placeholder / empty attachment fingerprints are ignored when matching
 * so a scrape without a real GUID still collides with the richer GUID twin.
 * Two real, different non-placeholder GUIDs stay distinct (two same-caption
 * media sends).
 */

export type DedupeThreadMessage = {
  id: string;
  platformMessageKey?: string | null;
  direction: "IN" | "OUT" | string;
  timestamp: string;
  text: string;
  senderName?: string | null;
  sentVia?: string | null;
  attachments?: Array<{
    guid?: string | null;
    kind?: string | null;
    type?: string | null;
    byteSize?: number | null;
  }> | null;
  audioTranscription?: {
    status?: string | null;
    transcript?: string | null;
  } | null;
  raw?: unknown;
  replyToMessageId?: string | null;
  replyTo?: unknown;
};

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Real media GUIDs only. Empty, missing, or placeholder metadata produce ""
 * so they do not split the content identity of the same physical message.
 */
export function realMediaFingerprint(
  attachments: DedupeThreadMessage["attachments"]
): string {
  if (!attachments || attachments.length === 0) return "";
  const guids = attachments
    .map((a) => (typeof a.guid === "string" ? a.guid.trim() : ""))
    .filter((g) => g.length > 0);
  if (guids.length === 0) return "";
  return guids.map((g) => `g:${g}`).join(",");
}

/**
 * Identity key for content-key dedupe (no media). senderName is included so
 * two group members saying the same thing in the same second stay distinct.
 */
export function threadMessageIdentityKey(
  message: DedupeThreadMessage,
  threadId = ""
): string {
  return [
    threadId,
    message.direction,
    message.timestamp,
    normalizeText(message.senderName ?? ""),
    normalizeText(message.text ?? "")
  ].join("|");
}

/**
 * Content fallback key. Media fingerprint is only real GUIDs; placeholders
 * contribute nothing so placeholder-vs-rich twins share a key when compared
 * via {@link contentKeysCollide}.
 */
export function threadMessageContentKey(
  message: DedupeThreadMessage,
  threadId = ""
): string {
  return [
    threadMessageIdentityKey(message, threadId),
    realMediaFingerprint(message.attachments)
  ].join("|");
}

/**
 * Two WhatsApp rows collide on content when identity matches and media does
 * not prove them distinct. Empty/placeholder media is a wildcard; two
 * different non-empty real GUID fingerprints do not collide.
 */
export function contentKeysCollide(
  a: DedupeThreadMessage,
  b: DedupeThreadMessage,
  threadId = ""
): boolean {
  if (threadMessageIdentityKey(a, threadId) !== threadMessageIdentityKey(b, threadId)) {
    return false;
  }
  const mediaA = realMediaFingerprint(a.attachments);
  const mediaB = realMediaFingerprint(b.attachments);
  if (!mediaA || !mediaB) return true;
  return mediaA === mediaB;
}

function richness(message: DedupeThreadMessage): number {
  let score = 0;
  if (message.platformMessageKey && message.platformMessageKey.length > 0) score += 4;
  if (message.attachments && message.attachments.length > 0) {
    score += 2;
    for (const a of message.attachments) {
      if (a.guid) score += 2;
      if (a.kind && a.kind !== "unknown") score += 1;
    }
  }
  if (message.sentVia === "automation") score += 2;
  if (message.replyToMessageId) score += 1;
  if (message.replyTo) score += 1;
  if (message.raw) score += 1;
  if (
    message.audioTranscription?.status === "transcribed" &&
    message.audioTranscription.transcript?.trim()
  ) {
    score += 3;
  }
  score += Math.min(normalizeText(message.text ?? "").length, 200) / 200;
  return score;
}

function isWhatsAppPlatform(platform?: string | null): boolean {
  return (platform ?? "").trim().toUpperCase() === "WHATSAPP";
}

/**
 * Returns messages in original order with exact duplicates removed.
 * Platform-key collisions are collapsed on every platform. Content-key
 * collisions only collapse when `platform` is WhatsApp. When two rows
 * collide, keeps the richer one (media metadata, real platform key,
 * automation tag, transcript) and drops the other.
 */
export function dedupeThreadMessages<T extends DedupeThreadMessage>(
  messages: readonly T[],
  threadId = "",
  platform?: string | null
): T[] {
  if (messages.length < 2) return messages.slice() as T[];

  const useContentDedupe = isWhatsAppPlatform(platform);
  const result: T[] = [];
  const byPlatformKey = new Map<string, number>();
  // Indices already accepted under each identity key (content path).
  const byIdentity = new Map<string, number[]>();

  for (const message of messages) {
    const platformKey = message.platformMessageKey?.trim() || "";

    let existingIdx: number | undefined;
    if (platformKey) {
      existingIdx = byPlatformKey.get(platformKey);
    }
    if (existingIdx === undefined && useContentDedupe) {
      const identity = threadMessageIdentityKey(message, threadId);
      const candidates = byIdentity.get(identity) ?? [];
      for (const idx of candidates) {
        if (contentKeysCollide(message, result[idx]!, threadId)) {
          existingIdx = idx;
          break;
        }
      }
    }

    if (existingIdx === undefined) {
      const idx = result.length;
      result.push(message);
      if (platformKey) byPlatformKey.set(platformKey, idx);
      if (useContentDedupe) {
        const identity = threadMessageIdentityKey(message, threadId);
        const list = byIdentity.get(identity) ?? [];
        list.push(idx);
        byIdentity.set(identity, list);
      }
      continue;
    }

    const existing = result[existingIdx]!;
    if (richness(message) > richness(existing)) {
      result[existingIdx] = message;
      const prevPlatform = existing.platformMessageKey?.trim() || "";
      if (prevPlatform) byPlatformKey.set(prevPlatform, existingIdx);
      if (platformKey) byPlatformKey.set(platformKey, existingIdx);
    } else if (platformKey) {
      byPlatformKey.set(platformKey, existingIdx);
    }
  }

  return result;
}
