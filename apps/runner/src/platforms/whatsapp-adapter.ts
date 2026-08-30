// WhatsApp adapter built on whatsapp-web.js. Conforms to PlatformAdapter
// so the rest of the runner (scan-queue, send service, session manager
// callsites) treats it the same as LinkedIn / Beta. Differences from the
// other adapters:
//
// - whatsapp-web.js spawns its own Puppeteer instance, separate from the
//   Playwright session manager used by LinkedIn / Beta. Two browsers run
//   concurrently — accepted tradeoff for the library's stability over a
//   hand-rolled Playwright integration.
// - DOM-free. The library exposes high-level Chat / Message APIs, so the
//   selectors stub in packages/core/selectors/whatsapp.json is never read.
// - Auth is QR-based, not cookie-based. ensureConnected resolves on the
//   library's "ready" event; first connection requires the operator to
//   scan a QR. Phase C wires the QR data through SSE so the dashboard
//   can render it.
// - Sends are gated by checkSendGuard — saved-contact direct chats,
//   per-recipient rate limit, rolling 24h cap.

import type {
  AttachmentPlaceholder,
  NormalizedMessage,
  OutboundAttachment,
  OutboundPoll,
  PlatformAdapter,
  PlatformName,
  PollVoteRecord,
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import type { Client, Message as WaMessage } from "whatsapp-web.js";
import { createWhatsAppClient } from "./whatsapp/client";
import { chatToThreadStub, type WhatsAppChatLike } from "./whatsapp/groupResolver";
import { checkSendGuard, type SendGuardConfig, type SendGuardPrisma } from "./whatsapp/sendGuard";
import { epochSecondsToIso } from "./whatsapp/whatsappTime";
import { isGroupJid } from "./whatsapp/whatsappIdentity";
import { mapWhatsAppKind, persistWhatsAppMedia, safeIdForFilename, type WhatsAppMessageMedia } from "./whatsapp/media";
import { copyFile, mkdir } from "node:fs/promises";
import { extname, resolve, join } from "node:path";

export interface WhatsAppAdapterDeps {
  /** Filesystem dir for the LocalAuth session (runnerConfig.profileDirs.WHATSAPP). */
  authDir: string;
  /** Filesystem dir where downloaded media is persisted (runnerConfig.whatsappMediaDir).
   *  The dashboard streams from here via /data/whatsapp-attachment/:guid. */
  mediaDir: string;
  /** Send-guard rate limits (runnerConfig.whatsappSend). */
  sendGuardConfig: SendGuardConfig;
  /** Prisma client used by the send guard for cap / interval queries. */
  prisma: SendGuardPrisma;
  /** Hook for surfacing the QR code data string to the dashboard via SSE.
   *  Phase C wires this through; null in tests / Phase B-only deployments. */
  onQr?: (qr: string) => void;
  /** Hook for transitioning the connect-state machine. Phase C uses this
   *  to drive the /platforms UI (disconnected / qr_ready / connected). */
  onStateChange?: (state: "qr_ready" | "connecting" | "connected" | "disconnected") => void;
  /**
   * Fired (fire-and-forget) when whatsapp-web.js reports a new inbound
   * message. The runner debounces these into a WhatsApp scan so new chats
   * flow into the inbox in near-real-time — the WhatsApp equivalent of the
   * iMessage chat.db watcher. Own (fromMe) messages are ignored; the runner
   * still picks those up on the next scheduled pass. Must never throw or
   * block the wweb.js event loop.
   */
  onIncomingMessage?: (input: {
    platformThreadId: string;
    sourceChangedAt: string;
  }) => void;
  /** Client factory override, for tests. */
  createClient?: (authDir: string) => Client;
  /** Sleep override so tests can fast-forward the send-guard wait. */
  sleep?: (ms: number) => Promise<void>;
}

const PLATFORM_WHATSAPP: PlatformName = "WHATSAPP";

export class WhatsAppSessionUnavailableError extends Error {
  constructor() {
    super("WhatsApp lost its connection. Reconnect it in Settings, then try again.");
    this.name = "WhatsAppSessionUnavailableError";
  }
}

export function isWhatsAppSessionUnavailableError(error: unknown): boolean {
  if (error instanceof WhatsAppSessionUnavailableError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /detached\s+frame|session closed|target closed|execution context was destroyed|adapter not connected/i.test(
    message
  );
}

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform: PlatformName = PLATFORM_WHATSAPP;
  private client: Client | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private indexedExistingChats = false;

  constructor(private readonly deps: WhatsAppAdapterDeps) {}

  /**
   * Initialise the wweb.js Client and resolve when "ready" fires (or
   * reject on auth_failure / disconnect-before-ready). Idempotent — a
   * second call returns the same in-flight promise so the connect flow
   * can be re-entered without spinning up a second Puppeteer.
   */
  async ensureConnected(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) return this.readyPromise;

    // Default factory wraps the string authDir into the options object the
    // wweb.js Client constructor expects. Tests override with a fake that
    // takes the same string arg (see runner-whatsapp-adapter.test.mjs).
    const factory =
      this.deps.createClient ?? ((authDir: string) => createWhatsAppClient({ authDir }));
    const client = factory(this.deps.authDir);
    this.client = client;
    this.deps.onStateChange?.("connecting");

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const onReady = () => {
        if (this.ready) return;
        this.ready = true;
        this.deps.onStateChange?.("connected");
        resolve();
      };
      const onAuthFailure = (msg: string) => {
        this.deps.onStateChange?.("disconnected");
        reject(new Error(`WhatsApp auth_failure: ${msg}`));
      };
      const onDisconnected = (reason: string) => {
        this.ready = false;
        this.deps.onStateChange?.("disconnected");
        if (!this.ready) reject(new Error(`WhatsApp disconnected before ready: ${reason}`));
      };

      client.on("qr", (qr: string) => {
        this.deps.onStateChange?.("qr_ready");
        this.deps.onQr?.(qr);
      });
      client.on("ready", onReady);
      client.on("auth_failure", onAuthFailure);
      client.on("disconnected", onDisconnected);

      // Near-real-time inbound. wweb.js emits "message" for messages from
      // others (not fromMe). We don't read the payload here — the hook just
      // nudges the runner to enqueue a debounced WhatsApp scan, which does
      // the real collect/persist/AI work through the same path as a
      // scheduled scan. Guarded so a listener error can never bubble into
      // the library's event loop.
      if (this.deps.onIncomingMessage) {
        const notify = this.deps.onIncomingMessage;
        client.on("message", (message: WaMessage) => {
          try {
            notify({
              platformThreadId: message.from,
              sourceChangedAt: new Date().toISOString()
            });
          } catch {
            // Fire-and-forget: never let a scan-enqueue hiccup crash the
            // wweb.js message pipeline.
          }
        });
      }

      client
        .initialize()
        .then(async () => {
          if (this.ready) return;
          // A restored session can finish syncing before whatsapp-web.js
          // attaches its one-shot hasSynced listener, so recover from the
          // missed ready event using the authoritative socket state.
          if ((await client.getState()) === "CONNECTED") {
            onReady();
          }
        })
        .catch(reject);
    });

    return this.readyPromise;
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const chats = await this.getChatsWithDetachedFrameRecovery();
    return chats.filter((c) => (c.unreadCount ?? 0) > 0).map(chatToThreadStub);
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const chats = await this.getChatsWithDetachedFrameRecovery();
    const selected = this.indexedExistingChats ? chats.slice(0, limit) : chats;
    this.indexedExistingChats = true;
    return selected.map(chatToThreadStub);
  }

  async fetchThreadById(platformThreadId: string): Promise<ThreadStub | null> {
    const chat = await this.requireClient().getChatById(platformThreadId).catch(() => null);
    return chat ? chatToThreadStub(chat) : null;
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const client = this.requireClient();
    let messages: WaMessage[];
    try {
      const chat = await client.getChatById(thread.platformThreadId);
      messages = await chat.fetchMessages({ limit });
    } catch (error) {
      if (isDetachedFrameError(error)) throw error;
      try {
        messages = await this.fetchMessagesWithoutChatHydration(
          client,
          thread.platformThreadId,
          limit
        );
      } catch {
        throw error;
      }
    }
    const isGroup = thread.isGroup ?? isGroupJid(thread.platformThreadId);
    return Promise.all(messages.map((m) => this.normaliseMessage(m, isGroup)));
  }

  async sendMessage(
    thread: ThreadStub,
    text: string,
    attachments?: OutboundAttachment[]
  ): Promise<SendReceipt> {
    const client = this.requireClient();
    await this.awaitSendClearance(thread.platformThreadId);

    // No attachments → original text-only path. wweb.js's sendMessage
    // returns the sent Message object, whose timestamp we mirror.
    const media = (attachments ?? []).filter((a) => a.absolutePath && a.absolutePath.length > 0);
    if (media.length === 0) {
      const sendStartedAt = Date.now();
      const sent = await this.resolveSendResult(
        await (client as unknown as {
          sendMessage: (
            jid: string,
            content: string,
            options: { waitUntilMsgSent: boolean }
          ) => Promise<WaMessage | null | undefined>;
        }).sendMessage(thread.platformThreadId, text, { waitUntilMsgSent: true }),
        thread.platformThreadId,
        sendStartedAt,
        text
      );
      const acknowledgedAt = new Date().toISOString();
      const verifiedBy = await this.waitForAcknowledgement(sent);
      return {
        sentAt: epochSecondsToIso(sent.timestamp) ?? new Date().toISOString(),
        acknowledgedAt,
        platformResultAt: new Date().toISOString(),
        platformMessageKey: sent.id?._serialized,
        verifiedBy
      };
    }

    // With attachments → first media gets the caption (matches WhatsApp
    // UX where you can attach a photo + type a caption in one send).
    // Remaining attachments go as separate sends without a caption so
    // we don't duplicate the text. Each call is gated by the same
    // send-guard min-interval indirectly via the rolling-24h cap; we
    // don't re-check the per-recipient interval between the media sends
    // because they're all part of one operator action.
    const sentAttachments: AttachmentPlaceholder[] = [];
    const claimedMessageIds: string[] = [];
    let firstSentTs: number | undefined;
    let firstMessageKey: string | undefined;
    let everyMessageAcknowledged = true;
    let acknowledgedAt: string | undefined;
    for (let i = 0; i < media.length; i++) {
      const a = media[i]!;
      let payload: unknown;
      try {
        // MessageMedia.fromFilePath is a static factory on the wweb.js
        // export. The dynamic require here avoids importing fs at the
        // top of the file (the helper itself does fs.readFileSync).
        const wa = (await import("whatsapp-web.js")) as unknown as {
          MessageMedia?: { fromFilePath: (path: string) => unknown };
          default?: { MessageMedia?: { fromFilePath: (path: string) => unknown } };
        };
        const MM = wa.MessageMedia ?? wa.default?.MessageMedia;
        if (!MM) throw new Error("MessageMedia export unavailable");
        payload = MM.fromFilePath(a.absolutePath);
      } catch (err) {
        throw new Error(
          `WhatsApp attachment unreadable (${a.displayName}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      // wweb.js's options bag accepts `caption` (for image/video) and
      // `sendMediaAsDocument` / `sendAudioAsVoice` flags. Voice notes
      // become PTT (push-to-talk) so the recipient sees the waveform UI.
      const opts: Record<string, unknown> = { waitUntilMsgSent: true };
      if (i === 0 && text && text.length > 0) opts.caption = text;
      if (a.kind === "voice_note") opts.sendAudioAsVoice = true;
      if (a.kind === "gif") opts.sendVideoAsGif = true;
      if (a.kind === "sticker") opts.sendMediaAsSticker = true;
      const expectedType = expectedWhatsAppTypeForOutbound(a, opts);
      const expectedMimetype = mimetypeFromMediaPayload(payload) ?? a.mimeType;
      const sendStartedAt = Date.now();
      const sent = await this.resolveSendResult(
        await (client as unknown as {
          sendMessage: (
            jid: string,
            content: unknown,
            options?: Record<string, unknown>
          ) => Promise<WaMessage | null | undefined>;
        }).sendMessage(thread.platformThreadId, payload, opts),
        thread.platformThreadId,
        sendStartedAt,
        i === 0 ? text : undefined,
        expectedType,
        {
          excludeMessageIds: claimedMessageIds,
          expectedMimetype
        }
      );
      acknowledgedAt ??= new Date().toISOString();
      const messageVerification = await this.waitForAcknowledgement(sent);
      if (messageVerification !== "platform_acknowledged") {
        everyMessageAcknowledged = false;
      }
      if (firstSentTs === undefined) firstSentTs = sent.timestamp;
      const rawGuid = sent.id?._serialized ?? "";
      if (rawGuid) claimedMessageIds.push(rawGuid);
      firstMessageKey ??= rawGuid || undefined;
      const safeGuid = rawGuid ? safeIdForFilename(rawGuid) : "";

      // Mirror the staged file under whatsappMediaDir keyed by the sent
      // message guid so the dashboard's <img>/<video> tags can stream it
      // back from the same /data/whatsapp-attachment/:guid endpoint that
      // serves inbound media. Without this copy the OUT bubble would
      // render as a download chip because the streamer can't find the
      // file in mediaDir (multer staged it elsewhere).
      if (safeGuid) {
        try {
          const ext = extname(a.absolutePath).toLowerCase() || ".bin";
          await mkdir(this.deps.mediaDir, { recursive: true });
          const dst = resolve(join(this.deps.mediaDir, `${safeGuid}${ext}`));
          await copyFile(a.absolutePath, dst);
        } catch (err) {
          console.warn(
            `[whatsapp] could not mirror outbound media for ${safeGuid}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }

      sentAttachments.push({
        type: a.mimeType ?? a.kind ?? "unknown",
        manualReview: false,
        rawLabel: a.displayName,
        kind: (a.kind as AttachmentPlaceholder["kind"]) ?? "unknown",
        // The wweb.js message guid is the stable id the dashboard uses
        // to fetch the file from /data/whatsapp-attachment/:guid. We
        // sanitise it through safeIdForFilename so the streamer's
        // readdir prefix-match finds it.
        guid: safeGuid || undefined
      });
    }
    return {
      sentAt:
        epochSecondsToIso(firstSentTs ?? Math.floor(Date.now() / 1000)) ??
        new Date().toISOString(),
      acknowledgedAt,
      platformResultAt: new Date().toISOString(),
      platformMessageKey: firstMessageKey,
      verifiedBy: everyMessageAcknowledged ? "platform_acknowledged" : "best_effort",
      attachments: sentAttachments
    };
  }

  async sendPoll(thread: ThreadStub, poll: OutboundPoll): Promise<SendReceipt> {
    const client = this.requireClient();
    await this.awaitSendClearance(thread.platformThreadId);

    const question = poll.question.trim();
    const options = poll.options.map((option) => option.trim()).filter(Boolean);
    if (!question || options.length < 2) {
      throw new Error("WhatsApp poll needs a question and at least two options");
    }

    const wa = (await import("whatsapp-web.js")) as unknown as {
      Poll?: new (
        pollName: string,
        pollOptions: string[],
        options?: { allowMultipleAnswers?: boolean }
      ) => unknown;
      default?: {
        Poll?: new (
          pollName: string,
          pollOptions: string[],
          options?: { allowMultipleAnswers?: boolean }
        ) => unknown;
      };
    };
    const Poll = wa.Poll ?? wa.default?.Poll;
    if (!Poll) throw new Error("Poll export unavailable");
    const payload = new Poll(question, options, {
      allowMultipleAnswers: Boolean(poll.allowMultipleAnswers)
    });
    const sendStartedAt = Date.now();
    const sent = await this.resolveSendResult(
      await (client as unknown as {
        sendMessage: (
          jid: string,
          content: unknown,
          options: { waitUntilMsgSent: boolean }
        ) => Promise<WaMessage | null | undefined>;
      }).sendMessage(thread.platformThreadId, payload, { waitUntilMsgSent: true }),
      thread.platformThreadId,
      sendStartedAt,
      undefined,
      "poll_creation"
    );
    const acknowledgedAt = new Date().toISOString();
    const verifiedBy = await this.waitForAcknowledgement(sent);
    const structuredPoll: WhatsAppPollPayload = {
      question,
      options: options.map((name) => ({ name })),
      allowMultipleAnswers: Boolean(poll.allowMultipleAnswers)
    };
    return {
      sentAt: epochSecondsToIso(sent.timestamp) ?? new Date().toISOString(),
      acknowledgedAt,
      platformResultAt: new Date().toISOString(),
      platformMessageKey: sent.id?._serialized,
      verifiedBy,
      attachments: [
        {
          type: "poll",
          manualReview: false,
          rawLabel: question,
          kind: "poll"
        }
      ],
      raw: { whatsapp: { poll: structuredPoll } }
    };
  }

  /**
   * No-op for WhatsApp — wweb.js doesn't have a per-thread "open" concept
   * the way LinkedIn does (no focused tab to bring forward). The send /
   * fetch APIs operate by JID directly.
   */
  async openThread(_thread: ThreadStub): Promise<void> {
    return;
  }

  private async waitForAcknowledgement(
    sent: Pick<WaMessage, "ack" | "id">
  ): Promise<SendReceipt["verifiedBy"]> {
    const currentAck = Number(sent.ack);
    if (currentAck < 0) {
      throw new Error("WhatsApp reported a failed platform acknowledgement");
    }
    if (currentAck >= 1) {
      return "platform_acknowledged";
    }

    const messageId = sent.id?._serialized;
    if (!messageId) return "best_effort";
    const client = this.requireClient();

    return new Promise<SendReceipt["verifiedBy"]>((resolve, reject) => {
      let settled = false;
      const finish = (result: SendReceipt["verifiedBy"], error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener("message_ack", onAck);
        if (error) reject(error);
        else resolve(result);
      };
      const onAck = (message: WaMessage, ack: number): void => {
        if (message.id?._serialized !== messageId) return;
        if (ack < 0) {
          finish("best_effort", new Error("WhatsApp reported a failed platform acknowledgement"));
        } else if (ack >= 1) {
          finish("platform_acknowledged");
        }
      };
      const timer = setTimeout(() => finish("best_effort"), 5_000);
      timer.unref?.();
      client.on("message_ack", onAck);
    });
  }

  private async resolveSendResult(
    sent: WaMessage | null | undefined,
    chatId: string,
    sendStartedAt: number,
    expectedText?: string,
    expectedType?: string,
    recovery?: {
      excludeMessageIds?: readonly string[];
      expectedMimetype?: string;
    }
  ): Promise<WaMessage> {
    if (sent) return sent;

    const client = this.requireClient();
    if (client.pupPage) {
      try {
        const excludeMessageIds = [...(recovery?.excludeMessageIds ?? [])];
        const expectedMimetype = recovery?.expectedMimetype;
        const model = await client.pupPage.evaluate(
          async (
            targetChatId,
            earliestTimestamp,
            targetText,
            targetType,
            excludedIds,
            targetMimetype
          ) => {
            type BrowserMessage = {
              id?: { fromMe?: boolean; _serialized?: string; toString?: () => string };
              t?: number;
              body?: string;
              type?: string;
              mimetype?: string;
            };
            type BrowserChat = {
              msgs: { getModelsArray: () => BrowserMessage[] };
            };
            type BrowserWindow = typeof globalThis & {
              WWebJS: {
                getChat: (
                  id: string,
                  options: { getAsModel: false }
                ) => Promise<BrowserChat | null>;
                getMessageModel: (message: BrowserMessage) => unknown;
              };
            };

            const normalizeMime = (value: string): string =>
              value.split(";")[0]?.trim().toLowerCase() ?? "";
            const excluded = new Set(excludedIds ?? []);
            const browserWindow = globalThis as BrowserWindow;
            const chat = await browserWindow.WWebJS.getChat(targetChatId, {
              getAsModel: false
            });
            if (!chat) return null;
            const match = chat.msgs
              .getModelsArray()
              .filter((message) => {
                if (message.id?.fromMe !== true) return false;
                if (Number(message.t ?? 0) < earliestTimestamp) return false;
                const serializedId =
                  message.id?._serialized ??
                  (typeof message.id?.toString === "function" ? message.id.toString() : "");
                if (serializedId && excluded.has(serializedId)) return false;
                if (targetText !== undefined && message.body !== targetText) return false;
                if (targetType !== undefined && message.type !== targetType) return false;
                // Fail closed: when we know the expected mimetype, reject
                // candidates that omit it or differ. Missing comparison data
                // must not count as a match for delivery confirmation.
                if (targetMimetype !== undefined) {
                  if (!message.mimetype) return false;
                  if (normalizeMime(message.mimetype) !== normalizeMime(targetMimetype)) {
                    return false;
                  }
                }
                return true;
              })
              .sort((a, b) => Number(b.t ?? 0) - Number(a.t ?? 0))[0];
            if (!match) return null;
            const model = browserWindow.WWebJS.getMessageModel(match) as {
              id?: { _serialized?: string };
            };
            const serializedId =
              match.id?._serialized ??
              (typeof match.id?.toString === "function" ? match.id.toString() : undefined);
            if (serializedId && !model.id?._serialized) {
              model.id = { ...model.id, _serialized: serializedId };
            }
            return model;
          },
          chatId,
          Math.floor(sendStartedAt / 1000) - 2,
          expectedText,
          expectedType,
          excludeMessageIds,
          expectedMimetype
        );
        if (model) {
          const whatsapp = (await import("whatsapp-web.js")) as unknown as {
            Message?: new (messageClient: Client, data: unknown) => WaMessage;
            default?: {
              Message?: new (messageClient: Client, data: unknown) => WaMessage;
            };
          };
          const Message = whatsapp.Message ?? whatsapp.default?.Message;
          if (Message) return new Message(client, model);
        }
      } catch {
        // Fall through to the delivery-uncertain error.
      }
    }

    throw new Error(
      "WhatsApp delivery could not be confirmed because the send returned no message result"
    );
  }

  async voteOnPoll(
    _thread: ThreadStub,
    platformMessageKey: string,
    selectedOptions: string[]
  ): Promise<void> {
    try {
      const client = this.requireClient();
      const message = await (client as unknown as {
        getMessageById: (messageId: string) => Promise<{ type?: string; vote?: (selectedOptions: string[]) => Promise<void> } | null>;
      }).getMessageById(platformMessageKey);
      if (!message || message.type !== "poll_creation" || typeof message.vote !== "function") {
        throw new Error("WhatsApp poll vote failed: poll message not found");
      }
      await message.vote(selectedOptions);
    } catch (error) {
      await this.rethrowPollSessionFailure(error);
    }
  }

  /**
   * Live poll tallies for the dashboard's "View votes" affordance
   * (R-0100 / #818). Read-only: fetches the poll message from the wweb.js
   * store and maps its PollVote records, resolving voter display names
   * best-effort (a failed contact lookup falls back to the bare JID).
   * Fetched on demand because tallies mutate continuously — persisted
   * counts would be stale within minutes (see normaliseMessage note).
   */
  async getPollVotes(
    _thread: ThreadStub,
    platformMessageKey: string
  ): Promise<PollVoteRecord[]> {
    try {
      const client = this.requireClient();
      const message = await (client as unknown as {
        getMessageById: (messageId: string) => Promise<{
          type?: string;
          getPollVotes?: () => Promise<
            Array<{
              voter?: string;
              selectedOptions?: Array<{ name?: string } | null>;
              interractedAtTs?: number;
            }>
          >;
        } | null>;
      }).getMessageById(platformMessageKey);
      if (!message || message.type !== "poll_creation" || typeof message.getPollVotes !== "function") {
        throw new Error("WhatsApp poll votes unavailable: poll message not found");
      }
      const votes = await message.getPollVotes();
      const myId =
        (client as unknown as { info?: { wid?: { _serialized?: string } } }).info?.wid
          ?._serialized ?? null;
      return await Promise.all(
        votes.map(async (vote) => {
          const voterId = vote.voter ?? "";
          let voterName: string | null = null;
          if (voterId) {
            try {
              const contact = await client.getContactById(voterId);
              voterName = contact.pushname || contact.name || null;
            } catch (error) {
              // Session detach/closed must not be treated as an unknown contact.
              if (isWhatsAppSessionUnavailableError(error)) throw error;
              // Left-the-group / unknown voters keep the bare JID.
            }
          }
          return {
            voterId,
            voterName,
            isMe: myId !== null && voterId === myId,
            selectedOptions: (vote.selectedOptions ?? [])
              .map((option) => (option?.name ?? "").trim())
              .filter((name) => name.length > 0),
            votedAt:
              typeof vote.interractedAtTs === "number" && Number.isFinite(vote.interractedAtTs)
                ? new Date(vote.interractedAtTs).toISOString()
                : null
          };
        })
      );
    } catch (error) {
      return this.rethrowPollSessionFailure(error);
    }
  }

  async closeSession(_reason?: string): Promise<void> {
    // Always clear in-memory state and emit the disconnected transition,
    // even when this.client is null. The previous guard meant a "stuck"
    // mid-connect (where Puppeteer launched, errored, but the cached
    // readyPromise was never resolved/rejected) couldn't be reset by
    // /control/whatsapp/disconnect — calling closeSession was a no-op
    // because this.client wasn't set yet, so subsequent /connect calls
    // saw a "connecting" state and short-circuited via the alreadyInFlight
    // guard. Operator was effectively locked out until a runner restart.
    const client = this.client;
    this.client = null;
    this.ready = false;
    this.readyPromise = null;
    if (client) {
      try {
        await client.destroy();
      } catch (error) {
        console.warn(
          `[whatsapp] client.destroy() failed (continuing teardown): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    this.deps.onStateChange?.("disconnected");
  }

  // --- internals ---

  /**
   * Run the send guard, and when the only obstacle is the per-recipient
   * interval, wait it out and re-check instead of failing the send
   * (R-0098 / #816: the operator expects a quick follow-up to queue, not
   * error). Non-waitable denials (unsaved contact, daily cap) still throw
   * immediately. Total wait is bounded to one interval window plus slack —
   * the direct send-poll HTTP route sits behind Next's 30s proxy timeout,
   * and a second re-arm mid-wait means something else is actively sending
   * to this recipient, which should surface rather than stack waits.
   */
  private async awaitSendClearance(recipientJid: string): Promise<void> {
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + this.deps.sendGuardConfig.minIntervalMs + 10_000;
    const maxWaits = 2;
    for (let waits = 0; ; waits += 1) {
      const guard = await checkSendGuard(
        {
          client: this.requireClient(),
          prisma: this.deps.prisma,
          config: this.deps.sendGuardConfig
        },
        recipientJid
      );
      if (guard.allowed) return;
      if (guard.retryAfterMs === undefined) {
        throw new Error(`WhatsApp send blocked: ${guard.reason}`);
      }
      // +250ms so the re-check lands after the interval boundary, not on it.
      const waitMs = guard.retryAfterMs + 250;
      if (waits >= maxWaits || Date.now() + waitMs > deadline) {
        throw new Error(`WhatsApp send blocked: ${guard.reason}`);
      }
      await sleep(waitMs);
    }
  }

  private requireClient(): Client {
    if (!this.client || !this.ready) {
      throw new Error("WhatsApp adapter not connected — call ensureConnected() first");
    }
    return this.client;
  }

  private async getChatsWithDetachedFrameRecovery(): Promise<WhatsAppChatLike[]> {
    const getChats = async (): Promise<WhatsAppChatLike[]> => {
      const client = this.requireClient();
      try {
        return await client.getChats();
      } catch (error) {
        if (isDetachedFrameError(error)) throw error;
        try {
          return await this.getLightweightChatSnapshots(client);
        } catch {
          throw error;
        }
      }
    };

    try {
      return await getChats();
    } catch (error) {
      if (!isDetachedFrameError(error)) {
        throw error;
      }
    }

    await this.closeSession("detached_frame");
    await this.ensureConnected();
    return getChats();
  }

  private async getLightweightChatSnapshots(client: Client): Promise<WhatsAppChatLike[]> {
    if (!client.pupPage) throw new Error("WhatsApp browser page unavailable");

    return client.pupPage.evaluate(() => {
      type BrowserChat = {
        id?: { _serialized?: string };
        __x_id?: { _serialized?: string };
        name?: string;
        __x_name?: string;
        formattedTitle?: string;
        __x_formattedTitle?: string;
        unreadCount?: number;
        __x_unreadCount?: number;
        timestamp?: number;
        t?: number;
        __x_t?: number;
        isGroup?: boolean;
        groupMetadata?: unknown;
        lastMessage?: { body?: string } | null;
        __x_lastMessage?: { body?: string } | null;
      };
      type BrowserWindow = typeof globalThis & {
        require: (moduleName: string) => {
          Chat: { getModelsArray: () => BrowserChat[] };
        };
      };

      const browserWindow = globalThis as BrowserWindow;
      const chats = browserWindow.require("WAWebCollections").Chat.getModelsArray();
      const snapshots: Array<{
        id: { _serialized: string };
        name?: string;
        isGroup: boolean;
        unreadCount: number;
        timestamp?: number;
        lastMessage: { body?: string } | null;
      }> = [];

      for (const chat of chats) {
        try {
          const id = chat.id?._serialized ?? chat.__x_id?._serialized;
          if (!id) continue;
          const timestamp = Number(chat.timestamp ?? chat.t ?? chat.__x_t);
          snapshots.push({
            id: { _serialized: id },
            name:
              chat.name ??
              chat.__x_name ??
              chat.formattedTitle ??
              chat.__x_formattedTitle,
            isGroup: Boolean(chat.isGroup ?? chat.groupMetadata) || id.endsWith("@g.us"),
            unreadCount: Number(chat.unreadCount ?? chat.__x_unreadCount ?? 0),
            timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined,
            lastMessage: chat.lastMessage ?? chat.__x_lastMessage ?? null
          });
        } catch {
          continue;
        }
      }

      return snapshots;
    });
  }

  private async fetchMessagesWithoutChatHydration(
    client: Client,
    chatId: string,
    limit: number
  ): Promise<WaMessage[]> {
    if (!client.pupPage) throw new Error("WhatsApp browser page unavailable");

    const models = await client.pupPage.evaluate(
      async (targetChatId, requestedLimit) => {
        type BrowserMessage = {
          id?: { fromMe?: boolean; _serialized?: string; toString?: () => string };
          isNotification?: boolean;
          t?: number;
        };
        type BrowserChat = {
          msgs: { getModelsArray: () => BrowserMessage[] };
        };
        type BrowserWindow = typeof globalThis & {
          WWebJS: {
            getChat: (
              id: string,
              options: { getAsModel: false }
            ) => Promise<BrowserChat | null>;
            getMessageModel: (message: BrowserMessage) => unknown;
          };
          require: (moduleName: string) => {
            loadEarlierMsgs: (input: { chat: BrowserChat }) => Promise<BrowserMessage[] | null>;
          };
        };

        const browserWindow = globalThis as BrowserWindow;
        const chat = await browserWindow.WWebJS.getChat(targetChatId, {
          getAsModel: false
        });
        if (!chat) return [];
        const include = (message: BrowserMessage): boolean => !message.isNotification;
        let messages = chat.msgs.getModelsArray().filter(include);

        if (requestedLimit > 0) {
          while (messages.length < requestedLimit) {
            const loaded = await browserWindow
              .require("WAWebChatLoadMessages")
              .loadEarlierMsgs({ chat });
            if (!loaded?.length) break;
            messages = [...loaded.filter(include), ...messages];
          }
          if (messages.length > requestedLimit) {
            messages.sort((a, b) => Number(a.t ?? 0) - Number(b.t ?? 0));
            messages = messages.slice(messages.length - requestedLimit);
          }
        }

        return messages.map((message) => {
          const model = browserWindow.WWebJS.getMessageModel(message) as {
            id?: { _serialized?: string };
          };
          const serializedId =
            message.id?._serialized ??
            (typeof message.id?.toString === "function" ? message.id.toString() : undefined);
          if (serializedId && !model.id?._serialized) {
            model.id = { ...model.id, _serialized: serializedId };
          }
          return model;
        });
      },
      chatId,
      limit
    );

    const whatsapp = (await import("whatsapp-web.js")) as unknown as {
      Message?: new (messageClient: Client, data: unknown) => WaMessage;
      default?: {
        Message?: new (messageClient: Client, data: unknown) => WaMessage;
      };
    };
    const Message = whatsapp.Message ?? whatsapp.default?.Message;
    if (!Message) throw new Error("WhatsApp Message export unavailable");
    return models.map((model) => new Message(client, model));
  }

  private async rethrowPollSessionFailure(error: unknown): Promise<never> {
    if (!isWhatsAppSessionUnavailableError(error)) {
      throw error;
    }
    await this.closeSession("poll_session_unavailable");
    throw new WhatsAppSessionUnavailableError();
  }

  private async normaliseMessage(msg: WaMessage, isGroup: boolean): Promise<NormalizedMessage> {
    // Polls (`poll_creation` type) get flattened to a readable question +
    // bullet list so they appear inline in the thread timeline rather
    // than as empty rows. Vote tallies are not fetched — they require an
    // extra `getPollVotes()` call per poll and mutate continuously after
    // capture, so any persisted count is stale within minutes. Surfacing
    // live tallies is queued as a follow-up.
    // Cast: wweb.js's .d.ts declares pollOptions: string[] but at runtime
    // each option is { name, localId } (see Message.js:329-331 in the
    // installed library). Our renderer needs the runtime shape.
    const poll = extractPollPayload(msg as unknown as WaTextMessageLike);
    const text = renderMessageText(msg as unknown as WaTextMessageLike);
    let senderName: string | undefined;
    if (isGroup && !msg.fromMe && msg.author && this.client) {
      try {
        const contact = await this.client.getContactById(msg.author);
        senderName = contact.pushname || contact.name || undefined;
      } catch {
        // Contact lookup can fail for left-the-group authors — leave undefined.
      }
    }

    // Media (images, videos, GIFs, voice notes, stickers, documents)
    // gets downloaded to disk on first sight so the dashboard can stream
    // the file inline. We swallow download failures — wweb.js can fail
    // on expired media on the recipient side, and that's not actionable
    // by the operator. The message still lands with a "[media]"
    // placeholder text so the timeline shows something.
    const attachments: AttachmentPlaceholder[] = [];
    if (msg.hasMedia) {
      const rawId = msg.id?._serialized ?? "";
      const kind = mapWhatsAppKind(msg.type, { isGif: Boolean((msg as unknown as { isGif?: boolean }).isGif) });
      try {
        const media = (await msg.downloadMedia()) as unknown as WhatsAppMessageMedia | undefined;
        if (media && media.data && media.mimetype && rawId) {
          const meta = await persistWhatsAppMedia(rawId, media, {
            mediaDir: this.deps.mediaDir
          });
          attachments.push({
            type: meta.mimetype,
            manualReview: false,
            rawLabel: media.filename ?? undefined,
            guid: meta.guid,
            kind,
            byteSize: meta.byteSize
          });
        } else if (rawId) {
          // Couldn't download (expired / not RESOLVED) — still record a
          // placeholder so the UI can render a chip pointing at the kind.
          attachments.push({
            type: msg.type ?? "unknown",
            manualReview: true,
            kind
          });
        }
      } catch (err) {
        console.warn(
          `[whatsapp] media download failed for ${rawId}: ${err instanceof Error ? err.message : String(err)}`
        );
        attachments.push({
          type: msg.type ?? "unknown",
          manualReview: true,
          kind
        });
      }
    }

    if (poll) {
      attachments.push({
        type: "poll",
        manualReview: false,
        rawLabel: poll.question || "Poll",
        kind: "poll"
      });
    }

    return {
      platformMessageKey: msg.id?._serialized,
      direction: msg.fromMe ? "OUT" : "IN",
      timestamp: epochSecondsToIso(msg.timestamp) ?? new Date().toISOString(),
      text,
      senderName,
      raw: poll ? { whatsapp: { poll } } : undefined,
      attachments
    };
  }
}

function isDetachedFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /detached\s+frame/i.test(message);
}

function mimetypeFromMediaPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const mimetype = (payload as { mimetype?: unknown }).mimetype;
  return typeof mimetype === "string" && mimetype.length > 0 ? mimetype : undefined;
}

/**
 * Map an outbound attachment to the wweb.js message `type` we expect the
 * chat store to show after send. Used to scope send-result recovery so a
 * later attachment in a multi-send cannot claim an earlier one.
 */
export function expectedWhatsAppTypeForOutbound(
  attachment: Pick<OutboundAttachment, "kind" | "mimeType">,
  opts: Record<string, unknown> = {}
): string | undefined {
  if (opts.sendMediaAsSticker === true || attachment.kind === "sticker") return "sticker";
  if (opts.sendAudioAsVoice === true || attachment.kind === "voice_note") return "ptt";
  if (attachment.kind === "photo") return "image";
  if (attachment.kind === "video" || attachment.kind === "gif" || opts.sendVideoAsGif === true) {
    return "video";
  }
  if (attachment.kind === "audio") return "audio";
  if (attachment.kind === "pdf") return "document";

  const mime = (attachment.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.length > 0) return "document";
  return undefined;
}

/**
 * Subset of the wweb.js Message shape we read for text rendering.
 * Defined narrowly so the helper is unit-testable without dragging in
 * the full Message class (which carries the Puppeteer client reference).
 */
interface WaTextMessageLike {
  body?: string;
  hasMedia?: boolean;
  type?: string;
  pollName?: string;
  pollOptions?: ReadonlyArray<{ name?: string }>;
  allowMultipleAnswers?: boolean;
}

export interface WhatsAppPollPayload {
  question: string;
  options: Array<{ name: string }>;
  allowMultipleAnswers: boolean;
}

export function extractPollPayload(msg: WaTextMessageLike): WhatsAppPollPayload | null {
  if (msg.type !== "poll_creation") return null;
  const options = (msg.pollOptions ?? [])
    .map((option) => ({ name: (option?.name ?? "").trim() }))
    .filter((option) => option.name.length > 0);
  return {
    question: (msg.pollName ?? "").trim(),
    options,
    allowMultipleAnswers: Boolean(msg.allowMultipleAnswers)
  };
}

/**
 * Flatten any wweb.js Message into the single text string we persist on
 * Message.text. Polls become a readable question + bullet list so the
 * thread timeline shows what was asked rather than an empty bubble; media
 * messages become a "[media]" placeholder. Plain text passes through
 * unchanged.
 */
export function renderMessageText(msg: WaTextMessageLike): string {
  const poll = extractPollPayload(msg);
  if (poll) {
    return renderPollText(poll);
  }
  if (msg.body && msg.body.length > 0) return msg.body;
  if (msg.hasMedia) return "[media]";
  return "";
}

export function renderPollText(poll: WhatsAppPollPayload): string {
  const options = poll.options
    .map((o) => o.name)
    .map((name) => `• ${name}`)
    .join("\n");
  const header = poll.allowMultipleAnswers ? "📊 Poll (multi-select)" : "📊 Poll";
  const body = poll.question.length > 0 ? `${header}: ${poll.question}` : header;
  return options.length > 0 ? `${body}\n${options}` : body;
}
