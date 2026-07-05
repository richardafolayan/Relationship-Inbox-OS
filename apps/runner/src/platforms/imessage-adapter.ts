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
import { isNonContentIMessageSystemEvent } from "@inbox-os/core";
import { AdapterFailure } from "./utils";
import { IMessageDb, type IMessageThreadRow } from "./imessage-db";
import { groupStubFields } from "./imessage-group-name";
import { imessageMessageBodyText } from "./imessage-message-text";
import { sendIMessage, sendIMessageToChat } from "./imessage-send";
import { loadBestContactResolver, type ContactResolver } from "../services/contact-resolver";

const execFileAsync = promisify(execFile);

interface IMessageAdapterDependencies {
  dbPath: string;
  contactsVcfPath?: string;
  /** AddressBook DB paths; defaults to auto-discovery under $HOME. Tests inject fixtures. */
  addressBookDbPaths?: string[];
  /** Force-enable/disable the live macOS Contacts read. Defaults to macOS-only. */
  useAddressBook?: boolean;
}

/**
 * How long a built contact resolver is reused before it is rebuilt from the
 * live macOS Contacts. The adapter is long-lived, so without a refresh a
 * contact added (or Full Disk Access granted) after boot would never resolve
 * until the runner restarts. 5 minutes keeps the read cheap while picking up
 * changes within one scan cycle.
 */
const CONTACT_RESOLVER_TTL_MS = 5 * 60_000;

/**
 * Read-via-SQLite, send-via-AppleScript adapter for macOS Messages.app.
 *
 * Reading: opens `~/Library/Messages/chat.db` read-only. Requires Full Disk
 * Access on the runner's parent process (Terminal / iTerm / launchd job).
 * Sending: shells out to `osascript`, which requires Automation permission
 * for Messages.app.
 *
 * Group chats: read like any other chat; text sends address the chat guid
 * via AppleScript's `chat id` verb (#753). Attachments to groups throw a
 * "GROUP_ATTACHMENT_UNSUPPORTED" AdapterFailure - the file path is keyed
 * on a buddy handle and has no group equivalent yet.
 */
export class IMessageAdapter implements PlatformAdapter {
  readonly platform: PlatformName = "IMESSAGE";
  private db?: IMessageDb;
  private resolverCache: { resolver: ContactResolver; builtAt: number } | null = null;

  constructor(private readonly deps: IMessageAdapterDependencies) {}

  /**
   * The contact resolver, rebuilt from the live macOS Contacts (+ optional
   * vCard) at most once per TTL window. Cheap to call repeatedly: a cache hit
   * is one timestamp comparison, so per-row/per-message callers can ask freely.
   */
  private resolver(): ContactResolver {
    const now = Date.now();
    if (this.resolverCache && now - this.resolverCache.builtAt < CONTACT_RESOLVER_TTL_MS) {
      return this.resolverCache.resolver;
    }
    const resolver = loadBestContactResolver({
      vcfPath: this.deps.contactsVcfPath,
      addressBookDbPaths: this.deps.addressBookDbPaths,
      useAddressBook: this.deps.useAddressBook
    });
    this.resolverCache = { resolver, builtAt: now };
    return resolver;
  }

