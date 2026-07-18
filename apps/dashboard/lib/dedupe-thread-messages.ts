/**
 * Collapse duplicate bubbles at the final thread render boundary (#881).
 *
 * Prefer a stable platformMessageKey on every platform. Content-key fallback
 * (threadId|direction|timestamp|normalizedText|mediaFingerprint) is WhatsApp-
 * only: WA can persist the same physical message under two Prisma ids when
 * send-time and scan-time keys diverge. Other platforms can legitimately
 * repeat the same text at the same timestamp, so content dedupe stays off.
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

function mediaFingerprint(
  attachments: DedupeThreadMessage["attachments"]
): string {
  if (!attachments || attachments.length === 0) return "";
  return attachments
    .map((a) => {
      if (a.guid && a.guid.length > 0) return `g:${a.guid}`;
      const kind = a.kind ?? a.type ?? "unknown";
      const size = typeof a.byteSize === "number" ? String(a.byteSize) : "";
      return `k:${kind}:${size}`;
    })
    .join(",");
}

/**
 * Content fallback key. Callers that know the thread id should pass it so
 * the key matches the investigation note shape; within a single-thread list
 * it is optional. senderName is included so two group members saying the
 * same thing in the same second are not collapsed into one bubble.
 */
export function threadMessageContentKey(
  message: DedupeThreadMessage,
  threadId = ""
): string {
  return [
    threadId,
    message.direction,
    message.timestamp,
    normalizeText(message.senderName ?? ""),
    normalizeText(message.text ?? ""),
    mediaFingerprint(message.attachments)
  ].join("|");
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
  // Index into `result` for each key we have already accepted.
  const byPlatformKey = new Map<string, number>();
  const byContentKey = new Map<string, number>();

  for (const message of messages) {
    const platformKey = message.platformMessageKey?.trim() || "";
    const contentKey = useContentDedupe
      ? threadMessageContentKey(message, threadId)
      : "";

    let existingIdx: number | undefined;
    if (platformKey) {
      existingIdx = byPlatformKey.get(platformKey);
    }
    if (existingIdx === undefined && useContentDedupe) {
      existingIdx = byContentKey.get(contentKey);
    }

    if (existingIdx === undefined) {
      const idx = result.length;
      result.push(message);
      if (platformKey) byPlatformKey.set(platformKey, idx);
      if (useContentDedupe) byContentKey.set(contentKey, idx);
      continue;
    }

    const existing = result[existingIdx]!;
    if (richness(message) > richness(existing)) {
      result[existingIdx] = message;
      // Re-index so both the old and new keys resolve to the survivor.
      const prevPlatform = existing.platformMessageKey?.trim() || "";
      if (prevPlatform) byPlatformKey.set(prevPlatform, existingIdx);
      if (platformKey) byPlatformKey.set(platformKey, existingIdx);
      if (useContentDedupe) {
        byContentKey.set(threadMessageContentKey(existing, threadId), existingIdx);
        byContentKey.set(contentKey, existingIdx);
      }
    } else if (platformKey) {
      // Loser still teaches us its platform key so a third copy is caught.
      byPlatformKey.set(platformKey, existingIdx);
    }
  }

  return result;
}
