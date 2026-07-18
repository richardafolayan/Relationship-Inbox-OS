// Pure helpers for the Settings > Notifications redesign (#907).
// Device labels, permission captions, and digest preview copy stay testable
// without React or the Notification API.

export type NotificationClientKind = "phone" | "mac" | "browser";

export interface NotificationClientHints {
  userAgent?: string;
  maxTouchPoints?: number;
  pointerCoarse?: boolean;
  /** Viewport width in CSS pixels; under 640 is treated as phone-sized. */
  viewportWidth?: number;
}

/**
 * Classify the current client so notification copy can say "this phone"
 * instead of "desktop" / "browser" when the operator is on iPhone access.
 */
export function classifyNotificationClient(
  hints: NotificationClientHints = {}
): NotificationClientKind {
  const ua = hints.userAgent ?? "";
  const uaLower = ua.toLowerCase();
  if (
    /iphone|ipod|ipad|android|mobile/.test(uaLower) ||
    ((hints.maxTouchPoints ?? 0) > 0 &&
      (hints.pointerCoarse === true || (hints.viewportWidth ?? 1024) < 640))
  ) {
    if (/iphone|ipod|ipad|android|mobile/.test(uaLower)) return "phone";
    if ((hints.viewportWidth ?? 1024) < 640) return "phone";
  }
  // Electron / packaged desktop shell looks like a browser UA without mobile
  // tokens; treat non-mobile as Mac for this Mac-first product.
  if (/macintosh|mac os x|electron/i.test(ua) || !ua) return "mac";
  return "browser";
}

export function messageNotificationsTitle(client: NotificationClientKind): string {
  return "Message notifications";
}

export function messageNotificationsDeviceLine(client: NotificationClientKind): string {
  if (client === "phone") return "On this phone";
  if (client === "mac") return "On this Mac";
  return "In this browser";
}

export function messageNotificationsDescription(client: NotificationClientKind): string {
  // Phone/browser use the page Notification API while the app is open.
  // There is no background push subscription yet, so do not promise
  // iOS background or killed-app delivery.
  if (client === "phone") {
    return "Show a system alert when a new message is noticed while this app is open on your phone. Alerts may not arrive if the app is fully closed. Quiet hours still apply.";
  }
  if (client === "mac") {
    return "Show a system alert when a new message arrives. Clicking it opens the thread. Quiet hours still apply, and nothing fires while this window is focused.";
  }
  return "Show a system alert when a new message is noticed while this tab is open. Quiet hours still apply, and nothing fires while this tab is focused.";
}

/**
 * Caption beside the message-notification switch. Avoids "turn off in your
 * browser" wording that confuses phone users; names the real control surface
 * for granted/denied states that cannot be flipped from the app.
 */
export function messageNotificationsPermissionCaption(
  permission: NotificationPermission | "unsupported",
  client: NotificationClientKind,
  busy = false
): string {
  if (permission === "unsupported") {
    return client === "phone" ? "Not available on this phone" : "Not supported here";
  }
  if (permission === "granted") {
    if (client === "phone") return "On · turn off in phone settings";
    if (client === "mac") return "On · turn off in System Settings";
    return "On · turn off in site settings";
  }
  if (permission === "denied") {
    if (client === "phone") return "Blocked · re-enable in phone settings";
    if (client === "mac") return "Blocked · re-enable in System Settings";
    return "Blocked · re-enable in site settings";
  }
  if (busy) return "asking\u2026";
  return "Off";
}

export function phoneNotificationsGroupHead(client: NotificationClientKind): string {
  return client === "phone" ? "Phone notifications" : "This device";
}

export function macNotificationsGroupHead(): string {
  return "Mac notifications and scanning";
}

export function macNotificationsGroupSubhead(): string {
  return "Runs on the Mac where the app is open";
}

export function quietHoursDescription(): string {
  return "Pauses alerts and Mac scanning during the window.";
}

export function quietHoursSwitchLabel(): string {
  return "Quiet hours";
}

export function digestFrequencyLabel(): string {
  return "How often";
}

export function digestDescription(): string {
  return "One calm reminder for overdue replies. Lands in the notification bell on this device. Mac scanning is unaffected.";
}

export function digestPreviewLabel(): string {
  return "Who would be included";
}

export function digestPreviewHint(): string {
  return "Preview only. Open a digest from the notification bell to act on people.";
}

export function digestBackgroundPingHint(client: NotificationClientKind): string {
  // Align with foreground-only delivery: digests land in the in-app bell;
  // optional OS pings only fire when the app can run the Notification API.
  if (client === "phone") {
    return "Turn on message notifications if you also want a system ping while the app is open on your phone.";
  }
  if (client === "mac") {
    return "Turn on message notifications if you also want a Mac ping when the app notices new mail.";
  }
  return "Turn on message notifications if you also want a system ping while this tab is open.";
}

export const DIGEST_CADENCE_OPTIONS = [
  { id: "off" as const, label: "Off" },
  { id: "daily" as const, label: "Daily" },
  { id: "weekly" as const, label: "Weekly" }
];

export function readClientHintsFromWindow(
  win: Window & { matchMedia?: (query: string) => MediaQueryList } = window
): NotificationClientHints {
  const nav = win.navigator;
  let pointerCoarse = false;
  try {
    pointerCoarse = Boolean(win.matchMedia?.("(pointer: coarse)")?.matches);
  } catch {
    pointerCoarse = false;
  }
  return {
    userAgent: nav?.userAgent,
    maxTouchPoints: nav?.maxTouchPoints,
    pointerCoarse,
    viewportWidth: win.innerWidth
  };
}