  /**
   * Best-effort name resolution. Priority:
   *   1. Operator-set chat name from chat.db (`row.userSetName`) — never
   *      override this, even for groups; the operator chose it.
   *   2. For 1:1: vCard lookup on `chatIdentifier`, fall back to the
   *      raw identifier.
   *   3. For groups: per-participant vCard lookup with raw-handle
   *      fallback PER participant. Earlier this was all-or-nothing —
   *      if any one participant didn't resolve, the whole group fell
   *      back to chat.db's auto string (typically a comma-joined list
   *      of raw numbers). Now partial resolution surfaces the names
   *      that did match while leaving unmatched handles raw, which is
   *      strictly more informative than what chat.db would have done.
   */
  private resolveDisplayName(row: IMessageThreadRow): string {
    if (row.userSetName) return row.userSetName;
    const resolver = this.resolver();
    if (!row.isGroup) {
      return resolver.resolve(row.chatIdentifier) ?? row.displayName;
    }
    if (row.participants.length === 0) return row.displayName;
    return row.participants
      .map((p) => resolver.resolve(p) ?? p)
      .join(", ");
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
        // better-sqlite3 puts SQLITE_CANTOPEN in error.code; the message is
        // just "unable to open database file", so String(error) never matches
        // it. chat.db existed a moment ago (existsSync above), which makes
        // CANTOPEN here a denied open in practice: missing Full Disk Access,
        // or a runner launched from a sandboxed shell.
        const isPermission =
          code === "EACCES" ||
          code === "EPERM" ||
          code === "SQLITE_CANTOPEN" ||
          /SQLITE_CANTOPEN|authorization/i.test(String(error));
        throw new AdapterFailure(
          isPermission
            ? "Cannot read iMessage chat.db - grant Full Disk Access to the runner's terminal."
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
      isRecentCandidate: isRecent,
      ...groupStubFields(row)
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

  // --- incremental scan capability (PlatformAdapter.getScanWatermark) -------
  //
  // chat.db gives us cheap global freshness signals, so the scan loop can
  // skip candidate discovery entirely when nothing changed (the full sweep's
  // per-chat subqueries cost seconds of SYNCHRONOUS SQLite on a real library
  // and ran on every watcher tick, stalling unrelated HTTP requests).
  // Watermark format (adapter-private): "imsg1:<maxRowId>:<msgCount>:<readMark>".

  private static readonly SCAN_WATERMARK_VERSION = "imsg1";

  async getScanWatermark(): Promise<string> {
    const w = this.getDb().getScanWatermark();
    return `${IMessageAdapter.SCAN_WATERMARK_VERSION}:${w.maxRowId}:${w.msgCount}:${w.readMark}`;
  }

  async collectChangedThreads(
    sinceWatermark: string
  ): Promise<{ stubs: ThreadStub[]; fullSweepRequired: boolean }> {
    const parts = sinceWatermark.split(":");
    if (parts.length !== 4 || parts[0] !== IMessageAdapter.SCAN_WATERMARK_VERSION) {
      // Unknown/older format (e.g. after an update changed the shape):
      // resync everything once, then the new format takes over.
      return { stubs: [], fullSweepRequired: true };
    }
    const sinceMaxRowId = Number(parts[1] ?? "");
    const sinceMsgCount = Number(parts[2] ?? "");
    const sinceReadMark = parts[3] ?? "0";
    if (!Number.isFinite(sinceMaxRowId) || !Number.isFinite(sinceMsgCount)) {
      return { stubs: [], fullSweepRequired: true };
    }

    const db = this.getDb();
    const current = db.getScanWatermark();
    // Deletion detector: if the row count grew by less than the ROWID
    // high-water mark did, rows disappeared somewhere (unsend / deletion).
    // Those can't be attributed to a chat cheaply, and the retraction sweep
    // runs per synced thread, so fall back to a full sweep. ROWID gaps from
    // rolled-back inserts can trip this too - rare, and the cost is one
    // ordinary full scan tick.
    const insertedUpperBound = current.maxRowId - sinceMaxRowId;
    const countDelta = current.msgCount - sinceMsgCount;
    if (countDelta < 0 || countDelta < insertedUpperBound) {
      return { stubs: [], fullSweepRequired: true };
    }

    const guids = db.listChangedChatGuids(sinceMaxRowId, sinceReadMark);
    if (guids.length === 0) {
      return { stubs: [], fullSweepRequired: false };
    }
    const rows = db.listThreadsByGuids(guids);
    // Same stub flags a changed chat would get from the unread/recent
    // passes; listThreadsByGuids applies the same automated-sender filter,
    // so chats the full sweep would never surface stay out here too.
    return {
      stubs: rows.map((r) => this.toThreadStub(r, r.unreadCount > 0, true)),
      fullSweepRequired: false
    };
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
    // Drop iMessage "kept an audio message" system events at ingestion so
    // they never become persisted rows. Existing stored rows are filtered
    // again at the read paths (scan-queue aggregates, AI context, thread
    // render, inbox preview) so the operator never sees them either way.
    const filteredRows = rows.filter((r) => !isNonContentIMessageSystemEvent(r.text));
    const resolver = this.resolver();
    return filteredRows.map((r) => {
      // Persist reactions + reply parent on rawJson. Both fields are read
      // back by the dashboard's thread page; absent fields stay omitted so
      // we don't write empty {} for plain bubbles (keeps rawJson nullable
      // for the existing "no metadata" code path).
      const raw: Record<string, unknown> = {};
      if (r.reactions.length > 0) raw.reactions = r.reactions;
      if (r.replyToGuid) raw.replyToGuid = r.replyToGuid;
      // Resolve raw chat.db handles (phone numbers / emails) to real
      // contact names via the operator's vCard. Without this, group-chat
      // bubbles surface "+15551234567" as the sender label even when the
      // contact is in the address book (issue #144). Falls back to the
      // raw handle when no match — unknown senders still get *something*
      // human-readable to label by.
      const resolvedSender =
        r.senderHandle ? resolver.resolve(r.senderHandle) ?? r.senderHandle : r.senderHandle;
      const text = imessageMessageBodyText(r.text, r.attachments.length);
      return {
        platformMessageKey: r.guid,
        direction: r.direction,
        // Pass the parsed chat.db timestamp through as-is. When `date` was
        // NULL/0/non-finite, appleTimeToIso returned undefined; leave it
        // undefined (timestamp is optional on NormalizedMessage) so
        // scan-queue's `adapterReportedTimestamp` is false and
        // buildMessageUpsertPayload preserves the existing row's timestamp
        // on re-scan instead of re-stamping it to "now" (issue #245 drift).
        // New inserts still fall back via normalizeMessageTimestamp. Mirrors
        // the LinkedIn adapter's `timestamp || undefined`.
        timestamp: r.timestamp,
        text,
        senderName: resolvedSender,
        raw: Object.keys(raw).length > 0 ? raw : undefined,
        attachments: r.attachments.map((a) => ({
          type: a.kind,
          manualReview: a.kind === "unknown",
          rawLabel: a.transferName ?? a.filename ?? a.mimeType ?? "iMessage attachment",
          guid: a.guid || undefined,
          kind: a.kind,
          byteSize: a.totalBytes ?? undefined
        }))
      };
    });
  }

  async collectRetractedOutboundKeys(thread: ThreadStub): Promise<string[]> {
    return this.getDb().findFailedOutboundGuids(thread.platformThreadId);
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
      // Group sends (pilot R-0086 / #753). Groups have no single buddy
      // handle; the chat guid addresses the conversation itself. Text
      // only — the 1:1 attachment path (UI scripting) is keyed on a buddy
      // handle and has no group equivalent, so attachments stay blocked
      // with a specific reason the dashboard can explain.
      if ((attachments ?? []).length > 0) {
        throw new AdapterFailure(
          "Attachments can't be sent to group chats yet - send the text first, then share the file from Messages.app.",
          {
            kind: "THREAD_FETCH_FAILED",
            platform: this.platform,
            stage: "persist",
            platformThreadId: thread.platformThreadId,
            details: { reason: "GROUP_ATTACHMENT_UNSUPPORTED" }
          }
        );
      }
      return this.sendToGroupChat(chat.guid, thread, text);
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
    // The receipt lookups below key on a chat guid. When pickBestSendHandle
    // routes to a sibling handle, Messages.app delivers the message into that
    // handle's *own* chat (a different chat.ROWID/guid than thread
    // .platformThreadId), so polling the original thread guid would miss the
    // sent row entirely — no receipt guid (which lets a later scan re-insert
    // the message as a duplicate), no delivery confirmation, no attachments.
    // Re-resolve to the picked handle's chat; fall back to the thread guid
    // when the handle is unchanged or has no distinct 1:1 chat.
    const receiptChatGuid =
      handle === initialHandle
        ? thread.platformThreadId
        : db.findChatGuidForHandle(handle) ?? thread.platformThreadId;
    const sendStartedAt = Date.now();
    // Service must follow the *handle* we picked, not chat.service_name.
    // The chat row records whatever service Messages.app last touched it
    // with - so a thread whose previous reply happened to land on SMS will
    // keep chat.service = "SMS" forever, and passing that to AppleScript
    // forces every subsequent send (including ones routed to an
    // iMessage-capable handle by pickBestSendHandle) down the SMS path.
    // Reading the service off the handle itself lets a contact toggle
    // back to blue bubbles as soon as we send to an iMessage-registered
    // address.
    const handleService = db.findHandleService(handle) ?? undefined;
    try {
      await sendIMessage({
        handle,
        service: handleService,
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
          ? "Messages.app needs Accessibility permission to deliver files - grant it under System Settings > Privacy & Security > Accessibility for your terminal app, then retry."
          : isAutomation
            ? "Messages.app rejected automation - grant Automation permission to the runner's terminal."
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
      const status = db.findOutboundDeliveryStatus(receiptChatGuid, sendStartedAt - 1000);
      if (status) {
        if (status.error && status.error !== 0) {
          const serviceLabel = status.service ?? "?";
          const smsExplain =
            status.service === "SMS"
              ? " - routed via SMS, but this Mac has no SMS pathway (no SIM and Text Message Forwarding from iPhone is off, OR the recipient's phone isn't iMessage-registered). Try the recipient's iMessage email instead."
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
        receiptTs = status.timestamp;
        if (status.isDelivered) {
          isDelivered = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!receiptTs && receiptGuid) {
      // Defensive fallback: the delivery-status row should always carry
      // a timestamp now, but keep the legacy lookup as a safety net for
      // unusual chat.db states (e.g. corrupted date column).
      const fallback = db.findOutboundSince(receiptChatGuid, sendStartedAt - 1000);
      receiptTs = fallback?.timestamp;
    }

    // Capture attachments from chat.db for the new outbound message so
    // send.ts can persist them on the Message row (otherwise the dashboard
    // shows only the text bubble for voice notes / photos / videos).
    const dbAttachments = db.findOutboundAttachments(receiptChatGuid, sendStartedAt - 1000);
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
      // chat.db's row guid for the message we just sent. send.ts uses
      // this as the persisted Message.platformMessageKey so a later
      // scan, which also keys by guid, dedups against this row instead
      // of inserting a duplicate. Without it, the same iMessage ends
      // up as two Message rows: one from the send-side stableHash and
      // one from the scan-side guid.
      platformMessageKey: receiptGuid,
      // "bubble_detected" if Messages.app confirmed delivery; else
      // "best_effort" — the bubble exists but the recipient hasn't
      // acked yet (offline, slow, etc.).
      verifiedBy: isDelivered ? "bubble_detected" : "best_effort",
      attachments: receiptAttachments.length > 0 ? receiptAttachments : undefined
    };
  }

  /**
   * Group text send (pilot R-0086 / #753). Addresses the conversation by
   * its chat.db guid via AppleScript's `chat id` verb, then polls the SAME
   * guid for the outbound row - groups have exactly one chat row, so none
   * of the 1:1 sibling-handle/receipt-rerouting logic applies.
   */
  private async sendToGroupChat(
    chatGuid: string,
    thread: ThreadStub,
    text: string
  ): Promise<SendReceipt> {
    const db = this.getDb();
    const sendStartedAt = Date.now();
    try {
      await sendIMessageToChat({ chatGuid, text });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      const message = (error as Error).message ?? "";
      const isAutomation = /not authorized|errAEEventNotPermitted|-1743|-600/.test(stderr + message);
      // AppleScript can't get `chat id "..."` when the chat was deleted /
      // never synced on this Mac - surface that plainly instead of a raw
      // osascript error.
      const isUnknownChat = /Can.t get chat id|-1728/.test(stderr + message);
      throw new AdapterFailure(
        isAutomation
          ? "Messages.app rejected automation - grant Automation permission to the runner's terminal."
          : isUnknownChat
            ? "Messages.app doesn't know this group chat on this Mac - open it in Messages once, then retry."
            : `iMessage group send failed: ${message}`,
        {
          kind: isAutomation ? "AUTH_REQUIRED" : "THREAD_FETCH_FAILED",
          platform: this.platform,
          stage: "persist",
          platformThreadId: thread.platformThreadId,
          cause: error,
          details: { stderr: stderr.slice(0, 500), chatGuid }
        }
      );
    }

    // Same receipt polling as the 1:1 path: guid + delivery state from
    // chat.db so send.ts can dedup against the scan and report honestly.
    let receiptGuid: string | undefined;
    let receiptTs: string | undefined;
    let isDelivered = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const status = db.findOutboundDeliveryStatus(chatGuid, sendStartedAt - 1000);
      if (status) {
        if (status.error && status.error !== 0) {
          throw new AdapterFailure(
            `Messages.app reports group send failed (chat.db error=${status.error}, service=${status.service ?? "?"})`,
            {
              kind: "THREAD_FETCH_FAILED",
              platform: this.platform,
              stage: "persist",
              platformThreadId: thread.platformThreadId,
              details: { messagesError: status.error, service: status.service, chatGuid }
            }
          );
        }
        receiptGuid = status.guid;
        receiptTs = status.timestamp;
        if (status.isDelivered) {
          isDelivered = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!receiptTs && receiptGuid) {
      const fallback = db.findOutboundSince(chatGuid, sendStartedAt - 1000);
      receiptTs = fallback?.timestamp;
    }

    return {
      sentAt: receiptTs ?? new Date().toISOString(),
      platformMessageKey: receiptGuid,
      verifiedBy: isDelivered ? "bubble_detected" : "best_effort"
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
   * The siblings come from the operator's contacts (live macOS Contacts +
   * optional vCard) via the resolver. Without this, a contact who has both
   * an iMessage email and a phone (the phone may or may not currently be
   * iMessage-active) tends to get routed via SMS — which silently fails on
   * Macs without Text Message Forwarding from an iPhone.
   */
  private pickBestSendHandle(handle: string): string {
    const db = this.getDb();
    // Build the full handle pool (contact siblings + the original itself,
    // in case the original isn't in the address book).
    const pool = Array.from(new Set([handle, ...this.resolver().siblingHandles(handle)]));
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
