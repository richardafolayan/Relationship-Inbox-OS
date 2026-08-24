import type { NormalizedMessage } from "@inbox-os/core";
import type { Prisma, PrismaClient } from "@prisma/client";
import { cleanMessageText } from "../platforms/utils";

const STABLE_IDENTITY_VERSION = "instagram_stable_v2";
const RECEIPT_TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000;

export interface ExistingInstagramMessageRow {
  id: string;
  platformMessageKey: string;
  direction: "IN" | "OUT";
  timestamp: Date;
  text: string;
  rawJson: string | null;
  attachmentsJson: string | null;
  sentVia: string | null;
  audioTranscription: {
    id: string;
    audioFingerprint: string;
  } | null;
}

export interface InstagramMessageKeyRekey {
  threadId: string;
  messageId: string;
  fromKey: string;
  toKey: string;
  audioTranscription: {
    id: string;
    fromFingerprint: string;
    toFingerprint: string;
  } | null;
}

export class InstagramMessageKeyUpgradeError extends Error {
  constructor(readonly reason: string) {
    super(`Instagram message-key upgrade failed: ${reason}`);
    this.name = "InstagramMessageKeyUpgradeError";
  }
}

function parseRawJson(rawJson: string | null): Record<string, unknown> | null {
  if (!rawJson) return {};
  try {
    const value = JSON.parse(rawJson) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function currentContentKind(message: NormalizedMessage): string {
  return typeof message.raw?.contentKind === "string" ? message.raw.contentKind : "text";
}

function existingContentKind(row: ExistingInstagramMessageRow, raw: Record<string, unknown>): string {
  if (typeof raw.contentKind === "string") return raw.contentKind;
  if (!row.attachmentsJson) return "text";
  try {
    const attachments = JSON.parse(row.attachmentsJson) as Array<{ type?: unknown }>;
    const type = attachments[0]?.type;
    return typeof type === "string" ? type : "attachment";
  } catch {
    return "attachment";
  }
}

function sameSignature(
  message: NormalizedMessage,
  row: ExistingInstagramMessageRow,
  raw: Record<string, unknown>
): boolean {
  return row.direction === message.direction &&
    cleanMessageText(row.text) === cleanMessageText(message.text) &&
    existingContentKind(row, raw) === currentContentKind(message);
}

function exactSourceTimestampMatch(
  message: NormalizedMessage,
  row: ExistingInstagramMessageRow,
  raw: Record<string, unknown>
): boolean {
  if (!message.timestamp || raw.timestampSource !== "source") return false;
  return row.timestamp.toISOString() === new Date(message.timestamp).toISOString();
}

function verifiedReceiptMatch(
  message: NormalizedMessage,
  row: ExistingInstagramMessageRow,
  candidateKey: string
): boolean {
  if (
    !message.timestamp ||
    message.direction !== "OUT" ||
    row.direction !== "OUT" ||
    row.sentVia !== "automation" ||
    row.platformMessageKey !== candidateKey
  ) {
    return false;
  }
  return Math.abs(row.timestamp.getTime() - new Date(message.timestamp).getTime()) <=
    RECEIPT_TIMESTAMP_TOLERANCE_MS;
}

function transcriptionRekey(
  row: ExistingInstagramMessageRow,
  toKey: string
): InstagramMessageKeyRekey["audioTranscription"] {
  const transcription = row.audioTranscription;
  if (!transcription) return null;
  const prefix = `${row.platformMessageKey}|`;
  if (!transcription.audioFingerprint.startsWith(prefix)) {
    throw new InstagramMessageKeyUpgradeError("unexpected_audio_fingerprint");
  }
  return {
    id: transcription.id,
    fromFingerprint: transcription.audioFingerprint,
    toFingerprint: `${toKey}|${transcription.audioFingerprint.slice(prefix.length)}`
  };
}

export function planInstagramMessageKeyUpgrades(input: {
  threadId: string;
  currentMessages: NormalizedMessage[];
  existingRows: ExistingInstagramMessageRow[];
}): InstagramMessageKeyRekey[] {
  const rekeys: InstagramMessageKeyRekey[] = [];
  const claimedLegacyRows = new Set<string>();

  for (const message of input.currentMessages) {
    const migration = message.platformMessageKeyMigration;
    const canonicalKey = message.platformMessageKey;
    if (migration?.scheme !== "instagram_occurrence_v1" || !canonicalKey) continue;

    const canonical = input.existingRows.find(
      (row) => row.platformMessageKey === canonicalKey
    );
    const parsedRows = input.existingRows.map((row) => ({ row, raw: parseRawJson(row.rawJson) }));
    const legacyRows = parsedRows.filter(({ row, raw }) =>
      row.platformMessageKey !== canonicalKey &&
      raw !== null &&
      raw.messageIdentityVersion !== STABLE_IDENTITY_VERSION &&
      sameSignature(message, row, raw)
    );
    const malformedCandidate = parsedRows.some(
      ({ row, raw }) => row.platformMessageKey === migration.candidateKey && raw === null
    );
    if (malformedCandidate) {
      throw new InstagramMessageKeyUpgradeError("malformed_legacy_provenance");
    }

    if (!message.timestamp) {
      if (legacyRows.length > 0) {
        throw new InstagramMessageKeyUpgradeError("legacy_message_identity_ambiguous");
      }
      continue;
    }

    const verified = legacyRows.filter(({ row, raw }) =>
      exactSourceTimestampMatch(message, row, raw!) ||
      verifiedReceiptMatch(message, row, migration.candidateKey)
    );
    if (verified.length > 1) {
      throw new InstagramMessageKeyUpgradeError("multiple_verified_legacy_messages");
    }
    if (canonical && verified.length > 0) {
      throw new InstagramMessageKeyUpgradeError("canonical_and_legacy_message_conflict");
    }
    if (canonical || verified.length === 0) continue;

    const legacy = verified[0]!.row;
    if (claimedLegacyRows.has(legacy.id)) {
      throw new InstagramMessageKeyUpgradeError("legacy_message_claimed_twice");
    }
    claimedLegacyRows.add(legacy.id);
    rekeys.push({
      threadId: input.threadId,
      messageId: legacy.id,
      fromKey: legacy.platformMessageKey,
      toKey: canonicalKey,
      audioTranscription: transcriptionRekey(legacy, canonicalKey)
    });
  }

  return rekeys;
}

export async function applyInstagramMessageKeyUpgradePlan(
  database: Pick<PrismaClient, "$transaction">,
  plan: InstagramMessageKeyRekey[]
): Promise<void> {
  if (plan.length === 0) return;
  await database.$transaction(async (transaction: Prisma.TransactionClient) => {
    for (const rekey of plan) {
      const [source, target] = await Promise.all([
        transaction.message.findUnique({
          where: {
            threadId_platformMessageKey: {
              threadId: rekey.threadId,
              platformMessageKey: rekey.fromKey
            }
          },
          select: {
            id: true,
            platformMessageKey: true,
            audioTranscription: { select: { id: true, audioFingerprint: true } }
          }
        }),
        transaction.message.findUnique({
          where: {
            threadId_platformMessageKey: {
              threadId: rekey.threadId,
              platformMessageKey: rekey.toKey
            }
          },
          select: {
            id: true,
            platformMessageKey: true,
            audioTranscription: { select: { id: true, audioFingerprint: true } }
          }
        })
      ]);
      if (!source || source.id !== rekey.messageId || target) {
        throw new InstagramMessageKeyUpgradeError("message_key_upgrade_race");
      }
      if (rekey.audioTranscription) {
        if (
          source.audioTranscription?.id !== rekey.audioTranscription.id ||
          source.audioTranscription.audioFingerprint !==
            rekey.audioTranscription.fromFingerprint
        ) {
          throw new InstagramMessageKeyUpgradeError("audio_fingerprint_upgrade_race");
        }
        await transaction.messageAudioTranscription.update({
          where: { id: rekey.audioTranscription.id },
          data: { audioFingerprint: rekey.audioTranscription.toFingerprint }
        });
      }
      await transaction.message.update({
        where: { id: rekey.messageId },
        data: { platformMessageKey: rekey.toKey }
      });
    }
  });
}
