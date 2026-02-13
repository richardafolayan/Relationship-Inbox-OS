import type { NormalizedMessage, PlatformName, SendReceipt, ThreadStub } from "./types";

export interface PlatformAdapter {
  platform: PlatformName;
  ensureConnected(): Promise<void>;
  scanUnreadThreads(): Promise<ThreadStub[]>;
  fetchRecentThreads(limit: number): Promise<ThreadStub[]>;
  fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]>;
  sendMessage(thread: ThreadStub, text: string): Promise<SendReceipt>;
  openThread(thread: ThreadStub): Promise<void>;
}
