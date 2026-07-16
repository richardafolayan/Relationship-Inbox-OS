"use client";

import type { InboxRow } from "./types";
// Relative import (not "@/lib/..."): this is a runtime dependency and the
// repo tests load this file through tsx, which cannot resolve the Next
// alias for value imports (type-only imports are erased, so types may use
// either form). Same reason feedback.ts imports "./api".
import {
  buildNewMessageNotice,
  buildOverdueDigestBody,
  buildOverdueDigestTitle,
  type OverdueDigestNotificationPerson
} from "./notifications";

// The notification center: a small reviewable log of new-message notices.
// A toast clears itself after a while and a desktop ping is easy to miss;
// the center keeps the same notices until the operator dismisses them, so
// "what came in while I was away" is always answerable from the bell in
// the top bar.
//
// Entries live in localStorage (per browser profile, survive reloads),
// newest first, one per thread: a newer message in the same thread replaces
// the older entry and resets it to unseen. Quiet hours suppress the ping,
// not the record - silenced messages still land here.

export interface CenterNotification {
  // Thread id. Doubles as the dedupe key.
  id: string;
  title: string;
  body: string;
  href: string;
  // Epoch ms when the notice was recorded.
  at: number;
  // Seen means the operator has had a look (opened the panel, or explicitly
  // dismissed the matching toast). Unseen entries drive the bell badge.
  seen: boolean;
}

export const NOTIFICATION_CENTER_STORAGE_KEY = "notification_center_v1";

// Plenty for review without growing into an archive. Oldest fall off first.
export const NOTIFICATION_CENTER_CAP = 50;

const CHANGE_EVENT = "inbox-notification-center";

// ---------------------------------------------------------------------------
// Pure core - list reducers, unit-testable without a DOM.
// ---------------------------------------------------------------------------

// Prepend `additions` (newest first), replacing any existing entry for the
// same thread, and trim to the cap.
export function addNotifications(
  existing: CenterNotification[],
  additions: CenterNotification[]
): CenterNotification[] {
  const replaced = new Set(additions.map((entry) => entry.id));
  const kept = existing.filter((entry) => !replaced.has(entry.id));
  return [...additions, ...kept].slice(0, NOTIFICATION_CENTER_CAP);
}

export function removeNotification(
  existing: CenterNotification[],
  id: string
): CenterNotification[] {
  return existing.filter((entry) => entry.id !== id);
}

export function removeNotifications(
  existing: CenterNotification[],
  ids: string[]
): CenterNotification[] {
  const targets = new Set(ids);
  return existing.filter((entry) => !targets.has(entry.id));
}

export function markNotificationsSeen(
  existing: CenterNotification[],
  ids: string[]
): CenterNotification[] {
  const targets = new Set(ids);
  return existing.map((entry) =>
    targets.has(entry.id) && !entry.seen ? { ...entry, seen: true } : entry
  );
}

export function markAllNotificationsSeen(existing: CenterNotification[]): CenterNotification[] {
  return existing.map((entry) => (entry.seen ? entry : { ...entry, seen: true }));
}

// Pilot R-0091 (#758): replying to a thread resolves its new-message notice.
// Given the latest inbox rows, drop any entry whose thread now shows a reply
// (needsReply flipped false, or the newest message is outbound). Matching is
// by row id, so non-thread entries (the overdue digest, app updates) are
// never touched; threads MISSING from `rows` are also left alone - a partial
// or failed fetch must not wipe the center.
export function pruneRepliedNotifications(
  existing: CenterNotification[],
  rows: Array<Pick<InboxRow, "id" | "needsReply" | "lastMessageDirection">>
): CenterNotification[] {
  if (existing.length === 0 || rows.length === 0) return existing;
  const replied = new Set(
    rows
      .filter((row) => row.needsReply === false || row.lastMessageDirection === "OUT")
      .map((row) => row.id)
  );
  if (replied.size === 0) return existing;
  return existing.filter((entry) => !replied.has(entry.id));
}

export function unseenNotificationCount(items: CenterNotification[]): number {
  return items.reduce((count, entry) => (entry.seen ? count : count + 1), 0);
}

// Stored JSON -> entries. Anything malformed (bad JSON, wrong shape, a
// hand-edited value) degrades to an empty/filtered list instead of throwing
// during render.
export function parseStoredNotifications(raw: string | null): CenterNotification[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCenterNotification).slice(0, NOTIFICATION_CENTER_CAP);
  } catch {
    return [];
  }
}

function isCenterNotification(value: unknown): value is CenterNotification {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.body === "string" &&
    typeof entry.href === "string" &&
    typeof entry.at === "number" &&
    typeof entry.seen === "boolean"
  );
}

