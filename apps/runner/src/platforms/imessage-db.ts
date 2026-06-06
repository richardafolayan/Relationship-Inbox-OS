import Database, { type Database as Db } from "better-sqlite3";

// Apple "absolute time" epoch is 2001-01-01T00:00:00Z. The Messages.app db
// stores message.date in nanoseconds since that epoch on modern macOS (it
// used to be seconds pre-High Sierra; we only support modern). 978307200000
// is the unix-ms offset.
const APPLE_EPOCH_OFFSET_MS = 978_307_200_000;

export interface IMessageReaction {
  /** Apple's emoji-equivalent for the tapback. */
  emoji: string;
  /** "love" | "like" | "dislike" | "laugh" | "emphasis" | "question". */
  kind: "love" | "like" | "dislike" | "laugh" | "emphasis" | "question";
  /** Direction of the tapback — IN means the other party reacted. */
  direction: "IN" | "OUT";
  timestamp?: string;
  /** Inverse tapback (3000-3005 range) acts as removal — surfaced as `removed: true`. */
  removed: boolean;
}

const TAPBACK_KINDS: Record<number, { emoji: string; kind: IMessageReaction["kind"] }> = {
  2000: { emoji: "❤", kind: "love" },
  2001: { emoji: "👍", kind: "like" },
  2002: { emoji: "👎", kind: "dislike" },
  2003: { emoji: "😂", kind: "laugh" },
  2004: { emoji: "‼", kind: "emphasis" },
  2005: { emoji: "❓", kind: "question" }
};

function tapbackInfo(t: number | null | undefined): { emoji: string; kind: IMessageReaction["kind"]; removed: boolean } | null {
  if (t === null || t === undefined) return null;
  if (t >= 2000 && t <= 2005) {
    const info = TAPBACK_KINDS[t];
    return info ? { ...info, removed: false } : null;
  }
  if (t >= 3000 && t <= 3005) {
    const info = TAPBACK_KINDS[t - 1000];
    return info ? { ...info, removed: true } : null;
  }
  return null;
}

/**
 * Tapback / reaction `associated_message_type` values:
 *   2000-2005  apply tapback (love, like, dislike, laugh, emphasis, question)
 *   3000-3005  remove tapback (same set)
 * Anything else (0 = normal message, 1-7 = inline edit/expressives, etc.) is
 * kept as a real message.
 */
function isTapbackType(t: number | null | undefined): boolean {
  if (t === null || t === undefined) return false;
  return (t >= 2000 && t <= 2005) || (t >= 3000 && t <= 3005);
}

/**
 * Heuristic: does the chat look like an automated SMS / iMessage service?
 * These are short-code numbers (e.g. "12345") or alphanumeric sender IDs
 * (e.g. "StripeLink", "giffgaff", "Anster") — never real people, never
 * worth replying to. We filter them out at scan time so they don't
 * pollute the inbox.
 */
export function looksLikeAutomatedSender(chatIdentifier: string): boolean {
  const id = chatIdentifier.trim();
  if (!id) return false;
  // Email and phone (with + or 7+ digits) are kept.
  if (id.includes("@")) return false;
  const digits = id.replace(/\D/g, "");
  if (digits.length >= 7) return false;
  // Pure alphabetic / alphanumeric sender ID (StripeLink, giffgaff, etc.).
  if (/^[A-Za-z][A-Za-z0-9 ._-]{1,29}$/.test(id)) return true;
  // Short-code phone (3-6 digits).
  if (/^\d{2,6}$/.test(digits)) return true;
  return false;
}

/**
 * Walk an NSAttributedString typedstream blob and return the message text.
 *
 * Format we exploit:
 *   ... "NSString" ... <type=0x2B|0x2A> <len byte | 0x81 <u16 LE>> <utf8 bytes>
 *
 * The blob normally contains multiple NSString-shaped runs (class names in
 * the schema preamble, then the actual text). We scan past schema-looking
 * candidates and return the first plausibly human one.
 */
