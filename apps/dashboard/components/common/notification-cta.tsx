"use client";

import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import {
  readNotificationPermission,
  requestNotificationPermission,
  shouldShowNotificationCta,
  subscribeNotificationPermission
} from "@/lib/notifications";

// #359 keeps notification permission behind an explicit gesture (a cold
// auto-prompt gets denied / permanently blocked by browsers). The Settings
// toggle satisfied that but was easy to miss, so a new message never alerted
// anyone who had not gone hunting for it. This calm banner makes the ask
// discoverable on Today (where "who is waiting" lives) without re-prompting:
// it only appears while permission is still "default" and not dismissed, and
// it requests permission from a click handler, never on mount.
const DISMISS_KEY = "notification_cta_dismissed";

export function NotificationCta() {
  // undefined until the client reads permission + storage, so the banner
  // never flashes during SSR / first paint before we know the real state.
  const [visible, setVisible] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Re-sync on every permission change (a grant/block from elsewhere — the
    // Settings toggle, OS settings, another tab) and read `dismissed` FRESH each
    // time so a mid-session dismiss is honoured. Returns the unsubscribe so the
    // listener is cleaned up on unmount.
    const sync = () => {
      const permission = readNotificationPermission();
      const supported = permission !== "unsupported";
      const dismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
      setVisible(shouldShowNotificationCta({ supported, permission, dismissed }));
    };
    sync();
    return subscribeNotificationPermission(sync);
  }, []);

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await requestNotificationPermission();
      // Granted or denied: the CTA has done its job either way, so retire it
      // for this session. "default" (the prompt was dismissed without a
      // choice) leaves it up to ask again next visit.
      if (result !== "default") setVisible(false);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Storage disabled: the banner just reappears next mount. No crash.
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <section
      data-testid="notification-cta"
      className="relative mb-6 flex items-start gap-4 overflow-hidden rounded-card border border-hairline bg-paper p-5 shadow-card"
    >
      <span
        aria-hidden
        className="mt-[2px] grid h-8 w-8 flex-none place-items-center rounded-full bg-paper-2 text-ink-2"
      >
        <Bell className="h-[16px] w-[16px]" strokeWidth={1.7} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[14.5px] font-medium text-ink">Turn on reply notifications</p>
        <p className="m-0 mt-1 max-w-[60ch] text-[12.5px] leading-[1.5] text-ink-3">
          Get a desktop alert when a message lands while you are away, and a quiet in-app note
          while you are here. Quiet hours still apply, and you can turn it off any time in
          Settings.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-[10px]">
          <button
            type="button"
            onClick={() => void enable()}
            disabled={busy}
            className="inline-flex items-center rounded-pill border border-transparent bg-ink px-[14px] py-[7px] text-[12.5px] font-medium text-paper transition-colors duration-calm hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Asking…" : "Enable notifications"}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center rounded-pill border border-hairline px-[14px] py-[7px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink"
          >
            Not now
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notification prompt"
        title="Dismiss"
        className="-mr-1 -mt-1 grid h-7 w-7 flex-none place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
      >
        <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
      </button>
    </section>
  );
}
