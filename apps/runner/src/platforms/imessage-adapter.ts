import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type {
  NormalizedMessage,
  PlatformAdapter,
  PlatformName,
  SendReceipt,
  ThreadStub
} from "@inbox-os/core";
import { AdapterFailure } from "./utils";
import { IMessageDb, type IMessageThreadRow } from "./imessage-db";
import { sendIMessage } from "./imessage-send";
import { loadContactResolver, type ContactResolver } from "../services/contact-resolver";

const execFileAsync = promisify(execFile);

interface IMessageAdapterDependencies {
  dbPath: string;
  contactsVcfPath?: string;
}

/**
 * Read-via-SQLite, send-via-AppleScript adapter for macOS Messages.app.
 *
 * Reading: opens `~/Library/Messages/chat.db` read-only. Requires Full Disk
 * Access on the runner's parent process (Terminal / iTerm / launchd job).
 * Sending: shells out to `osascript`, which requires Automation permission
 * for Messages.app.
 *
 * Group chats are read but not sendable in v1 — sendMessage throws an
 * AdapterFailure with a "GROUP_SEND_UNSUPPORTED" detail.
 */
export class IMessageAdapter implements PlatformAdapter {
  readonly platform: PlatformName = "IMESSAGE";
  private db?: IMessageDb;
  private contactResolver: ContactResolver;

  constructor(private readonly deps: IMessageAdapterDependencies) {
    this.contactResolver = loadContactResolver(deps.contactsVcfPath);
  }

  /**
   * Best-effort name resolution: if the contacts vcf has a name for any of
   * the chat's participants, use it; otherwise keep the chat.db-provided
   * displayName (phone/email/group name).
   */
  private resolveDisplayName(row: IMessageThreadRow): string {
    if (!row.isGroup) {
      const direct = this.contactResolver.resolve(row.chatIdentifier);
      if (direct) return direct;
    } else {
      // For groups: if every participant resolves to a name, render as
      // "Alice, Bob, Charlie". Otherwise fall back to whatever chat.db had.
      const resolved = row.participants.map((p) => this.contactResolver.resolve(p) ?? p);
      const allResolved = resolved.every((name, i) => name !== row.participants[i]);
      if (allResolved && resolved.length > 0) {
        return resolved.join(", ");
      }
    }
    return row.displayName;
  }

