import type { NormalizedMessage, OutboundAttachment, PlatformName, SendReceipt, ThreadStub } from "./types";

export interface PlatformAdapter {
  platform: PlatformName;
  ensureConnected(): Promise<void>;
  scanUnreadThreads(): Promise<ThreadStub[]>;
  fetchRecentThreads(limit: number): Promise<ThreadStub[]>;
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
  closeSession(reason?: string): Promise<void>;
}
