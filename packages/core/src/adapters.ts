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
  closeSession(reason?: string): Promise<void>;
}