  private getDb(): IMessageDb {
    if (!this.db) {
      if (!existsSync(this.deps.dbPath)) {
        throw new AdapterFailure(`iMessage chat.db not found at ${this.deps.dbPath}`, {
          kind: "AUTH_REQUIRED",
          platform: this.platform,
          stage: "connect",
          details: { dbPath: this.deps.dbPath, hint: "Sign in to Messages.app at least once." }
        });
      }
      try {
        this.db = new IMessageDb(this.deps.dbPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const isPermission = code === "EACCES" || /SQLITE_CANTOPEN|authorization/i.test(String(error));
        throw new AdapterFailure(
          isPermission
            ? "Cannot read iMessage chat.db — grant Full Disk Access to the runner's terminal."
            : `Failed to open iMessage chat.db: ${(error as Error).message}`,
          {
            kind: "AUTH_REQUIRED",
            platform: this.platform,
            stage: "connect",
            details: { dbPath: this.deps.dbPath, code },
            cause: error
          }
        );
      }
    }
    return this.db;
  }

  private toThreadStub(row: IMessageThreadRow, isUnread: boolean, isRecent: boolean): ThreadStub {
    return {
      platformThreadId: row.guid,
      displayName: this.resolveDisplayName(row),
      unreadCount: row.unreadCount,
      lastMessagePreview: row.lastDirection === "OUT"
        ? `You: ${row.lastMessagePreview}`
        : row.lastMessagePreview,
      lastMessageAt: row.lastMessageAt,
      isUnreadCandidate: isUnread,
      isRecentCandidate: isRecent
    };
  }

  async ensureConnected(): Promise<void> {
    this.getDb();
  }

  async scanUnreadThreads(): Promise<ThreadStub[]> {
    const db = this.getDb();
    const rows = db.listThreads(200, { unreadOnly: true });
    return rows.map((r) => this.toThreadStub(r, true, false));
  }

  async fetchRecentThreads(limit: number): Promise<ThreadStub[]> {
    const db = this.getDb();
    const rows = db.listThreads(limit, { unreadOnly: false });
    return rows.map((r) => this.toThreadStub(r, false, true));
  }

  async fetchThreadMessages(thread: ThreadStub, limit: number): Promise<NormalizedMessage[]> {
    const db = this.getDb();
    // chat.db is on-disk and cheap to query, so we ignore the platform-agnostic
    // limit (which targets LinkedIn's tiny `maxMessagesPerThread` cap of 15)
    // and always pull a generous window. The dashboard paginates from our
    // persisted message rows, so a deeper backfill on first scan unlocks
    // proper scroll-back without re-scanning.
    const effectiveLimit = Math.max(limit, 500);
    const rows = db.fetchMessages(thread.platformThreadId, effectiveLimit);
    return rows.map((r) => ({
      platformMessageKey: r.guid,
      direction: r.direction,
      timestamp: r.timestamp ?? new Date().toISOString(),
      text: r.text,
      senderName: r.senderHandle,
      attachments: r.attachments.map((a) => ({
        type: a.kind,
        manualReview: a.kind === "unknown",
        rawLabel: a.transferName ?? a.filename ?? a.mimeType ?? "iMessage attachment"
      }))
    }));
  }

  async sendMessage(thread: ThreadStub, text: string): Promise<SendReceipt> {
    const db = this.getDb();
    // Look up the chat to recover handle + group flag. We re-list one row;
    // chat.db doesn't have a single-row-by-guid method that also computes
    // participants, so we filter in JS — chat count is small.
    const allChats = db.listThreads(500, { unreadOnly: false });
    const chat = allChats.find((c) => c.guid === thread.platformThreadId);
    if (!chat) {
      throw new AdapterFailure("iMessage chat not found", {
        kind: "THREAD_FETCH_FAILED",
        platform: this.platform,
        stage: "persist",
        platformThreadId: thread.platformThreadId
      });
    }
    if (chat.isGroup) {
      throw new AdapterFailure("Group iMessage send is not supported in v1", {
        kind: "THREAD_FETCH_FAILED",
        platform: this.platform,
        stage: "persist",
        platformThreadId: thread.platformThreadId,
        details: { reason: "GROUP_SEND_UNSUPPORTED" }
      });
    }
    const handle = chat.participants[0] ?? chat.chatIdentifier;
    const sendStartedAt = Date.now();
    try {
      await sendIMessage({ handle, service: chat.service ?? undefined, text });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      const isAutomation = /not authorized|errAEEventNotPermitted|-1743|-600/.test(stderr);
      throw new AdapterFailure(
        isAutomation
          ? "Messages.app rejected automation — grant Automation permission to the runner's terminal."
          : `iMessage send failed: ${(error as Error).message}`,
        {
          kind: isAutomation ? "AUTH_REQUIRED" : "THREAD_FETCH_FAILED",
          platform: this.platform,
          stage: "persist",
          platformThreadId: thread.platformThreadId,
          cause: error,
          details: { stderr: stderr.slice(0, 500) }
        }
      );
    }

    // Poll chat.db briefly for the new outbound row to get its guid.
    let receiptGuid: string | undefined;
    let receiptTs: string | undefined;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const found = db.findOutboundSince(thread.platformThreadId, sendStartedAt - 1000);
      if (found) {
        receiptGuid = found.guid;
        receiptTs = found.timestamp;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return {
      sentAt: receiptTs ?? new Date().toISOString(),
      verifiedBy: receiptGuid ? "bubble_detected" : "best_effort"
    };
  }

  async openThread(thread: ThreadStub): Promise<void> {
    // Bring Messages.app forward; can't reliably navigate to a specific
    // chat by guid via URL scheme, so we just activate.
    try {
      await execFileAsync("osascript", [
        "-e",
        'tell application "Messages" to activate'
      ], { timeout: 5_000 });
    } catch {
      // non-fatal; the dashboard's UI feedback is sufficient.
    }
    void thread;
  }

  async closeSession(_reason?: string): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
