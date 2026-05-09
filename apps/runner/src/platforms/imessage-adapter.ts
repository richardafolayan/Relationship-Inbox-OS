import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type {
  AttachmentPlaceholder,
  NormalizedMessage,
  OutboundAttachment,
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
      raw: r.reactions.length > 0 ? { reactions: r.reactions } : undefined,
      attachments: r.attachments.map((a) => ({
        type: a.kind,
        manualReview: a.kind === "unknown",
        rawLabel: a.transferName ?? a.filename ?? a.mimeType ?? "iMessage attachment",
        guid: a.guid || undefined,
        kind: a.kind,
        byteSize: a.totalBytes ?? undefined
      }))
    }));
  }

  async sendMessage(thread: ThreadStub, text: string, attachments?: OutboundAttachment[]): Promise<SendReceipt> {
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
    // Pick the best handle to send to. The chat row we picked above is keyed
    // by *one* of the contact's handles (e.g. their phone). If that handle
    // isn't iMessage-registered on this Mac, Messages.app silently routes
    // via SMS and (for Macs without Text Message Forwarding from an iPhone)
    // the message fails to deliver. Prefer a sibling handle that IS
    // iMessage-registered. Falls through to the original handle if none
    // is found.
    const initialHandle = chat.participants[0] ?? chat.chatIdentifier;
    const handle = this.pickBestSendHandle(initialHandle);
    const sendStartedAt = Date.now();
    try {
      await sendIMessage({
        handle,
        service: chat.service ?? undefined,
        text,
        attachmentPaths: (attachments ?? []).map((a) => a.absolutePath)
      });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      const message = (error as Error).message ?? "";
      const isAutomation = /not authorized|errAEEventNotPermitted|-1743|-600/.test(stderr + message);
      const isAccessibility = /osascript is not allowed to send keystrokes|\(1002\)|System Events.*not authorized/.test(stderr + message);
      throw new AdapterFailure(
        isAccessibility
          ? "Messages.app needs Accessibility permission to deliver files — grant it under System Settings → Privacy & Security → Accessibility for your terminal app, then retry."
          : isAutomation
            ? "Messages.app rejected automation — grant Automation permission to the runner's terminal."
            : `iMessage send failed: ${message}`,
        {
          kind: isAutomation || isAccessibility ? "AUTH_REQUIRED" : "THREAD_FETCH_FAILED",
          platform: this.platform,
          stage: "persist",
          platformThreadId: thread.platformThreadId,
          cause: error,
          details: { stderr: stderr.slice(0, 500) }
        }
      );
    }

    // Poll chat.db briefly for the new outbound row to get its guid +
    // delivery status. We care about three signals from Messages.app:
    //   - chat.db error column ≠ 0 → hard failure (e.g. error 25 = SMS
    //     send couldn't reach the network because there's no Text
    //     Message Forwarding pathway). Throw with a clear hint so the
    //     dashboard surfaces the real reason instead of "Sent ✓".
    //   - is_delivered = 1 → recipient device acknowledged, we're done
    //   - is_sent = 1 but is_delivered = 0 → handed off, recipient may
    //     be offline; report "best_effort" rather than throwing.
    let receiptGuid: string | undefined;
    let receiptTs: string | undefined;
    let isDelivered = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const status = db.findOutboundDeliveryStatus(thread.platformThreadId, sendStartedAt - 1000);
      if (status) {
        if (status.error && status.error !== 0) {
          const serviceLabel = status.service ?? "?";
          const smsExplain =
            status.service === "SMS"
              ? " — routed via SMS, but this Mac has no SMS pathway (no SIM and Text Message Forwarding from iPhone is off, OR the recipient's phone isn't iMessage-registered). Try the recipient's iMessage email instead."
              : "";
          throw new AdapterFailure(
            `Messages.app reports send failed (chat.db error=${status.error}, service=${serviceLabel})${smsExplain}`,
            {
              kind: "THREAD_FETCH_FAILED",
              platform: this.platform,
              stage: "persist",
              platformThreadId: thread.platformThreadId,
              details: { messagesError: status.error, service: status.service, handle }
            }
          );
        }
        receiptGuid = status.guid;
        if (status.isDelivered) {
          isDelivered = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!receiptTs && receiptGuid) {
      // We have a guid but the delivery poll didn't grab the timestamp;
      // fall back to the legacy lookup for the row's date.
      const fallback = db.findOutboundSince(thread.platformThreadId, sendStartedAt - 1000);
      receiptTs = fallback?.timestamp;
    }

    // Capture attachments from chat.db for the new outbound message so
    // send.ts can persist them on the Message row (otherwise the dashboard
    // shows only the text bubble for voice notes / photos / videos).
    const dbAttachments = db.findOutboundAttachments(thread.platformThreadId, sendStartedAt - 1000);
    const receiptAttachments: AttachmentPlaceholder[] = dbAttachments.map((a) => ({
      type: a.kind,
      manualReview: a.kind === "unknown",
      rawLabel: a.transferName ?? a.filename ?? a.mimeType ?? "iMessage attachment",
      guid: a.guid || undefined,
      kind: a.kind,
      byteSize: a.totalBytes ?? undefined
    }));

    return {
      sentAt: receiptTs ?? new Date().toISOString(),
      // "bubble_detected" if Messages.app confirmed delivery; else
      // "best_effort" — the bubble exists but the recipient hasn't
      // acked yet (offline, slow, etc.).
      verifiedBy: isDelivered ? "bubble_detected" : "best_effort",
      attachments: receiptAttachments.length > 0 ? receiptAttachments : undefined
    };
  }

  /**
   * Given a handle picked from chat.db (typically the chat row's first
   * participant), find the *best* handle to actually send via iMessage.
   *
   * Preference order:
   *   1. iMessage-registered EMAIL — emails are tied to Apple ID and
   *      route reliably via iMessage regardless of current device state.
   *   2. iMessage-registered PHONE — works when the recipient's SIM is
   *      currently iMessage-active. Apple lazy-routes to SMS at send
   *      time if not, even if chat.db has an iMessage handle row from a
   *      previous session.
   *   3. The original handle, as a last resort.
   *
   * The siblings come from the operator's vCard via `contactResolver`.
   * Without this, a contact who has both an iMessage email and a phone
   * (the phone may or may not currently be iMessage-active) tends to
   * get routed via SMS — which silently fails on Macs without Text
   * Message Forwarding from an iPhone.
   */
  private pickBestSendHandle(handle: string): string {
    const db = this.getDb();
    // Build the full handle pool (vcard siblings + the original itself,
    // in case the original isn't in the vcard).
    const pool = Array.from(new Set([handle, ...this.contactResolver.siblingHandles(handle)]));
    // Prefer iMessage-registered emails first.
    const iMessageEmails = pool.filter(
      (h) => h.includes("@") && db.findHandleService(h) === "iMessage"
    );
    if (iMessageEmails.length > 0) {
      const picked = iMessageEmails[0]!;
      if (picked !== handle) {
        console.log(`[imessage] preferring iMessage email ${picked} over chat handle ${handle}`);
      }
      return picked;
    }
    // Then iMessage-registered phones.
    const iMessagePhones = pool.filter(
      (h) => !h.includes("@") && db.findHandleService(h) === "iMessage"
    );
    if (iMessagePhones.length > 0) {
      const picked = iMessagePhones[0]!;
      if (picked !== handle) {
        console.log(`[imessage] preferring iMessage phone ${picked} over chat handle ${handle}`);
      }
      return picked;
    }
    // No iMessage-reachable handle found for this contact; fall through.
    if (db.findHandleService(handle) !== "iMessage") {
      console.log(
        `[imessage] no iMessage handle found for contact (chat handle ${handle}, siblings ${pool.length}); send will likely fall back to SMS`
      );
    }
    return handle;
  }

  async openThread(thread: ThreadStub): Promise<void> {
    // For 1:1 chats we can deeplink with `imessage:<handle>` (or `sms:`
    // for SMS), which both opens Messages.app AND selects the conversation
    // with that buddy. For group chats macOS exposes no public URL form,
    // so we fall back to just activating Messages.app.
    try {
      const db = this.getDb();
      const allChats = db.listThreads(500, { unreadOnly: false });
      const chat = allChats.find((c) => c.guid === thread.platformThreadId);
      if (chat && !chat.isGroup) {
        const handle = chat.participants[0] ?? chat.chatIdentifier;
        if (handle) {
          const scheme = (chat.service ?? "").toLowerCase().includes("sms") ? "sms" : "imessage";
          await execFileAsync("open", [`${scheme}:${handle}`], { timeout: 5_000 });
          return;
        }
      }
    } catch {
      // fall through to plain activate
    }
    try {
      await execFileAsync("osascript", [
        "-e",
        'tell application "Messages" to activate'
      ], { timeout: 5_000 });
    } catch {
      // non-fatal; the dashboard's UI feedback is sufficient.
    }
  }

  async closeSession(_reason?: string): Promise<void> {
    this.db?.close();
    this.db = undefined;
  }
}