function decodeTypedstreamString(blob: Buffer): string {
  const marker = Buffer.from("NSString", "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let cursor = 0;
  while (cursor < blob.length) {
    const idx = blob.indexOf(marker, cursor);
    if (idx < 0) return "";
    const startScan = idx + marker.length;
    cursor = startScan;
    const scanEnd = Math.min(blob.length - 1, startScan + 64);
    for (let i = startScan; i < scanEnd; i++) {
      const tb = blob[i];
      if (tb !== 0x2b && tb !== 0x2a) continue;
      const lenByte = blob[i + 1] ?? 0;
      let len: number;
      let dataStart: number;
      if (lenByte > 0 && lenByte < 0x80) {
        len = lenByte;
        dataStart = i + 2;
      } else if (lenByte === 0x81 && i + 3 < blob.length) {
        len = (blob[i + 2] ?? 0) | ((blob[i + 3] ?? 0) << 8);
        dataStart = i + 4;
      } else {
        continue;
      }
      if (len < 1 || dataStart + len > blob.length) continue;
      const slice = blob.subarray(dataStart, dataStart + len);
      const decoded = decoder.decode(slice).trim();
      // Schema/class metadata candidates: skip and keep scanning.
      if (/^NS[A-Z][A-Za-z]+$/.test(decoded)) break;
      if (/^[A-Z][A-Za-z]+(?:Value|Object|Array|Dictionary|String|Data|Number|Date|Class|Attribute|Range|Name)$/.test(decoded)) break;
      if (/\$class|\$classes|\$classname/.test(decoded)) break;
      if (/^kIM|^__kIM|^streamtyped/.test(decoded)) break;
      // Tapback / reaction marker: not human-readable; surface as empty.
      if (/^[a-z]{1,3}_\d+_[0-9A-F-]{20,}$/.test(decoded)) return "";
      if (decoded.length === 0) break;
      return decoded;
    }
  }
  return "";
}

export function appleTimeToIso(value: number | bigint | null): string | undefined {
  if (value === null || value === undefined) return undefined;
  const num = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(num) || num <= 0) return undefined;
  // Heuristic: ns timestamps are ~10^18, seconds are ~10^9. Anything above
  // 10^12 is treated as nanoseconds.
  const unixMs = num > 1e12 ? num / 1e6 + APPLE_EPOCH_OFFSET_MS : num * 1000 + APPLE_EPOCH_OFFSET_MS;
  return new Date(unixMs).toISOString();
}

export interface IMessageThreadRow {
  guid: string;
  chatId: number;
  /**
   * Final display string with chat.db's auto-fallbacks already applied:
   * either the user-set name, or `participants.join(", ")` for groups, or
   * the raw chatIdentifier for 1:1s. Callers that want to know whether
   * the name was operator-set (vs. auto-derived) should look at
   * `userSetName` instead.
   */
  displayName: string;
  /**
   * The literal `chat.display_name` value from chat.db. Non-null only when
   * the operator named the chat in iMessage (e.g. "Family Chat"). Null
   * when chat.db left it empty and the displayName above was synthesised
   * from participants/identifier. Lets the adapter decide whether to
   * preserve the operator's choice or apply per-participant vCard
   * resolution for groups.
   */
  userSetName: string | null;
  chatIdentifier: string;
  service: string | null;
  isGroup: boolean;
  unreadCount: number;
  lastMessageAt?: string;
  lastMessagePreview: string;
  lastDirection: "IN" | "OUT" | null;
  participants: string[];
}

export interface IMessageAttachment {
  guid: string;
  filename: string | null;
  /** "image/jpeg", "audio/x-caf", "video/quicktime", etc. */
  mimeType: string | null;
  /** Apple's display name, e.g. "Audio Message.caf". */
  transferName: string | null;
  totalBytes: number | null;
  kind: "voice_note" | "photo" | "video" | "audio" | "pdf" | "sticker" | "unknown";
}

export interface IMessageMessageRow {
  guid: string;
  rowId: number;
  text: string;
  direction: "IN" | "OUT";
  timestamp?: string;
  senderHandle?: string;
  hasAttachments: boolean;
  attachments: IMessageAttachment[];
  /** Tapbacks the other party (or you) sent on this message, latest-state aggregated. */
  reactions: IMessageReaction[];
  /**
   * When this message is an inline reply (a "Reply" in Messages.app, not a
   * tapback), the guid of the parent message being replied to. Cleaned of
   * Apple's `p:0/` / `bp:` prefix — just the bare guid that matches another
   * row's `guid`. Undefined for standalone messages.
   */
  replyToGuid?: string;
}

/**
 * Map an Apple mime type / filename to a coarse media kind. iMessage uses a
 * mix of registered MIME types and reverse-DNS UTIs (e.g.
 * "com.apple.coreaudio-format"), and voice notes have no special flag —
 * they're just .caf files named "Audio Message.caf".
 */
function classifyAttachment(mimeType: string | null, transferName: string | null, filename: string | null): IMessageAttachment["kind"] {
  const mime = (mimeType ?? "").toLowerCase();
  const name = (transferName ?? filename ?? "").toLowerCase();
  if (name.includes("audio message") || /\.caf($|\?)/.test(name)) return "voice_note";
  if (mime.startsWith("image/") || /\.(heic|jpe?g|png|gif|webp)($|\?)/.test(name)) return "photo";
  if (mime.startsWith("video/") || /\.(mp4|mov|m4v)($|\?)/.test(name)) return "video";
  if (mime.startsWith("audio/") || mime.includes("coreaudio")) return "audio";
  if (mime === "application/pdf" || /\.pdf($|\?)/.test(name)) return "pdf";
  if (/sticker|memoji/i.test(name)) return "sticker";
  return "unknown";
}

