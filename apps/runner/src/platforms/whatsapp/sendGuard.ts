// Send guards for the WhatsApp adapter. WhatsApp's terms of service treat
// automated bulk sending harshly — accounts can be banned for patterns
// that look like spam. Three layered checks before any sendMessage call:
//
//   1. Direct-chat recipients must be saved contacts on the operator's phone
//      (rules out cold outreach, accidental fuzz tests, and most spam patterns).
//   2. Per-recipient minimum interval (default 15s, WHATSAPP_MIN_INTERVAL_MS) — derived from the
//      newest outbound Message or terminal send receipt, so the limit survives
//      process restarts and local projection failures.
//   3. Rolling-24h cap across ALL WhatsApp threads (default 40, WHATSAPP_MAX_PER_DAY) — protects
//      against a runaway loop firing dozens of messages.
//
// All three are queries / lookups, not background timers, so the guard is
// stateless from the caller's perspective and trivial to unit-test by
// stubbing the two narrow dependency interfaces below.

import { isGroupJid } from "./whatsappIdentity";

/** Narrow slice of the whatsapp-web.js Client surface we actually need. */
export interface WhatsAppContactLookup {
  getContactById(jid: string): Promise<{ isMyContact: boolean }>;
}

/** Narrow slice of the Prisma client surface we actually need. */
export interface SendGuardPrisma {
  message: {
    findFirst(args: {
      where: {
        direction: "OUT";
        thread: { platform: "WHATSAPP"; platformThreadId: string };
        timestamp: { gte: Date };
      };
      orderBy: { timestamp: "desc" };
      select: { timestamp: true };
    }): Promise<{ timestamp: Date } | null>;
    findMany(args: {
      where: {
        direction: "OUT";
        thread: { platform: "WHATSAPP" };
        timestamp: { gte: Date };
      };
      select: { platformMessageKey: true };
    }): Promise<Array<{ platformMessageKey: string }>>;
  };
  sendRequest: {
    findFirst(args: {
      where: {
        status: "SENT";
        thread: { platform: "WHATSAPP"; platformThreadId: string };
        updatedAt: { gte: Date };
      };
      orderBy: { updatedAt: "desc" };
      select: { updatedAt: true };
    }): Promise<{ updatedAt: Date } | null>;
    findMany(args: {
      where: {
        status: "SENT";
        thread: { platform: "WHATSAPP" };
        updatedAt: { gte: Date };
      };
      select: { receiptJson: true };
    }): Promise<Array<{ receiptJson: string | null }>>;
  };
}

export interface SendGuardConfig {
  /** Min ms between consecutive sends to the SAME recipient. */
  minIntervalMs: number;
  /** Max sends across ALL WhatsApp threads in a rolling 24h window. */
  dailyCap: number;
}

export type SendGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
      /**
       * When set, the denial is transient: waiting this many ms and
       * re-checking is expected to succeed. Only the per-recipient interval
       * sets this — saved-contact and daily-cap denials are not waitable.
       * Callers (the adapter send paths) use it to queue the send until the
       * interval elapses instead of surfacing an error (R-0098 / #816).
       */
      retryAfterMs?: number;
    };

export interface SendGuardDeps {
  client: WhatsAppContactLookup;
  prisma: SendGuardPrisma;
  config: SendGuardConfig;
  /** Override the clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function checkSendGuard(
  deps: SendGuardDeps,
  recipientJid: string
): Promise<SendGuardResult> {
  const now = deps.now ?? Date.now;

  // 1. Saved-contact check for direct chats. WhatsApp groups are not phone
  // contacts, so getContactById(...).isMyContact can be false for groups the
  // operator is already allowed to message.
  if (!isGroupJid(recipientJid)) {
    const contact = await deps.client.getContactById(recipientJid);
    if (!contact.isMyContact) {
      return {
        allowed: false,
        reason: "Recipient is not in your WhatsApp saved contacts"
      };
    }
  }

  // 2. Per-recipient interval. We look at the most recent OUT Message on
  //    a WhatsApp thread keyed by this JID. If no row matches the
  //    interval window, no send happened recently and we proceed.
  const intervalCutoff = new Date(now() - deps.config.minIntervalMs);
  const [recentMessage, recentReceipt] = await Promise.all([
    deps.prisma.message.findFirst({
      where: {
        direction: "OUT",
        thread: { platform: "WHATSAPP", platformThreadId: recipientJid },
        timestamp: { gte: intervalCutoff }
      },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true }
    }),
    deps.prisma.sendRequest.findFirst({
      where: {
        status: "SENT",
        thread: { platform: "WHATSAPP", platformThreadId: recipientJid },
        updatedAt: { gte: intervalCutoff }
      },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true }
    })
  ]);
  const recentAt = Math.max(
    recentMessage?.timestamp.getTime() ?? 0,
    recentReceipt?.updatedAt.getTime() ?? 0
  );
  if (recentAt > 0) {
    const elapsedMs = now() - recentAt;
    const remainingMs = Math.max(0, deps.config.minIntervalMs - elapsedMs);
    const remainingSec = Math.ceil(remainingMs / 1000);
    return {
      allowed: false,
      reason: `Per-recipient send interval not yet elapsed (${remainingSec}s remaining)`,
      retryAfterMs: remainingMs
    };
  }

  // 3. Rolling 24h cap. Counts projected outbound messages plus any terminal
  //    receipts whose Message projection is absent.
  const dayCutoff = new Date(now() - ONE_DAY_MS);
  const [messageRows, receiptRows] = await Promise.all([
    deps.prisma.message.findMany({
      where: {
        direction: "OUT",
        thread: { platform: "WHATSAPP" },
        timestamp: { gte: dayCutoff }
      },
      select: { platformMessageKey: true }
    }),
    deps.prisma.sendRequest.findMany({
      where: {
        status: "SENT",
        thread: { platform: "WHATSAPP" },
        updatedAt: { gte: dayCutoff }
      },
      select: { receiptJson: true }
    })
  ]);
  const projectedKeys = new Set(messageRows.map((row) => row.platformMessageKey));
  const unprojectedReceiptCount = receiptRows.reduce((count, row) => {
    try {
      const receipt = row.receiptJson
        ? (JSON.parse(row.receiptJson) as { platformMessageKey?: unknown })
        : null;
      return typeof receipt?.platformMessageKey === "string" &&
        projectedKeys.has(receipt.platformMessageKey)
        ? count
        : count + 1;
    } catch {
      return count + 1;
    }
  }, 0);
  const count = messageRows.length + unprojectedReceiptCount;
  if (count >= deps.config.dailyCap) {
    return {
      allowed: false,
      reason: `WhatsApp 24h send cap reached (${count}/${deps.config.dailyCap})`
    };
  }

  return { allowed: true };
}
