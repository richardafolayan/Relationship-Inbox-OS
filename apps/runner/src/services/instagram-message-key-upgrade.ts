import { stableHash, type NormalizedMessage } from "@inbox-os/core";
import type { Prisma, PrismaClient } from "@prisma/client";
import { cleanMessageText } from "../platforms/utils";
import { withMessageIdentityLocks } from "./message-identity-lock";
import type { MessageIdentityReconciler } from "./message-identity-reconciliation";

const STABLE_IDENTITY_VERSION = "instagram_stable_v2";
const RECEIPT_TIMESTAMP_TOLERANCE_MS = 2 * 60 * 1000;
const FIRST_SEEN_CLOCK_SKEW_MARGIN_MS = 5 * 60 * 1000;
export const INSTAGRAM_IDENTITY_QUARANTINE_SETTING_PREFIX =
  "instagram_message_identity_quarantine_v1:";
const QUARANTINE_VERSION = 1;
const UNTRACKED_QUARANTINE_SETTING_KEY =
  `${INSTAGRAM_IDENTITY_QUARANTINE_SETTING_PREFIX}${stableHash("instagram_untracked_identity_quarantine_v1")}`;
const UNTRACKED_QUARANTINE_MESSAGE_HASH = stableHash(
  "instagram_untracked_identity_message_v1"
);

interface InstagramIdentityQuarantineState {
  version: 1;
  messageKeyHashes: string[];
}

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

export interface InstagramMessageKeyUpgradePlan {
  rekeys: InstagramMessageKeyRekey[];
  blockedCanonicalKeys: string[];
  quarantinedCanonicalKeys: string[];
}

export class InstagramMessageKeyUpgradeError extends Error {
  constructor(readonly reason: string) {
    super(`Instagram message-key upgrade failed: ${reason}`);
    this.name = "InstagramMessageKeyUpgradeError";
  }
}

function quarantineSettingKey(threadId: string): string {
  return `${INSTAGRAM_IDENTITY_QUARANTINE_SETTING_PREFIX}${stableHash(threadId)}`;
}

function messageKeyHash(platformMessageKey: string): string {
  return stableHash(platformMessageKey);
}

function quarantineToken(hash: string): string {
  return `instagram-quarantine:${hash}`;
}

function parseQuarantineState(valueJson: string): InstagramIdentityQuarantineState | null {
  try {
    const value = JSON.parse(valueJson) as Record<string, unknown>;
    if (
      value.version !== QUARANTINE_VERSION ||
      !Array.isArray(value.messageKeyHashes) ||
      value.messageKeyHashes.length === 0 ||
      value.messageKeyHashes.some(
        (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)
      )
    ) {
      return null;
    }
    return {
      version: QUARANTINE_VERSION,
      messageKeyHashes: [...new Set(value.messageKeyHashes as string[])].sort()
    };
  } catch {
    return null;
  }
}

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

async function persistQuarantineState(
  database: PrismaClient,
  threadId: string,
  messageKeyHashes: Set<string>
): Promise<void> {
  const key = quarantineSettingKey(threadId);
  if (messageKeyHashes.size === 0) {
    await database.setting.deleteMany({ where: { key } });
    return;
  }
  const state: InstagramIdentityQuarantineState = {
    version: QUARANTINE_VERSION,
    messageKeyHashes: [...messageKeyHashes].sort()
  };
  await database.setting.upsert({
    where: { key },
    update: { valueJson: JSON.stringify(state) },
    create: { key, valueJson: JSON.stringify(state) }
  });
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
  raw: Record<string, unknown>
): boolean {
  if (
    !message.timestamp ||
    message.direction !== "OUT" ||
    row.direction !== "OUT" ||
    row.sentVia !== "automation" ||
    raw.verification !== "exact_outgoing_layout_bubble"
  ) {
    return false;
  }
  return Math.abs(row.timestamp.getTime() - new Date(message.timestamp).getTime()) <=
    RECEIPT_TIMESTAMP_TOLERANCE_MS;
}

