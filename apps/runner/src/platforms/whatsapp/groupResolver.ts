// Maps a whatsapp-web.js Chat to the enriched ThreadStub the rest of the
// pipeline writes to the DB. Groups go through the v1 single-Person hack:
// the Thread carries isGroup / groupName / groupId, and Thread.personId
// points at a synthetic Person whose handle equals the group JID and
// whose displayName equals the group name. Per-message sender identity
// lives on Message.senderName, populated by the adapter from msg.author.
//
// This module is intentionally pure — no Prisma, no whatsapp-web.js
// imports. Takes the small subset of the Chat shape it actually needs.
// scan-queue handles the upsert based on the returned stub.

import type { ThreadStub } from "@inbox-os/core";
import { renderMessageText } from "./messageText";

/** Subset of the whatsapp-web.js Chat shape this resolver consumes. */
export interface WhatsAppChatLike {
  id: { _serialized: string };
  name?: string;
  isGroup?: boolean;
  unreadCount?: number;
  /** Epoch SECONDS — wweb.js convention. Optional because brand-new chats
   *  have no message yet. */
  timestamp?: number;
  /** Last message on the chat. We read `type`/`hasMedia` too so the preview
   *  goes through the same renderer as the timeline: a base64 media payload
   *  becomes a "[image]"/"[media]" placeholder rather than dumping the encoded
   *  bytes into the inbox row. (Poll option details are intentionally omitted
   *  here — wweb.js's Chat type declares them as `string[]` which conflicts
   *  with the runtime shape; a poll last-message still previews as "📊 Poll".) */
  lastMessage?:
    | {
        body?: string;
        type?: string;
        hasMedia?: boolean;
      }
    | null;
}

/**
 * Build the ThreadStub for a chat. The same shape works for 1:1 and group
 * chats — the difference shows up in the optional `isGroup` / `groupName` /
 * `groupId` fields, which are only set for groups, plus the `handle` field
 * which carries the JID so scan-queue can look up the Person by stable
 * identifier rather than by display name (group names collide; JIDs don't).
 */
export function chatToThreadStub(chat: WhatsAppChatLike): ThreadStub {
  const jid = chat.id._serialized;
  const isGroup = Boolean(chat.isGroup);
  const displayName = (chat.name ?? "").trim() || (isGroup ? "Unnamed group" : jid);
  const lastMessageAt = chat.timestamp
    ? new Date(chat.timestamp * 1000).toISOString()
    : undefined;
  const lastMessagePreview = (
    chat.lastMessage ? renderMessageText(chat.lastMessage) : ""
  ).slice(0, 280);

  return {
    platformThreadId: jid,
    displayName,
    unreadCount: chat.unreadCount ?? undefined,
    lastMessagePreview,
    lastMessageAt,
    isGroup,
    groupName: isGroup ? displayName : undefined,
    isUnreadCandidate: (chat.unreadCount ?? 0) > 0
  };
}