export function describeAttachments(attachments: IMessageAttachment[]): string {
  if (attachments.length === 0) return "";
  const counts = new Map<IMessageAttachment["kind"], number>();
  for (const a of attachments) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const labels: string[] = [];
  for (const [kind, count] of counts) {
    const noun = kind === "voice_note" ? "Voice note"
      : kind === "photo" ? "Photo"
      : kind === "video" ? "Video"
      : kind === "audio" ? "Audio"
      : kind === "pdf" ? "PDF"
      : kind === "sticker" ? "Sticker"
      : "Attachment";
    labels.push(count > 1 ? `${count} ${noun}s` : noun);
  }
  return `[${labels.join(", ")}]`;
}

/**
 * Wraps Messages.app's chat.db. Opened read-only with `?immutable=1` so we
 * never contend with Messages.app's own writers — better-sqlite3 still
 * applies WAL semantics for reads. The caller is responsible for handling
 * EACCES (Full Disk Access not granted) and ENOENT (signed out / new mac).
 */
export class IMessageDb {
  private db: Db;

  constructor(private readonly dbPath: string) {
    // `immutable=1` tells SQLite not to attempt any locking; we accept the
    // risk of reading slightly-stale rows during a concurrent Messages write
    // (the next poll picks them up).
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma("journal_mode = WAL");
    // Smoke test
    this.db.prepare("SELECT 1 FROM chat LIMIT 1").get();
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  /**
   * Look up a single attachment by its chat.db guid. Used by the runner's
   * /data/imessage-attachment/:guid endpoint so the dashboard can stream
   * inline photos / voice notes / videos. Returns the resolved absolute
   * path to the file on disk along with mime info and our coarse kind.
   */
  findAttachmentByGuid(guid: string): { absolutePath: string | null; mimeType: string | null; transferName: string | null; filename: string | null; totalBytes: number | null; kind: IMessageAttachment["kind"] } | undefined {
    const row = this.db
      .prepare(
        `SELECT filename, mime_type AS mimeType, transfer_name AS transferName, total_bytes AS totalBytes
           FROM attachment WHERE guid = ? LIMIT 1`
      )
      .get(guid) as
        | { filename: string | null; mimeType: string | null; transferName: string | null; totalBytes: number | bigint | null }
        | undefined;
    if (!row) return undefined;
    const home = process.env.HOME ?? "";
    const raw = row.filename ?? "";
    const absolutePath = raw.startsWith("~")
      ? raw.replace(/^~/, home)
      : raw.startsWith("/")
        ? raw
        : null;
    return {
      absolutePath,
      mimeType: row.mimeType,
      transferName: row.transferName,
      filename: row.filename,
      totalBytes: row.totalBytes === null ? null : Number(row.totalBytes),
      kind: classifyAttachment(row.mimeType, row.transferName, row.filename)
    };
  }

  walMtimeKey(): string {
    // Caller can stat() chat.db-wal externally; this stub returns the
    // configured path so the adapter can build the wal path in one place.
    return `${this.dbPath}-wal`;
  }

  /**
   * Decode the `attributedBody` blob fallback when `message.text` is NULL
   * (common on macOS Ventura+). The blob is a typedstream-encoded
   * NSAttributedString. Full parsing is non-trivial — but the visible string
   * is always present as a length-prefixed UTF-8 / UTF-16 run that follows
   * the marker `NSString` then `+` (a length indicator). We extract a
   * best-effort plaintext slice; if anything fails we return empty string,
   * which the adapter surfaces as "[unsupported message]".
   */
  static decodeAttributedBody(blob: Buffer | null | undefined): string {
    if (!blob || blob.length === 0) return "";
    return decodeTypedstreamString(blob);
  }

  static _legacy(blob: Buffer | null | undefined): string {
    if (!blob || blob.length === 0) return "";
    try {
      const marker = Buffer.from("NSString", "utf8");
      const idx = blob.indexOf(marker);
      if (idx < 0) return "";
      // After "NSString" + 0x01 + length-byte structure varies; scan for
      // first printable run >=2 chars after marker.
      const tail = blob.subarray(idx + marker.length);
      // The next byte after marker is typically 0x01 (mark byte). Skip a few
      // type bytes then read a length-prefixed UTF-8 string.
      // Strategy: find the longest UTF-8 ASCII/printable run.
      let best = "";
      let current = "";
      for (let i = 0; i < tail.length; i++) {
        const b = tail[i] ?? 0;
        if (b >= 0x20 && b < 0x7f) {
          current += String.fromCharCode(b);
        } else if (b >= 0xc2 && b < 0xf5 && i + 1 < tail.length) {
          // Try a UTF-8 multibyte; let TextDecoder handle from here on a
          // window. Fallback to ASCII-only run if it errors.
          try {
            const window = tail.subarray(i, Math.min(tail.length, i + 512));
            const decoded = new TextDecoder("utf-8", { fatal: false }).decode(window);
            // Trim at first control char.
            const stop = decoded.search(/[ -]/);
            const chunk = stop >= 0 ? decoded.slice(0, stop) : decoded;
            current += chunk;
            i += chunk.length - 1;
          } catch {
            if (current.length > best.length) best = current;
            current = "";
          }
        } else {
          if (current.length > best.length) best = current;
          current = "";
        }
      }
      if (current.length > best.length) best = current;
      return best.trim();
    } catch {
      return "";
    }
  }

  /**
   * One row per chat (1:1 or group). `unreadCount` counts inbound messages
   * with `is_read = 0`. `lastMessagePreview` is the latest message text
   * (decoded from attributedBody when text is NULL).
   */
  listThreads(limit: number, opts: { unreadOnly: boolean }): IMessageThreadRow[] {
    // Exclude tapback/reaction rows (associated_message_type 2000-2005 /
    // 3000-3005, mirroring isTapbackType) from both the unread count and the
    // last-message preview. Without this a tapback inflates the unread badge
    // and a recent tapback can surface as the chat's "last message".
    // COALESCE so normal rows (type 0 or NULL) are kept. The shared
    // `ORDER BY m.date DESC, m.ROWID DESC` tie-break makes all four
    // last-message subqueries resolve to the SAME row on a date tie, so the
    // preview text, timestamp, and direction can't come from different rows.
    const notTapback =
      "NOT (COALESCE(m.associated_message_type, 0) BETWEEN 2000 AND 2005 " +
      "OR COALESCE(m.associated_message_type, 0) BETWEEN 3000 AND 3005)";
    const rows = this.db
      .prepare(
        `SELECT
           c.ROWID                           AS chatId,
           c.guid                            AS guid,
           c.display_name                    AS displayName,
           c.chat_identifier                 AS chatIdentifier,
           c.service_name                    AS service,
           c.style                           AS style,
           (SELECT COUNT(*) FROM message m
              JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
              WHERE cmj.chat_id = c.ROWID AND m.is_read = 0 AND m.is_from_me = 0 AND ${notTapback}) AS unreadCount,
           (SELECT m.date FROM message m
              JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
              WHERE cmj.chat_id = c.ROWID AND ${notTapback}
              ORDER BY m.date DESC, m.ROWID DESC LIMIT 1) AS lastDate,
           (SELECT m.text FROM message m
              JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
              WHERE cmj.chat_id = c.ROWID AND ${notTapback}
              ORDER BY m.date DESC, m.ROWID DESC LIMIT 1) AS lastText,
           (SELECT m.attributedBody FROM message m
              JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
              WHERE cmj.chat_id = c.ROWID AND ${notTapback}
              ORDER BY m.date DESC, m.ROWID DESC LIMIT 1) AS lastBody,
           (SELECT m.is_from_me FROM message m
              JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
              WHERE cmj.chat_id = c.ROWID AND ${notTapback}
              ORDER BY m.date DESC, m.ROWID DESC LIMIT 1) AS lastIsFromMe
         FROM chat c
         ORDER BY lastDate DESC NULLS LAST
         LIMIT ?`
      )
      .all(limit) as Array<{
        chatId: number;
        guid: string;
        displayName: string | null;
        chatIdentifier: string;
        service: string | null;
        style: number | null;
        unreadCount: number;
        lastDate: number | bigint | null;
        lastText: string | null;
        lastBody: Buffer | null;
        lastIsFromMe: number | null;
      }>;

    // Only apply the automated-sender heuristic to 1:1 chats. Group chats
    // (style 43) have synthetic "chatNNN" identifiers that the heuristic can
    // mistake for an alphanumeric service ID and wrongly drop.
    const nonAutomated = rows.filter((r) => r.style === 43 || !looksLikeAutomatedSender(r.chatIdentifier));
    const filtered = opts.unreadOnly ? nonAutomated.filter((r) => r.unreadCount > 0) : nonAutomated;

    return filtered.map((r) => {
      const participants = this.listParticipants(r.chatId);
      const isGroup = r.style === 43 || participants.length > 1;
      const decodedPreview = (r.lastText && r.lastText.length > 0)
        ? r.lastText
        : IMessageDb.decodeAttributedBody(r.lastBody);
      const previewText = decodedPreview || (r.lastBody && r.lastBody.length > 0 ? "[reaction or attachment]" : "");
      const userSetName = (r.displayName && r.displayName.trim()) || null;
      const display = userSetName ||
        (isGroup ? participants.join(", ") || "Group chat" : r.chatIdentifier);
      return {
        guid: r.guid,
        chatId: r.chatId,
        displayName: display,
        userSetName,
        chatIdentifier: r.chatIdentifier,
        service: r.service,
        isGroup,
        unreadCount: r.unreadCount,
        lastMessageAt: appleTimeToIso(r.lastDate),
        lastMessagePreview: (previewText || "").slice(0, 220),
        lastDirection: r.lastIsFromMe === null ? null : r.lastIsFromMe === 1 ? "OUT" : "IN",
        participants
      };
    });
  }

  private listParticipants(chatId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT h.id AS handleId
           FROM handle h
           JOIN chat_handle_join chj ON chj.handle_id = h.ROWID
          WHERE chj.chat_id = ?`
      )
      .all(chatId) as Array<{ handleId: string }>;
    return rows.map((r) => r.handleId);
  }

  /**
   * Map every chat's guid to its participant handle ids (phone numbers /
   * emails). A 1:1 conversation has exactly one handle; group chats have
   * several. Used by the birthday sync to bridge a Thread (keyed by chat
   * guid) back to a contact handle for matching against macOS Contacts.
   */
  listChatHandleMap(): Map<string, string[]> {
    const rows = this.db
      .prepare(
        `SELECT c.guid AS guid, h.id AS handleId
           FROM chat c
           JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
           JOIN handle h ON h.ROWID = chj.handle_id`
      )
      .all() as Array<{ guid: string; handleId: string }>;
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.guid) ?? [];
      list.push(row.handleId);
      map.set(row.guid, list);
    }
    return map;
  }

  private fetchAttachmentsByMessageRowIds(rowIds: number[]): Map<number, IMessageAttachment[]> {
    const map = new Map<number, IMessageAttachment[]>();
    if (rowIds.length === 0) return map;
    // sqlite has no array binding; build a placeholder list of ?,?,?
    const placeholders = rowIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT
           maj.message_id   AS messageRowId,
           a.guid           AS guid,
           a.filename       AS filename,
           a.mime_type      AS mimeType,
           a.transfer_name  AS transferName,
           a.total_bytes    AS totalBytes
         FROM attachment a
         JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
         WHERE maj.message_id IN (${placeholders})`
      )
      .all(...rowIds) as Array<{
        messageRowId: number;
        guid: string | null;
        filename: string | null;
        mimeType: string | null;
        transferName: string | null;
        totalBytes: number | bigint | null;
      }>;
    for (const r of rows) {
      const list = map.get(r.messageRowId) ?? [];
      list.push({
        guid: r.guid ?? "",
        filename: r.filename,
        mimeType: r.mimeType,
        transferName: r.transferName,
        totalBytes: r.totalBytes === null ? null : Number(r.totalBytes),
        kind: classifyAttachment(r.mimeType, r.transferName, r.filename)
      });
      map.set(r.messageRowId, list);
    }
    return map;
  }