function hasDistinctTimestampEvidence(
  message: NormalizedMessage,
  row: ExistingInstagramMessageRow,
  raw: Record<string, unknown>
): boolean {
  if (!message.timestamp) return false;
  if (raw.timestampSource === "source") return true;
  const currentTimestamp = new Date(message.timestamp).getTime();
  if (
    Number.isFinite(currentTimestamp) &&
    row.timestamp.getTime() + FIRST_SEEN_CLOCK_SKEW_MARGIN_MS < currentTimestamp
  ) {
    return true;
  }
  return message.direction === "OUT" &&
    row.direction === "OUT" &&
    row.sentVia === "automation" &&
    raw.verification === "exact_outgoing_layout_bubble";
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
}): InstagramMessageKeyUpgradePlan {
  const rekeys: InstagramMessageKeyRekey[] = [];
  const blockedCanonicalKeys = new Set<string>();
  const quarantinedCanonicalKeys = new Set<string>();
  const claimedLegacyRows = new Map<string, string>();
  const ambiguousLegacyRows = new Set<string>();

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
    const unresolvedMalformedRows = parsedRows.filter(
      ({ row, raw }) =>
        row.platformMessageKey !== canonicalKey &&
        raw === null &&
        row.direction === message.direction &&
        cleanMessageText(row.text) === cleanMessageText(message.text) &&
        !hasDistinctTimestampEvidence(message, row, {})
    );
    if (unresolvedMalformedRows.length > 0) {
      quarantinedCanonicalKeys.add(canonicalKey);
      if (!canonical) blockedCanonicalKeys.add(canonicalKey);
      continue;
    }

    if (!message.timestamp) {
      if (legacyRows.length > 0) {
        quarantinedCanonicalKeys.add(canonicalKey);
        if (!canonical) blockedCanonicalKeys.add(canonicalKey);
      }
      continue;
    }

    const verified = legacyRows.filter(({ row, raw }) =>
      exactSourceTimestampMatch(message, row, raw!) ||
      verifiedReceiptMatch(message, row, raw!)
    );
    if (verified.length > 1) {
      quarantinedCanonicalKeys.add(canonicalKey);
      if (!canonical) blockedCanonicalKeys.add(canonicalKey);
      continue;
    }
    if (canonical) {
      if (
        verified.length > 0 ||
        legacyRows.some(({ row, raw }) => !hasDistinctTimestampEvidence(message, row, raw!))
      ) {
        quarantinedCanonicalKeys.add(canonicalKey);
      }
      continue;
    }
    if (verified.length === 0) {
      if (legacyRows.some(({ row, raw }) => !hasDistinctTimestampEvidence(message, row, raw!))) {
        blockedCanonicalKeys.add(canonicalKey);
        quarantinedCanonicalKeys.add(canonicalKey);
      }
      continue;
    }

    const legacy = verified[0]!.row;
    if (ambiguousLegacyRows.has(legacy.id)) {
      blockedCanonicalKeys.add(canonicalKey);
      quarantinedCanonicalKeys.add(canonicalKey);
      continue;
    }
    const priorCanonicalKey = claimedLegacyRows.get(legacy.id);
    if (priorCanonicalKey) {
      const priorIndex = rekeys.findIndex((rekey) => rekey.messageId === legacy.id);
      if (priorIndex >= 0) rekeys.splice(priorIndex, 1);
      claimedLegacyRows.delete(legacy.id);
      ambiguousLegacyRows.add(legacy.id);
      for (const key of [priorCanonicalKey, canonicalKey]) {
        blockedCanonicalKeys.add(key);
        quarantinedCanonicalKeys.add(key);
      }
      continue;
    }
    let audioTranscription: InstagramMessageKeyRekey["audioTranscription"];
    try {
      audioTranscription = transcriptionRekey(legacy, canonicalKey);
    } catch (error) {
      if (!(error instanceof InstagramMessageKeyUpgradeError)) throw error;
      blockedCanonicalKeys.add(canonicalKey);
      quarantinedCanonicalKeys.add(canonicalKey);
      continue;
    }
    claimedLegacyRows.set(legacy.id, canonicalKey);
    rekeys.push({
      threadId: input.threadId,
      messageId: legacy.id,
      fromKey: legacy.platformMessageKey,
      toKey: canonicalKey,
      audioTranscription
    });
  }

  return {
    rekeys,
    blockedCanonicalKeys: [...blockedCanonicalKeys],
    quarantinedCanonicalKeys: [...quarantinedCanonicalKeys]
  };
}

export async function applyInstagramMessageKeyUpgradePlan(
  database: Pick<PrismaClient, "$transaction">,
  plan: InstagramMessageKeyUpgradePlan
): Promise<void> {
  if (plan.rekeys.length === 0) return;
  await withMessageIdentityLocks(plan.rekeys.map((rekey) => rekey.messageId), async () => {
    await database.$transaction(async (transaction: Prisma.TransactionClient) => {
      for (const rekey of plan.rekeys) {
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
        const currentTranscription = source.audioTranscription;
        if (
          rekey.audioTranscription &&
          (currentTranscription?.id !== rekey.audioTranscription.id ||
            currentTranscription.audioFingerprint !==
              rekey.audioTranscription.fromFingerprint)
        ) {
          throw new InstagramMessageKeyUpgradeError("audio_fingerprint_upgrade_race");
        }
        if (currentTranscription) {
          const prefix = `${rekey.fromKey}|`;
          if (!currentTranscription.audioFingerprint.startsWith(prefix)) {
            throw new InstagramMessageKeyUpgradeError("unexpected_audio_fingerprint");
          }
          const toFingerprint = `${rekey.toKey}|${currentTranscription.audioFingerprint.slice(prefix.length)}`;
          await transaction.messageAudioTranscription.update({
            where: { id: currentTranscription.id },
            data: { audioFingerprint: toFingerprint }
          });
        }
        await transaction.message.update({
          where: { id: rekey.messageId },
          data: { platformMessageKey: rekey.toKey }
        });
      }
    });
  });
}

