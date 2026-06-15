"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import {
  clearCenterNotifications,
  dismissCenterNotification,
  markAllCenterNotificationsSeen,
  markCenterNotificationsSeen,
  onCenterNotificationsChange,
  readCenterNotifications,
  unseenNotificationCount,
  type CenterNotification
} from "@/lib/notification-center";
import { startAppUpdate } from "@/lib/app-update-action";
import { UPDATE_NOTICE_ID } from "@/lib/update-notice";
import { resolveCenterRowGesture } from "@/lib/toast-gesture";
import { formatRelative } from "@/lib/time";

// The bell in the top bar plus the slide-over it opens. New-message notices
// collect in the center (lib/notification-center.ts) until the operator
// dismisses them here - a toast that cleared itself is reviewable, nothing
// is lost to a 30 second timer. Each row opens its thread on click, and is
// dismissed with its X or a left swipe.

export function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<CenterNotification[]>([]);
  const [open, setOpen] = useState(false);
  // Snapshot of which entries were unseen when the panel opened. Opening
  // marks everything seen in the store (the badge clears), but the rows
  // keep their "new" dot for this viewing so the operator can still tell
  // what arrived since they last looked.
  const [newAtOpen, setNewAtOpen] = useState<Set<string>>(() => new Set());
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // localStorage is client-only: read after mount (SSR renders a bare bell)
  // and stay in sync with every write, including ones from sibling tabs.
  useEffect(() => {
    setItems(readCenterNotifications());
    return onCenterNotificationsChange(() => setItems(readCenterNotifications()));
  }, []);

  const openPanel = useCallback(() => {
    setNewAtOpen(new Set(readCenterNotifications().filter((n) => !n.seen).map((n) => n.id)));
    setOpen(true);
    markAllCenterNotificationsSeen();
  }, []);

  const closePanel = useCallback(() => setOpen(false), []);

  // Escape closes, and focus starts on the close button so keyboard users
  // are inside the dialog they just opened.
  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const openNotice = useCallback(
    (item: CenterNotification) => {
      // Opening a thread completes a message notice, so the row goes. The
      // update reminder's completing act is updating, so clicking it starts
      // the update instead of routing through Settings.
      if (item.id === UPDATE_NOTICE_ID) {
        markCenterNotificationsSeen([item.id]);
        setOpen(false);
        void startAppUpdate();
        return;
      } else {
        dismissCenterNotification(item.id);
      }
      setOpen(false);
      router.push(item.href);
    },
    [router]
  );

  const unseen = unseenNotificationCount(items);
  const badge = unseen > 9 ? "9+" : String(unseen);

  return (
    <>
      <button
        type="button"
        data-testid="notification-bell"
        onClick={openPanel}
        title="Notifications"
        aria-label={unseen > 0 ? `Notifications, ${unseen} new` : "Notifications"}
        className="relative inline-flex items-center rounded-pill border border-hairline-strong p-[5px] text-ink-2 transition-colors duration-calm hover:border-[color-mix(in_srgb,var(--accent)_30%,transparent)] hover:text-ink"
      >
        <Bell className="h-[12px] w-[12px]" strokeWidth={1.7} />
        {unseen > 0 ? (
          <span
            data-testid="notification-bell-badge"
            className="absolute -right-[6px] -top-[6px] flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-accent px-[3px] font-mono text-[9px] font-medium leading-none text-paper"
          >
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        // Portalled to <body>: the bell lives inside the TopStatus bar,
        // whose sticky z-30 container is its own stacking context - a
        // fixed overlay rendered in place would be capped at z-30 and lose
        // to the ToastHost (z-50) no matter what z-index it claims.
        // z-[60]: above the ToastHost. A toast that fires while the panel
        // is open would otherwise sit on top of the list and intercept row
        // clicks - the panel shows the same arrival as a live row, so it
        // wins while open and the toast quietly expires underneath.
        createPortal(
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Notifications">
          <div className="absolute inset-0 bg-ink/40" onClick={closePanel} />
          <div
            data-testid="notification-center-panel"
            className="absolute inset-y-0 right-0 flex w-[340px] max-w-[92vw] flex-col border-l border-hairline bg-paper shadow-xl"
          >
            <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
              <p className="font-display text-[15px] font-medium tracking-[-0.012em] text-ink">
                Notifications
              </p>
              <div className="ml-auto flex items-center gap-2">
                {items.length > 0 ? (
                  <button
                    type="button"
                    data-testid="notification-center-clear-all"
                    onClick={clearCenterNotifications}
                    className="font-mono text-[11px] text-ink-3 underline-offset-2 transition-colors duration-calm hover:text-ink hover:underline"
                  >
                    Clear all
                  </button>
                ) : null}
                <button
                  ref={closeButtonRef}
                  type="button"
                  aria-label="Close notifications"
                  onClick={closePanel}
                  className="rounded-md p-1 text-ink-3 transition-colors hover:bg-hairline/60 hover:text-ink-1"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M3 3l6 6M9 3l-6 6"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </div>

            {items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
                <p className="text-[13px] font-medium text-ink-2">No notifications</p>
                <p className="font-mono text-[11px] leading-snug text-ink-3">
                  New messages collect here until you dismiss them.
                </p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-3 py-3">
                <div className="flex flex-col gap-2">
                  {items.map((item) => (
                    <CenterRow
                      key={item.id}
                      item={item}
                      isNew={newAtOpen.has(item.id)}
                      onOpen={() => openNotice(item)}
                      onDismiss={() => dismissCenterNotification(item.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>,
        document.body
        )
      ) : null}
    </>
  );
}

function CenterRow({
  item,
  isNew,
  onOpen,
  onDismiss
}: {
  item: CenterNotification;
  isNew: boolean;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const [dragX, setDragX] = useState(0);
  const startXRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    // Don't start a swipe from the dismiss button.
    if ((e.target as HTMLElement).closest("[data-row-close]")) return;
    startXRef.current = e.clientX;
    setDragging(true);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable (synthetic or already-released pointer) - the
         move/up handlers still work without it */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (startXRef.current === null) return;
    setDragX(e.clientX - startXRef.current);
  };

  const endDrag = (e: React.PointerEvent) => {
    if (startXRef.current === null) return;
    const travelled = e.clientX - startXRef.current;
    startXRef.current = null;
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    switch (resolveCenterRowGesture(travelled)) {
      case "dismiss":
        onDismiss();
        break;
      case "activate":
        onOpen();
        break;
      default:
        setDragX(0);
    }
  };

  // Only leftward travel moves the row (rightward has no meaning here), and
  // it fades as it goes so the swipe feels physical - same as a toast.
  const shownX = Math.min(dragX, 0);
  const opacity = Math.max(0.15, 1 - Math.min(Math.abs(shownX) / 220, 0.85));

  return (
    <div
      data-testid="notification-center-row"
      role="button"
      tabIndex={0}
      aria-label={`${item.title}. ${item.body}. Open.`}
      className="cursor-pointer select-none rounded-xl bg-paper p-3 ring-1 ring-hairline transition-shadow hover:ring-hairline-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      style={{
        transform: `translateX(${shownX}px)`,
        opacity,
        transition: dragging ? "none" : "transform 150ms ease, opacity 150ms ease",
        touchAction: "pan-y"
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={`mt-[6px] inline-block h-[6px] w-[6px] flex-none rounded-full ${
            isNew ? "bg-accent" : "bg-ink-3/30"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 break-words text-[13px] font-medium leading-tight text-ink-1">
              {item.title}
            </span>
            <span className="ml-auto flex-none font-mono text-[10.5px] text-ink-3">
              {formatRelative(item.at)}
            </span>
          </div>
          <div className="mt-1 break-words text-[12px] leading-snug text-ink-3">{item.body}</div>
        </div>
        <button
          type="button"
          data-row-close
          aria-label="Dismiss notification"
          onClick={onDismiss}
          className="-mr-1 -mt-1 flex-none rounded-md p-1 text-ink-3 transition-colors hover:bg-hairline/60 hover:text-ink-1"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M3 3l6 6M9 3l-6 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