  /**
   * Fetch reactions/tapbacks targeting a list of message guids and aggregate
   * by parent. Multiple tapbacks of the same kind from the same sender
   * collapse: a 3000-series (remove) row of the same kind cancels prior 2000-
   * series rows. The result is the latest visible reaction state per parent.
   */
  private fetchReactionsByMessageGuids(messageGuids: string[]): Map<string, IMessageReaction[]> {
    const map = new Map<string, IMessageReaction[]>();
    if (messageGuids.length === 0) return map;

    // Each guid is bound TWICE (the "p:0/<guid>" and "bp:<guid>" prefix
    // forms), so a thread with N messages needs 2N bound parameters. A
    // multi-year heavy thread blows SQLite's SQLITE_MAX_VARIABLE_NUMBER
    // ("too many SQL variables") and the whole thread silently dropped on
    // import. Chunk the guid list (400 -> 800 params/query, safe even on
    // the oldest 999-limit SQLite) and accumulate raw rows; the
    // aggregation below is order-independent (it keeps the latest row per
    // reaction key via lastDate) so running it once over the combined
    // rows is identical to the un-chunked result.
    const CHUNK = 400;
    const rows: Array<{
      parentGuidRaw: string;
      associatedType: number;
      isFromMe: number;
      date: number | bigint | null;
      handleId: number | null;
    }> = [];
    for (let i = 0; i < messageGuids.length; i += CHUNK) {
      const chunk = messageGuids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const chunkRows = this.db
        .prepare(
          `SELECT
             m.associated_message_guid AS parentGuidRaw,
             m.associated_message_type AS associatedType,
             m.is_from_me              AS isFromMe,
             m.date                    AS date,
             m.handle_id               AS handleId
           FROM message m
           WHERE m.associated_message_type BETWEEN 2000 AND 3005
             AND m.associated_message_guid IN (${placeholders},${placeholders})
           ORDER BY m.date ASC`
        )
        .all(
          // associated_message_guid is stored prefixed: "p:0/<guid>" or
          // "bp:<guid>" — bind both forms so we don't miss either.
          ...chunk.map((g) => `p:0/${g}`),
          ...chunk.map((g) => `bp:${g}`)
        ) as Array<{
          parentGuidRaw: string;
          associatedType: number;
          isFromMe: number;
          date: number | bigint | null;
          handleId: number | null;
        }>;
      rows.push(...chunkRows);
    }

    type ReactionKey = string; // `${kind}|${direction}`
    type Aggregator = Map<ReactionKey, { reaction: IMessageReaction; lastDate: number }>;
    const byParent = new Map<string, Aggregator>();

    for (const r of rows) {
      const info = tapbackInfo(r.associatedType);
      if (!info) continue;
      const parentGuid = r.parentGuidRaw.replace(/^(?:p:0\/|bp:)/, "");
      const dir: "IN" | "OUT" = r.isFromMe === 1 ? "OUT" : "IN";
      // Include the reactor's handle so two people in a group adding the
      // same tapback kind don't collapse into one. Outbound reactions have
      // no handle (self), so they key consistently. The apply/remove
      // lifecycle still resolves per-reactor (same handle, latest wins).
      const key = `${info.kind}|${dir}|${r.handleId ?? 0}`;
      const dateNum = typeof r.date === "bigint" ? Number(r.date) : (r.date ?? 0);
      const agg = byParent.get(parentGuid) ?? new Map();
      const prior = agg.get(key);
      if (!prior || dateNum > prior.lastDate) {
        agg.set(key, {
          reaction: {
            emoji: info.emoji,
            kind: info.kind,
            direction: dir,
            timestamp: appleTimeToIso(r.date),
            removed: info.removed
          },
          lastDate: dateNum
        });
      }
      byParent.set(parentGuid, agg);
    }

    for (const [parentGuid, agg] of byParent) {
      // Drop reactions whose latest state is "removed"; keep active ones.
      const live = [...agg.values()].filter((v) => !v.reaction.removed).map((v) => v.reaction);
      if (live.length > 0) map.set(parentGuid, live);
    }
    return map;
  }

