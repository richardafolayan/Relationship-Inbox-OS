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
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import type { Client, Message as WaMessage } from "whatsapp-web.js";
import { createWhatsAppClient } from "./whatsapp/client";
import { chatToThreadStub } from "./whatsapp/groupResolver";
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
  onIncomingMessage?: () => void;
  /** Client factory override, for tests. */
  createClient?: (authDir: string) => Client;
}

const PLATFORM_WHATSAPP: PlatformName = "WHATSAPP";

export class WhatsAppAdapter implements PlatformAdapter {
  readonly platform: PlatformName = PLATFORM_WHATSAPP;
  private client: Client | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;

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
        client.on("message", () => {
          try {
            notify();
          } catch {
            // Fire-and-forget: never let a scan-enqueue hiccup crash the
            // wweb.js message pipeline.
          }
        });
      }

      // initialize() drives the auth flow; it won't resolve on its own —
      // we wait for the "ready" event above. Errors from initialize()
      // itself (e.g. Puppeteer launch failure) bubble up via reject.
      client.initialize().catch(reject);
    });

    return this.readyPromise;
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const chats = await this.requireClient().getChats();
    return chats.filter((c) => (c.unreadCount ?? 0) > 0).map(chatToThreadStub);
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const chats = await this.requireClient().getChats();
    // Chats arrive ordered by most-recent activity from wweb.js.
    return chats.slice(0, limit).map(chatToThreadStub);
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const client = this.requireClient();
    const chat = await client.getChatById(thread.platformThreadId);
    const messages = await chat.fetchMessages({ limit });
    const isGroup = thread.isGroup ?? isGroupJid(thread.platformThreadId);
    return Promise.all(messages.map((m) => this.normaliseMessage(m, isGroup)));
  }

  async sendMessage(
    thread: ThreadStub,
    text: string,
    attachments?: OutboundAttachment[]
  ): Promise<SendReceipt> {
    const client = this.requireClient();
    const guard = await checkSendGuard(
      {
        client,
        prisma: this.deps.prisma,
        config: this.deps.sendGuardConfig
      },
      thread.platformThreadId
    );
    if (!guard.allowed) {
      throw new Error(`WhatsApp send blocked: ${guard.reason}`);
    }

    // No attachments → original text-only path. wweb.js's sendMessage
    // returns the sent Message object, whose timestamp we mirror.
    const media = (attachments ?? []).filter((a) => a.absolutePath && a.absolutePath.length > 0);
    if (media.length === 0) {
      const sent = await client.sendMessage(thread.platformThreadId, text);
      return {
        sentAt: epochSecondsToIso(sent.timestamp) ?? new Date().toISOString(),
        verifiedBy: "best_effort"
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
    let firstSentTs: number | undefined;
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
      const opts: Record<string, unknown> = {};
      if (i === 0 && text && text.length > 0) opts.caption = text;
      if (a.kind === "voice_note") opts.sendAudioAsVoice = true;
      if (a.kind === "gif") opts.sendVideoAsGif = true;
      if (a.kind === "sticker") opts.sendMediaAsSticker = true;
      const sent = await (client as unknown as {
        sendMessage: (jid: string, content: unknown, options?: Record<string, unknown>) => Promise<{ timestamp: number; id: { _serialized: string } }>;
      }).sendMessage(thread.platformThreadId, payload, opts);
      if (firstSentTs === undefined) firstSentTs = sent.timestamp;
      const rawGuid = sent.id?._serialized ?? "";
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
      verifiedBy: "best_effort",
      attachments: sentAttachments
    };
  }

  async sendPoll(thread: ThreadStub, poll: OutboundPoll): Promise<SendReceipt> {
    const client = this.requireClient();
    const guard = await checkSendGuard(
      {
        client,
        prisma: this.deps.prisma,
        config: this.deps.sendGuardConfig
      },
      thread.platformThreadId
    );
    if (!guard.allowed) {
      throw new Error(`WhatsApp send blocked: ${guard.reason}`);
    }

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
    const sent = await (client as unknown as {
      sendMessage: (jid: string, content: unknown) => Promise<{ timestamp: number; id?: { _serialized?: string } }>;
    }).sendMessage(thread.platformThreadId, payload);
    const structuredPoll: WhatsAppPollPayload = {
      question,
      options: options.map((name) => ({ name })),
      allowMultipleAnswers: Boolean(poll.allowMultipleAnswers)
    };
    return {
      sentAt: epochSecondsToIso(sent.timestamp) ?? new Date().toISOString(),
      platformMessageKey: sent.id?._serialized,
      verifiedBy: "best_effort",
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

  async voteOnPoll(
    _thread: ThreadStub,
    platformMessageKey: string,
    selectedOptions: string[]
  ): Promise<void> {
    const client = this.requireClient();
    const message = await (client as unknown as {
      getMessageById: (messageId: string) => Promise<{ type?: string; vote?: (selectedOptions: string[]) => Promise<void> } | null>;
    }).getMessageById(platformMessageKey);
    if (!message || message.type !== "poll_creation" || typeof message.vote !== "function") {
      throw new Error("WhatsApp poll vote failed: poll message not found");
    }
    await message.vote(selectedOptions);
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

  private requireClient(): Client {
    if (!this.client || !this.ready) {
      throw new Error("WhatsApp adapter not connected — call ensureConnected() first");
    }
    return this.client;
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
