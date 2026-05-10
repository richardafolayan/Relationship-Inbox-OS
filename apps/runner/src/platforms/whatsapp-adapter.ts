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
// - Sends are gated by checkSendGuard — saved-contact only, per-recipient
//   rate limit, rolling 24h cap.

import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformName,
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import type { Client, Chat, Message as WaMessage } from "whatsapp-web.js";
import { createWhatsAppClient } from "./whatsapp/client";
import { chatToThreadStub } from "./whatsapp/groupResolver";
import { checkSendGuard, type SendGuardConfig, type SendGuardPrisma } from "./whatsapp/sendGuard";
import { epochSecondsToIso } from "./whatsapp/whatsappTime";
import { isGroupJid } from "./whatsapp/whatsappIdentity";

export interface WhatsAppAdapterDeps {
  /** Filesystem dir for the LocalAuth session (runnerConfig.profileDirs.WHATSAPP). */
  authDir: string;
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

  async sendMessage(thread: ThreadStub, text: string): Promise<SendReceipt> {
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
    const sent = await client.sendMessage(thread.platformThreadId, text);
    return {
      sentAt: epochSecondsToIso(sent.timestamp) ?? new Date().toISOString(),
      verifiedBy: "best_effort"
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
    // Inbound media (image / voice / sticker) is unsupported in v1. We
    // log a placeholder so the UI shows something meaningful instead of
    // an empty bubble; the raw payload is dropped. Polls (`poll_creation`
    // type) get flattened to a readable question + bullet list so they
    // appear inline in the thread timeline rather than as empty rows.
    // Vote tallies are not fetched — they require an extra
    // `getPollVotes()` call per poll, mutate continuously after capture
    // so any persisted count is stale within minutes, and the operator's
    // primary use case here is reading what was posted, not tracking
    // outcomes. Surfacing live tallies is queued as a follow-up.
    // Cast: wweb.js's .d.ts declares pollOptions: string[] but at runtime
    // each option is { name, localId } (see Message.js:329-331 in the
    // installed library). Our renderer needs the runtime shape.
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
    return {
      platformMessageKey: msg.id?._serialized,
      direction: msg.fromMe ? "OUT" : "IN",
      timestamp: epochSecondsToIso(msg.timestamp) ?? new Date().toISOString(),
      text,
      senderName,
      attachments: []
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

/**
 * Flatten any wweb.js Message into the single text string we persist on
 * Message.text. Polls become a readable question + bullet list so the
 * thread timeline shows what was asked rather than an empty bubble; media
 * messages become a "[media]" placeholder. Plain text passes through
 * unchanged.
 */
export function renderMessageText(msg: WaTextMessageLike): string {
  if (msg.type === "poll_creation") {
    const question = (msg.pollName ?? "").trim();
    const options = (msg.pollOptions ?? [])
      .map((o) => (o?.name ?? "").trim())
      .filter((name) => name.length > 0)
      .map((name) => `• ${name}`)
      .join("\n");
    const header = msg.allowMultipleAnswers ? "📊 Poll (multi-select)" : "📊 Poll";
    const body = question.length > 0 ? `${header}: ${question}` : header;
    return options.length > 0 ? `${body}\n${options}` : body;
  }
  if (msg.body && msg.body.length > 0) return msg.body;
  if (msg.hasMedia) return "[media]";
  return "";
}
