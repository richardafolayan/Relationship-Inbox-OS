import type { InboxRow } from "@/lib/types";

// Proactive new-message notifications.
//
// The runner has no per-message push event, so "a new message arrived" is
// derived on the client: every inbox poll is reduced to a snapshot of
// thread id -> last-inbound time, and the next poll diffs against it. A
// thread whose inbound timestamp advanced (or that is brand new) gained a
// message. The AI `whatTheyWant` line rides along as the notification body
// so the alert carries context, not just "you have mail".

// Maps thread id -> epoch-ms of its most recent inbound message (0 when a
// thread has no inbound message yet).
export type InboxSnapshot = Map<string, number>;

function inboundTime(row: InboxRow): number {
  if (!row.lastInboundAt) return 0;
  const parsed = Date.parse(row.lastInboundAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function snapshotInbox(rows: InboxRow[]): InboxSnapshot {
  const snapshot: InboxSnapshot = new Map();
  for (const row of rows) {
    snapshot.set(row.id, inboundTime(row));
  }
  return snapshot;
}

// Threads that gained a new inbound message since `previous` was captured:
// the last-inbound timestamp advanced (or the thread is brand new) AND it
// still needs a reply. A thread the operator already handled - or one
// where only an outbound send changed - is not new mail.
export function detectNewInbound(previous: InboxSnapshot, rows: InboxRow[]): InboxRow[] {
  const fresh: InboxRow[] = [];
  for (const row of rows) {
    if (row.needsReply === false) continue;
    const current = inboundTime(row);
    if (current === 0) continue;
    const seen = previous.get(row.id);
    if (seen === undefined || current > seen) {
      fresh.push(row);
    }
  }
  return fresh;
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// Asks for permission once. Browsers no-op the call when permission is
// already granted or denied, so it is safe to fire on every mount.
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

function contextLine(row: InboxRow): string {
  const context = row.whatTheyWant?.trim();
  if (context) return context;
  const preview = row.preview?.trim();
  if (preview && preview !== "No summary yet") return preview;
  return "Open the conversation to catch up.";
}

function show(title: string, body: string, tag: string, onClick: () => void): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    // Some contexts expose Notification but block the constructor (e.g.
    // notifications only allowed from a service worker). Nothing to do.
  }
}

// One context-rich notification for a single new message. `tag` keys it to
// the thread so a re-poll of the same message never stacks a duplicate.
export function notifyNewMessage(row: InboxRow, onOpen: (threadId: string) => void): void {
  show(`${row.personName} messaged you`, contextLine(row), `inbox-os:thread:${row.id}`, () =>
    onOpen(row.id)
  );
}

// A single roll-up when several messages land at once (e.g. a scan that
// catches up a stale inbox) - notifying per-thread would be a storm.
export function notifyNewMessageDigest(rows: InboxRow[], onOpen: () => void): void {
  const [first, ...rest] = rows;
  const body = first
    ? `${first.personName} and ${rest.length} ${rest.length === 1 ? "other" : "others"} are waiting on a reply.`
    : "Several conversations are waiting on a reply.";
  show(`${rows.length} new messages`, body, "inbox-os:digest", onOpen);
}
