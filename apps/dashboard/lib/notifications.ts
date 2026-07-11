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

// The current desktop-notification permission, or "unsupported" when the
// browser has no Notification API. A thin reader so callers never touch the
// global directly and stay consistent with notificationsSupported().
export function readNotificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

// Keep a component in sync with the live permission after it mounts.
//
// Permission can flip while the page is open - e.g. the operator grants it
// from a sibling control, or toggles it in the browser's site settings. A
// component that only read Notification.permission on mount would stay stale
// until reload (this was the overdue-digest cadence bug: it stayed disabled
// after a grant). This subscribes to both signals that catch a change without
// a reload:
//   - navigator.permissions 'change' - fires whenever the notifications
//     permission flips, from any source in the same session.
//   - window 'focus' - a belt-and-braces fallback for browsers where the
//     Permissions API is missing or its change event lags after the prompt.
// Each calls onChange with the freshly-read permission. Returns a cleanup
// that removes every listener. No-op (returns a no-op cleanup) when the
// browser has no Notification API.
export function subscribeNotificationPermission(
  onChange: (permission: NotificationPermission | "unsupported") => void
): () => void {
  if (typeof window === "undefined" || !notificationsSupported()) {
    return () => {};
  }
  const handler = () => onChange(readNotificationPermission());
  window.addEventListener("focus", handler);

  // navigator.permissions may be absent (older Safari) or reject for the
  // "notifications" name; both are fine - the focus listener still covers us.
  let permissionStatus: { removeEventListener: (type: string, cb: () => void) => void } | null =
    null;
  // permissions.query is async: the caller can run this cleanup BEFORE it
  // resolves (a fast mount/unmount, or React Strict Mode's mount-unmount-
  // remount). `cancelled` lets the resolved branch detect that and skip
  // attaching - otherwise it would add a 'change' listener bound to a stale
  // onChange that nothing could ever remove (a leaked listener per cycle).
  let cancelled = false;
  const permissions = (navigator as Navigator & { permissions?: Permissions }).permissions;
  if (permissions && typeof permissions.query === "function") {
    permissions
      .query({ name: "notifications" as PermissionName })
      .then((status) => {
        if (cancelled) return;
        permissionStatus = status;
        status.addEventListener("change", handler);
      })
      .catch(() => {
        // Permission name unsupported / blocked - rely on the focus listener.
      });
  }

  return () => {
    cancelled = true;
    window.removeEventListener("focus", handler);
    permissionStatus?.removeEventListener("change", handler);
  };
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

// How long a new-message toast stays up before clearing itself. At least 30
// seconds (operator request): long enough to read and decide without
// rushing. The notification center keeps the notice after expiry, so the
// timeout only ends the interruption, never loses the message.
export const NEW_MESSAGE_TOAST_DURATION_MS = 30_000;

function contextLine(row: InboxRow): string {
  const context = row.whatTheyWant?.trim();
  if (context) return context;
  const preview = row.preview?.trim();
  if (preview && preview !== "No summary yet") return preview;
  return "Open the conversation to catch up.";
}

// Title / body / route for a new-message notice. The same shape feeds both
// the desktop Notification (hidden tab) and the in-app toast (focused tab),
// so the wording stays identical however the operator is alerted.
export interface NewMessageNotice {
  title: string;
  body: string;
  href: string;
}

export function buildNewMessageNotice(row: InboxRow): NewMessageNotice {
  return {
    title: `${row.personName} messaged you`,
    body: contextLine(row),
    href: `/thread/${row.id}`
  };
}

export function buildNewMessageDigestNotice(rows: InboxRow[]): NewMessageNotice {
  const [first, ...rest] = rows;
  const body = first
    ? `${first.personName} and ${rest.length} ${rest.length === 1 ? "other" : "others"} are waiting on a reply.`
    : "Several conversations are waiting on a reply.";
  return {
    title: `${rows.length} new messages`,
    body,
    href: "/today"
  };
}

// Where a batch of fresh inbound messages should surface. One decision
// function so the matrix is testable without a DOM and the AppShell stays
// thin:
//   - nothing fresh                     -> "none"
//   - tab hidden, quiet hours on        -> "none" (do-not-disturb window)
//   - tab hidden, 1-3 fresh             -> "desktop-single" (one OS ping each)
//   - tab hidden, 4+ fresh              -> "desktop-digest" (one roll-up ping)
//   - tab focused, 1-3 fresh            -> "toast-single" (one in-app toast each)
//   - tab focused, 4+ fresh             -> "toast-digest" (one roll-up toast)
// Quiet hours only gates the desktop ping: an in-app toast is passive and
// is only ever seen when the operator is already looking at the app.
export type NewMessageNoticePlan =
  | "none"
  | "desktop-single"
  | "desktop-digest"
  | "toast-single"
  | "toast-digest";

export function planNewMessageNotice(input: {
  freshCount: number;
  tabHidden: boolean;
  quietHoursActive: boolean;
}): NewMessageNoticePlan {
  if (input.freshCount <= 0) return "none";
  if (input.tabHidden) {
    if (input.quietHoursActive) return "none";
    return input.freshCount <= 3 ? "desktop-single" : "desktop-digest";
  }
  return input.freshCount <= 3 ? "toast-single" : "toast-digest";
}

// The Today permission CTA shows only when the browser supports
// notifications, the operator has not yet decided (permission "default"),
// and they have not dismissed the prompt. Granted / denied / unsupported
// all hide it, so it never nags and never re-asks a settled browser. This
// keeps the #359 rule: permission is requested behind an explicit gesture,
// never on a cold mount.
export function shouldShowNotificationCta(input: {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  dismissed: boolean;
}): boolean {
  return input.supported && input.permission === "default" && !input.dismissed;
}

function show(title: string, body: string, tag: string, onClick: () => void): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  try {
    const notification = new Notification(title, { body, tag });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
    return true;
  } catch {
    // Some contexts expose Notification but block the constructor (e.g.
    // notifications only allowed from a service worker). Nothing to do.
    return false;
  }
}