// ---------------------------------------------------------------------------
// Storage + change fan-out.
// ---------------------------------------------------------------------------

export function readCenterNotifications(): CenterNotification[] {
  if (typeof window === "undefined") return [];
  try {
    return parseStoredNotifications(window.localStorage.getItem(NOTIFICATION_CENTER_STORAGE_KEY));
  } catch {
    // localStorage itself can throw (privacy mode); treat as empty.
    return [];
  }
}

function writeCenterNotifications(items: CenterNotification[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NOTIFICATION_CENTER_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Quota / privacy mode: the bell quietly degrades, toasts still work.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

// Generic write path: prepend entries (replacing same-id ones) and persist.
// Used by every notice source - new messages below, app updates in
// lib/update-notice.ts - so the storage/fan-out rules live in one place.
export function recordCenterNotifications(additions: CenterNotification[]): void {
  if (typeof window === "undefined" || additions.length === 0) return;
  writeCenterNotifications(addNotifications(readCenterNotifications(), additions));
}

// Record one center entry per fresh thread. Called for every batch that
// detectNewInbound surfaces, whatever the delivery plan was (toast, desktop
// ping, or quiet-hours silence) - missing the alert must not mean missing
// the record.
export function recordNewMessageNotifications(rows: InboxRow[], now?: number): void {
  if (typeof window === "undefined" || rows.length === 0) return;
  const at = now ?? Date.now();
  const additions = rows.map((row) => {
    const notice = buildNewMessageNotice(row);
    return {
      id: row.id,
      title: notice.title,
      body: notice.body,
      href: notice.href,
      at,
      seen: false
    };
  });
  recordCenterNotifications(additions);
}

// The overdue-reply digest's bell entry (#360). A fixed id, not a thread id:
// addNotifications' replace-by-id rule then guarantees the center holds at
// most ONE digest reminder - a newer digest replaces the previous entry and
// resets it to unseen instead of piling up day after day.
export const OVERDUE_DIGEST_NOTIFICATION_ID = "overdue-digest";

// Record the due digest in the center. This is the digest's PRIMARY
// delivery surface: it happens whether or not desktop permission is granted
// and whether or not the tab is visible, so the reminder always lands
// somewhere the operator actually looks. The desktop ping (lib/
// notifications.ts notifyOverdueReplyDigest) is an optional extra on top.
export function recordOverdueDigestNotification(
  people: OverdueDigestNotificationPerson[],
  now?: number
): void {
  if (typeof window === "undefined" || people.length === 0) return;
  const at = now ?? Date.now();
  writeCenterNotifications(
    addNotifications(readCenterNotifications(), [
      {
        id: OVERDUE_DIGEST_NOTIFICATION_ID,
        title: buildOverdueDigestTitle(people.length),
        body: buildOverdueDigestBody(people),
        href: "/today",
        at,
        seen: false
      }
    ])
  );
}

export function dismissCenterNotification(id: string): void {
  if (typeof window === "undefined") return;
  writeCenterNotifications(removeNotification(readCenterNotifications(), id));
}

export function dismissCenterNotifications(ids: string[]): void {
  if (typeof window === "undefined" || ids.length === 0) return;
  writeCenterNotifications(removeNotifications(readCenterNotifications(), ids));
}

// Storage wrapper for pruneRepliedNotifications (#758). Called on every
// inbox poll; writes (and fans out a re-render) only when something was
// actually removed, so the 8s poll doesn't thrash localStorage.
export function pruneRepliedCenterNotifications(
  rows: Array<Pick<InboxRow, "id" | "needsReply" | "lastMessageDirection">>
): void {
  if (typeof window === "undefined" || rows.length === 0) return;
  const existing = readCenterNotifications();
  const pruned = pruneRepliedNotifications(existing, rows);
  if (pruned.length !== existing.length) writeCenterNotifications(pruned);
}

export function clearCenterNotifications(): void {
  if (typeof window === "undefined") return;
  writeCenterNotifications([]);
}

export function markCenterNotificationsSeen(ids: string[]): void {
  if (typeof window === "undefined" || ids.length === 0) return;
  writeCenterNotifications(markNotificationsSeen(readCenterNotifications(), ids));
}

export function markAllCenterNotificationsSeen(): void {
  if (typeof window === "undefined") return;
  writeCenterNotifications(markAllNotificationsSeen(readCenterNotifications()));
}

// Re-render hook: fires on every same-tab write (custom event) and on writes
// from sibling tabs (the browser's storage event). Returns an unsubscribe.
export function onCenterNotificationsChange(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === NOTIFICATION_CENTER_STORAGE_KEY) handler();
  };
  window.addEventListener(CHANGE_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}