export function createInstagramMessageIdentityReconciler(
  database: PrismaClient
): MessageIdentityReconciler {
  const reconciler: MessageIdentityReconciler = async ({ threadId, currentMessages }) => {
    const stateRecord = await database.setting.findUnique({
      where: { key: quarantineSettingKey(threadId) },
      select: { valueJson: true }
    });
    const state = stateRecord ? parseQuarantineState(stateRecord.valueJson) : {
      version: QUARANTINE_VERSION,
      messageKeyHashes: []
    } satisfies InstagramIdentityQuarantineState;
    if (!state) {
      return {
        blockedMessageKeys: [],
        quarantinedMessageKeys: ["instagram-quarantine:state-corrupt"]
      };
    }

    const migrationMessages = currentMessages.filter(
      (message) => message.platformMessageKeyMigration?.scheme === "instagram_occurrence_v1"
    );
    const existingRows = migrationMessages.length > 0
      ? await database.message.findMany({
          where: { threadId },
          select: {
            id: true,
            platformMessageKey: true,
            direction: true,
            timestamp: true,
            text: true,
            rawJson: true,
            attachmentsJson: true,
            sentVia: true,
            audioTranscription: {
              select: { id: true, audioFingerprint: true }
            }
          }
        })
      : [];
    const plan = planInstagramMessageKeyUpgrades({
      threadId,
      currentMessages: migrationMessages,
      existingRows
    });
    const storedHashes = new Set(state.messageKeyHashes);
    const visibleHashes = new Set(
      migrationMessages.flatMap((message) =>
        message.platformMessageKey ? [messageKeyHash(message.platformMessageKey)] : []
      )
    );
    const quarantinedKeyByHash = new Map(
      plan.quarantinedCanonicalKeys.map((key) => [messageKeyHash(key), key])
    );
    const plannedQuarantineHashes = new Set(quarantinedKeyByHash.keys());
    const plannedRekeyHashes = new Set(plan.rekeys.map((rekey) => messageKeyHash(rekey.toKey)));
    const provisionalHashes = new Set([
      ...storedHashes,
      ...plannedQuarantineHashes,
      ...plannedRekeyHashes
    ]);
    if (!sameStringSet(storedHashes, provisionalHashes)) {
      await persistQuarantineState(database, threadId, provisionalHashes);
    }

    try {
      await applyInstagramMessageKeyUpgradePlan(database, plan);
    } catch (error) {
      if (!(error instanceof InstagramMessageKeyUpgradeError)) throw error;
      const unresolvedKeys = plan.rekeys.map((rekey) => rekey.toKey);
      return {
        blockedMessageKeys: [...new Set([...plan.blockedCanonicalKeys, ...unresolvedKeys])],
        quarantinedMessageKeys: [
          ...new Set([...plan.quarantinedCanonicalKeys, ...unresolvedKeys])
        ]
      };
    }

    const resolvedVisibleHashes = new Set(
      [...visibleHashes].filter((hash) => !plannedQuarantineHashes.has(hash))
    );
    const finalHashes = new Set(
      [...storedHashes].filter((hash) => !resolvedVisibleHashes.has(hash))
    );
    for (const hash of plannedQuarantineHashes) {
      finalHashes.add(hash);
    }
    if (!sameStringSet(provisionalHashes, finalHashes)) {
      await persistQuarantineState(database, threadId, finalHashes);
    }

    return {
      blockedMessageKeys: plan.blockedCanonicalKeys,
      quarantinedMessageKeys: [...finalHashes].map(
        (hash) => quarantinedKeyByHash.get(hash) ?? quarantineToken(hash)
      )
    };
  };

  reconciler.getOutstandingQuarantineCount = async () => {
    const records = await database.setting.findMany({
      where: { key: { startsWith: INSTAGRAM_IDENTITY_QUARANTINE_SETTING_PREFIX } },
      select: { key: true, valueJson: true }
    });
    return records.reduce((count, record) => {
      const keySuffix = record.key.slice(INSTAGRAM_IDENTITY_QUARANTINE_SETTING_PREFIX.length);
      if (!/^[a-f0-9]{64}$/.test(keySuffix)) return count + 1;
      const state = parseQuarantineState(record.valueJson);
      return count + (state ? state.messageKeyHashes.length : 1);
    }, 0);
  };

  reconciler.preserveUntrackedQuarantine = async () => {
    const state: InstagramIdentityQuarantineState = {
      version: QUARANTINE_VERSION,
      messageKeyHashes: [UNTRACKED_QUARANTINE_MESSAGE_HASH]
    };
    await database.setting.upsert({
      where: { key: UNTRACKED_QUARANTINE_SETTING_KEY },
      update: { valueJson: JSON.stringify(state) },
      create: {
        key: UNTRACKED_QUARANTINE_SETTING_KEY,
        valueJson: JSON.stringify(state)
      }
    });
  };

  return reconciler;
}