// One context-rich notification for a single new message. `tag` keys it to
// the thread so a re-poll of the same message never stacks a duplicate.
export function notifyNewMessage(row: InboxRow, onOpen: (threadId: string) => void): void {
  const notice = buildNewMessageNotice(row);
  show(notice.title, notice.body, `inbox-os:thread:${row.id}`, () => onOpen(row.id));
}

// A single roll-up when several messages land at once (e.g. a scan that
// catches up a stale inbox) - notifying per-thread would be a storm.
export function notifyNewMessageDigest(rows: InboxRow[], onOpen: () => void): void {
  const notice = buildNewMessageDigestNotice(rows);
  show(notice.title, notice.body, "inbox-os:digest", onOpen);
}

export function notifyAppUpdateAvailable(latestVersion: string, onUpdate: () => void): boolean {
  return show(
    `Update available v${latestVersion}`,
    "Click to update and reopen Tovi.",
    `inbox-os:update:${latestVersion}`,
    onUpdate
  );
}

// The calm overdue-reply digest (#360). One notification per cadence tick,
// never one per thread. Stable tag prevents duplicates if the scheduler
// fires twice before the browser dismisses the first. British English,
// no guilt phrasing, no em dashes.
export interface OverdueDigestNotificationPerson {
  personId: string;
  personName: string;
}

export function buildOverdueDigestTitle(count: number): string {
  if (count <= 1) return "1 person still needs a reply";
  return `${count} people still need replies`;
}

export function buildOverdueDigestBody(people: OverdueDigestNotificationPerson[]): string {
  const names = people.map((p) => p.personName.trim()).filter(Boolean);
  if (names.length === 0) return "A few conversations are still open.";
  if (names.length === 1) return `${names[0]} is still open.`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are still open.`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are still open.`;
  const [a, b, ...rest] = names;
  const remaining = rest.length;
  return `${a}, ${b} and ${remaining} ${remaining === 1 ? "other" : "others"} are still open.`;
}

// Returns true only when the Notification constructor actually succeeded.
// The AppShell scheduler uses this signal to decide whether to call /ack
// on the runner — we never ack unless a notification was really created.
export function notifyOverdueReplyDigest(
  people: OverdueDigestNotificationPerson[],
  onOpenToday: () => void
): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false;
  if (people.length === 0) return false;
  try {
    const notification = new Notification(buildOverdueDigestTitle(people.length), {
      body: buildOverdueDigestBody(people),
      tag: "inbox-os:overdue-digest"
    });
    notification.onclick = () => {
      window.focus();
      onOpenToday();
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}
