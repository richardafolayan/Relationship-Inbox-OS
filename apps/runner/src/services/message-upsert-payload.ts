/**
 * Builds the prisma.message.upsert payload for the scan-queue persist pass.
 * Split out so the conditional-timestamp behavior is unit testable without
 * spinning up Prisma.
 *
 * The key invariant: when the adapter could not parse a real per-message
 * timestamp, the existing row's timestamp must be preserved on re-scrape.
 * Otherwise every scrape drifts the row forward to "now" (issue #245).
 */

export interface MessageUpsertInput {
  threadId: string;
  platformMessageKey: string;
  direction: "IN" | "OUT";
  /** Truthy when the adapter parsed a real platform timestamp. */
  adapterReportedTimestamp: boolean;
  /** Used for create; used for update only when adapterReportedTimestamp is true. */
  safeTimestamp: Date;
  text: string;
  senderName: string | null;
  attachmentsJson: string | null;
  rawJson: string | null;
}

export interface MessageUpsertPayload {
  where: {
    threadId_platformMessageKey: {
      threadId: string;
      platformMessageKey: string;
    };
  };
  update: {
    text: string;
    direction: "IN" | "OUT";
    timestamp?: Date;
    attachmentsJson: string | null;
    senderName: string | null;
    rawJson: string | null;
  };
  create: {
    threadId: string;
    platformMessageKey: string;
    direction: "IN" | "OUT";
    timestamp: Date;
    text: string;
    attachmentsJson: string | null;
    senderName: string | null;
    rawJson: string | null;
  };
}

export function buildMessageUpsertPayload(input: MessageUpsertInput): MessageUpsertPayload {
  return {
    where: {
      threadId_platformMessageKey: {
        threadId: input.threadId,
        platformMessageKey: input.platformMessageKey
      }
    },
    update: {
      text: input.text,
      direction: input.direction,
      ...(input.adapterReportedTimestamp ? { timestamp: input.safeTimestamp } : {}),
      attachmentsJson: input.attachmentsJson,
      senderName: input.senderName,
      rawJson: input.rawJson
    },
    create: {
      threadId: input.threadId,
      platformMessageKey: input.platformMessageKey,
      direction: input.direction,
      timestamp: input.safeTimestamp,
      text: input.text,
      attachmentsJson: input.attachmentsJson,
      senderName: input.senderName,
      rawJson: input.rawJson
    }
  };
}
