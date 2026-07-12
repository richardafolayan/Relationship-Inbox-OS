import type { NormalizedMessage, OutboundAttachment, OutboundPoll, PlatformName, SendReceipt, ThreadStub } from "./types";

export interface PlatformAdapter {
  platform: PlatformName;
  ensureConnected(): Promise<void>;
  scanUnreadThreads(): Promise<ThreadStub[]>;
  fetchRecentThreads(limit: number): Promise<ThreadStub[]>;
  /**
   * Optional targeted lookup used when a platform event identifies the exact
   * conversation that changed. Falls back to the normal unread/recent scan
   * when the adapter cannot resolve a stable thread id safely.
   */
  fetchThreadById?(platformThreadId: string): Promise<ThreadStub | null>;
  /**
   * Optional. Every conversation the platform account can see, as cheap
   * stubs (no message fetches). Powers the searchable chat directory
   * (R-0101 / #819): the dashboard's palette lists chats that have no
   * Thread row yet, and opening one imports it on demand via
   * `fetchThreadById` + the normal ingest path. Only adapters whose
   * platform exposes a cheap full chat list implement this (WhatsApp).
   */
  listAllChats?(): Promise<ThreadStub[]>;
  fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]>;
  /**
   * `attachments` lets a platform send media alongside text. Optional
   * because most adapters today are text-only (LinkedIn, Instagram,
   * TikTok); iMessage uses it to push images / voice notes into a chat
   * via Messages.app. Implementations free to ignore unknown kinds.
   */
  sendMessage(
    thread: ThreadStub,
    text: string,
    attachments?: OutboundAttachment[]
  ): Promise<SendReceipt>;
  sendPoll?(thread: ThreadStub, poll: OutboundPoll): Promise<SendReceipt>;
  openThread(thread: ThreadStub): Promise<void>;
  /**
   * Optional. Navigates the runner-controlled browser session to an
   * arbitrary platform URL — used by the dashboard's "open profile" link
   * so the operator lands on the LinkedIn profile inside the runner's
   * already-authenticated Chrome window instead of their default
   * browser. Adapters that don't manage a browser session (iMessage)
   * leave this unset; callers must check before invoking.
   */
  openProfileUrl?(url: string, displayName?: string): Promise<void>;
  /**
   * Optional. Returns persisted `platformMessageKey`s for outbound
   * messages the platform retroactively considers undelivered — e.g.
   * iMessage rows whose `chat.db.error` column flipped non-zero minutes
   * after the post-send poll passed. The scan loop hard-deletes the
   * matching Message rows so the thread reflects what the recipient
   * actually saw (i.e. nothing). Adapters without an async-failure
   * signal leave this unset.
   */
  collectRetractedOutboundKeys?(thread: ThreadStub): Promise<string[]>;
  /**
   * Optional. Adds an emoji reaction to a single message identified by its
   * `platformMessageKey`. Used by the dashboard's message-bubble reaction
   * affordance (issue #408). Resolves once the reaction is confirmed applied,
   * throws an AdapterFailure otherwise. Platforms without a reaction surface
   * (or not yet implemented) leave this unset; callers must check before
   * invoking.
   */
  reactToMessage?(thread: ThreadStub, platformMessageKey: string, emoji: string): Promise<void>;
  /**
   * Optional. Edits an outbound message identified by its platform-side
   * message key. Callers must treat this as an external write and keep it
   * user-triggered.
   */
  editMessage?(thread: ThreadStub, platformMessageKey: string, text: string): Promise<void>;
  voteOnPoll?(thread: ThreadStub, platformMessageKey: string, selectedOptions: string[]): Promise<void>;
  /**
   * Optional. Returns a cheap, opaque change watermark for the platform's
   * upstream message store (e.g. iMessage chat.db's max message ROWID, row
   * count and read mark). The scan loop persists the value captured BEFORE
   * a scan and, on the next run, either skips the scan entirely (watermark
   * unchanged) or asks `collectChangedThreads` for exactly what changed.
   * The format is adapter-private; callers only compare strings for
   * equality. Adapters without a cheap signal leave this unset.
   */
  getScanWatermark?(): Promise<string>;
  /**
   * Optional, paired with `getScanWatermark`. Returns thread stubs for
   * exactly the conversations that changed since `sinceWatermark`, or
   * `fullSweepRequired: true` when the delta cannot be derived safely
   * (unparseable / old-format watermark, or message rows disappeared -
   * deletion / unsend - which cannot be attributed to a chat cheaply).
   */
  collectChangedThreads?(sinceWatermark: string): Promise<{
    stubs: ThreadStub[];
    fullSweepRequired: boolean;
  }>;
  closeSession(reason?: string): Promise<void>;
}