  fetchMessages(chatGuid: string, limit: number): IMessageMessageRow[] {
    const chat = this.db.prepare("SELECT ROWID AS chatId FROM chat WHERE guid = ?").get(chatGuid) as
      | { chatId: number }
      | undefined;
    if (!chat) return [];

    const rows = this.db
      .prepare(
        `SELECT
           m.ROWID                       AS rowId,
           m.guid                        AS guid,
           m.text                        AS text,
           m.attributedBody              AS attributedBody,
           m.is_from_me                  AS isFromMe,
           m.date                        AS date,
           m.cache_has_attachments       AS hasAttachments,
           m.associated_message_type     AS associatedType,
           m.associated_message_guid     AS associatedGuid,
           m.thread_originator_guid      AS threadOriginatorGuid,
           h.id                          AS handleId
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN handle h ON h.ROWID = m.handle_id
         WHERE cmj.chat_id = ?
         ORDER BY m.date DESC
         LIMIT ?`
      )
      .all(chat.chatId, limit) as Array<{
        rowId: number;
        guid: string;
        text: string | null;
        attributedBody: Buffer | null;
        isFromMe: number;
        date: number | bigint | null;
        hasAttachments: number;
        associatedType: number | null;
        associatedGuid: string | null;
        threadOriginatorGuid: string | null;
        handleId: string | null;
      }>;

    // Reverse to chronological order, then drop tapback/reaction rows (they
    // belong attached to the parent bubble, not as standalone timeline
    // entries). Stickers and inline attachments stay; we only filter true
    // associated_message_type values for tapbacks (2000-3005 range).
    const chronological = rows.reverse().filter((r) => !isTapbackType(r.associatedType));
    const attachmentsByRowId = this.fetchAttachmentsByMessageRowIds(
      chronological.filter((r) => r.hasAttachments === 1).map((r) => r.rowId)
    );
    const reactionsByGuid = this.fetchReactionsByMessageGuids(chronological.map((r) => r.guid));
    return chronological.map((r) => {
      const decodedText = r.text && r.text.length > 0 ? r.text : IMessageDb.decodeAttributedBody(r.attributedBody);
      const attachments = attachmentsByRowId.get(r.rowId) ?? [];
      // When a bubble has only an attachment (no real text, or just the
      // U+FFFC object-replacement char), surface a typed label so the
      // dashboard renders "[Voice note]" instead of an empty bubble.
      const hasMeaningfulText = decodedText && decodedText.replace(/￼/g, "").trim().length > 0;
      const text = hasMeaningfulText ? decodedText : describeAttachments(attachments);
      // thread_originator_guid is stored as the bare guid (no p:0/ or bp:
      // prefix, unlike associated_message_guid). Normalise defensively
      // anyway so a future macOS version that adds a prefix still parses.
      const replyToGuid = r.threadOriginatorGuid
        ? r.threadOriginatorGuid.replace(/^(?:p:\d+\/|bp:)/, "")
        : undefined;
      return {
        guid: r.guid,
        rowId: r.rowId,
        text: text || "",
        direction: r.isFromMe === 1 ? "OUT" : "IN",
        timestamp: appleTimeToIso(r.date),
        senderHandle: r.handleId ?? undefined,
        hasAttachments: r.hasAttachments === 1,
        attachments,
        reactions: reactionsByGuid.get(r.guid) ?? [],
        replyToGuid
      };
    });
  }

  /**
   * Look up which Messages.app service ("iMessage" or "SMS") a given
   * handle is registered against on this Mac. Returns null when the
   * handle doesn't appear in chat.db's `handle` table at all (i.e. the
   * Mac has never received or sent a message to this handle).
   *
   * Used by the iMessage adapter's send path to prefer the
   * iMessage-registered handle for a contact who has both an iMessage
   * email and an SMS-only phone — otherwise Messages.app silently routes
   * via SMS and (for Macs without Text Message Forwarding from an
   * iPhone) the message fails to deliver.
   */
  findHandleService(handle: string): string | null {
    // chat.db can have multiple rows for the same id (one per service —
    // a phone number used for both SMS and iMessage gets two handle rows).
    // Prefer the iMessage row when both exist so callers see "iMessage"
    // for any handle that has *ever* been iMessage-reachable.
    const row = this.db
      .prepare(
        `SELECT service FROM handle WHERE id = ?
         ORDER BY CASE WHEN service = 'iMessage' THEN 0 ELSE 1 END
         LIMIT 1`
      )
      .get(handle) as { service: string | null } | undefined;
    return row?.service ?? null;
  }

  /**
   * Resolve the chat.db guid of the 1:1 chat that belongs to `handle`.
   *
   * The send path's `pickBestSendHandle` may route a message to a *sibling*
   * handle of the contact (e.g. their iMessage email instead of the SMS
   * phone the Thread happens to be keyed by). Messages.app then delivers the
   * message into that handle's *own* chat row, which has a different chat
   * ROWID — and a different guid — than the chat we looked the Thread up by.
   * The post-send receipt lookups (delivery status / attachments) key on a
   * chat guid, so without re-resolving to the picked handle's chat they
   * miss the row entirely.
   *
   * Restricted to genuinely 1:1 chats (exactly one participant handle) so a
   * group chat that also contains this handle can't be returned. When the
   * handle has more than one 1:1 chat (e.g. one per service), the chat with
   * the most recent message wins — that's the one the send just wrote to.
   * Returns undefined when no 1:1 chat for the handle exists.
   */
  findChatGuidForHandle(handle: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT c.guid AS guid
           FROM chat c
           JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
           JOIN handle h ON h.ROWID = chj.handle_id
          WHERE h.id = ?
            AND (SELECT COUNT(*) FROM chat_handle_join chj2 WHERE chj2.chat_id = c.ROWID) = 1
          ORDER BY (SELECT MAX(m.date) FROM message m
                      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                     WHERE cmj.chat_id = c.ROWID) DESC NULLS LAST
          LIMIT 1`
      )
      .get(handle) as { guid: string | null } | undefined;
    return row?.guid ?? undefined;
  }

  /**
   * Poll chat.db for a freshly-sent outbound message and report whether
   * Messages.app considers it delivered. Returns the most recent
   * outbound row in the chat newer than `afterUnixMs` along with its
   * raw send-state flags.
   *
   * Apple's relevant message columns:
   *   - is_sent       1 once Messages.app has handed it off
   *   - is_delivered  1 once the recipient's device has acknowledged
   *   - error         non-zero on a failed delivery (25 = "send failed",
   *                   common for SMS-fallback when there's no SMS pathway)
   */
  findOutboundDeliveryStatus(chatGuid: string, afterUnixMs: number):
    | {
        rowId: number;
        guid: string;
        service: string | null;
        isSent: boolean;
        isDelivered: boolean;
        error: number;
        timestamp: string;
      }
    | undefined {
    const chat = this.db.prepare("SELECT ROWID AS chatId FROM chat WHERE guid = ?").get(chatGuid) as
      | { chatId: number }
      | undefined;
    if (!chat) return undefined;
    const afterAppleNs = (afterUnixMs - APPLE_EPOCH_OFFSET_MS) * 1e6;
    const row = this.db
      .prepare(
        `SELECT m.ROWID AS rowId, m.guid AS guid, m.service AS service,
                m.is_sent AS isSent, m.is_delivered AS isDelivered, m.error AS error,
                m.date AS appleDate
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          WHERE cmj.chat_id = ?
            AND m.is_from_me = 1
            AND m.date >= ?
          ORDER BY m.date DESC
          LIMIT 1`
      )
      .get(chat.chatId, afterAppleNs) as
      | {
          rowId: number;
          guid: string;
          service: string | null;
          isSent: number;
          isDelivered: number;
          error: number | null;
          appleDate: number;
        }
      | undefined;
    if (!row) return undefined;
    // chat.db stores dates as nanoseconds since the Apple epoch
    // (2001-01-01). Convert to a unix-ms ISO string so the adapter can
    // surface it as the send receipt timestamp directly, avoiding the
    // extra findOutboundSince round-trip the adapter used to fall back to.
    const unixMs = Math.round(row.appleDate / 1e6 + APPLE_EPOCH_OFFSET_MS);
    return {
      rowId: row.rowId,
      guid: row.guid,
      service: row.service,
      isSent: row.isSent === 1,
      isDelivered: row.isDelivered === 1,
      error: row.error ?? 0,
      timestamp: new Date(unixMs).toISOString()
    };
  }

  /**
   * Return guids of every outbound message in `chatGuid` whose chat.db
   * `error` column is non-zero — i.e. Messages.app accepted the send,
   * then later flipped it to "Not Delivered" (most common with
   * SMS-fallback on a recipient whose iMessage activation lags). The
   * scan loop uses this to hard-delete the matching Message rows from
   * our DB so the thread reflects what the recipient actually saw.
   * Unbounded by time on purpose: failures don't self-heal, and the
   * delete-by-guid filter on the Prisma side is a no-op if we never
   * persisted the row.
   */
  findFailedOutboundGuids(chatGuid: string): string[] {
    const chat = this.db.prepare("SELECT ROWID AS chatId FROM chat WHERE guid = ?").get(chatGuid) as
      | { chatId: number }
      | undefined;
    if (!chat) return [];
    const rows = this.db
      .prepare(
        `SELECT m.guid AS guid
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          WHERE cmj.chat_id = ?
            AND m.is_from_me = 1
            AND m.error IS NOT NULL
            AND m.error != 0
            AND m.guid IS NOT NULL`
      )
      .all(chat.chatId) as Array<{ guid: string | null }>;
    return rows.map((r) => r.guid).filter((g): g is string => typeof g === "string" && g.length > 0);
  }

  /**
   * Look up the chat.db attachments for the most-recent outbound message
   * in `chatGuid` newer than `afterUnixMs`. Used by send.ts to capture
   * voice-note / photo / video attachments the operator just sent so the
   * dashboard can render them inline (the dashboard's IMessageMedia
   * component fetches binaries via /data/imessage-attachment/<guid>).
   * Without this, OUT messages with attachments persist with empty
   * attachmentsJson and only the text bubble shows in the dashboard.
   */
  findOutboundAttachments(chatGuid: string, afterUnixMs: number): IMessageAttachment[] {
    const chat = this.db.prepare("SELECT ROWID AS chatId FROM chat WHERE guid = ?").get(chatGuid) as
      | { chatId: number }
      | undefined;
    if (!chat) return [];
    const afterAppleNs = (afterUnixMs - APPLE_EPOCH_OFFSET_MS) * 1e6;
    const row = this.db
      .prepare(
        `SELECT m.ROWID AS rowId
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          WHERE cmj.chat_id = ?
            AND m.is_from_me = 1
            AND m.date >= ?
          ORDER BY m.date DESC
          LIMIT 1`
      )
      .get(chat.chatId, afterAppleNs) as { rowId: number } | undefined;
    if (!row) return [];
    return this.fetchAttachmentsByMessageRowIds([row.rowId]).get(row.rowId) ?? [];
  }

  /**
   * Used right after a send to find the new outbound message and harvest
   * its guid for the SendReceipt. Looks for the most-recent outbound row
   * in the chat with a date strictly newer than `afterAppleNs`.
   */
  findOutboundSince(chatGuid: string, afterUnixMs: number): IMessageMessageRow | undefined {
    const chat = this.db.prepare("SELECT ROWID AS chatId FROM chat WHERE guid = ?").get(chatGuid) as
      | { chatId: number }
      | undefined;
    if (!chat) return undefined;
    // Convert unix ms back to apple-ns for the query.
    const afterAppleNs = (afterUnixMs - APPLE_EPOCH_OFFSET_MS) * 1e6;
    const row = this.db
      .prepare(
        `SELECT m.ROWID AS rowId, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
                m.date AS date, m.cache_has_attachments AS hasAttachments
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
          WHERE cmj.chat_id = ?
            AND m.is_from_me = 1
            AND m.date >= ?
          ORDER BY m.date DESC
          LIMIT 1`
      )
      .get(chat.chatId, afterAppleNs) as
      | { rowId: number; guid: string; text: string | null; attributedBody: Buffer | null; date: number | bigint; hasAttachments: number }
      | undefined;
    if (!row) return undefined;
    const text = row.text && row.text.length > 0 ? row.text : IMessageDb.decodeAttributedBody(row.attributedBody);
    return {
      guid: row.guid,
      rowId: row.rowId,
      text: text || "",
      direction: "OUT",
      timestamp: appleTimeToIso(row.date),
      hasAttachments: row.hasAttachments === 1,
      attachments: [],
      reactions: []
    };
  }
}
