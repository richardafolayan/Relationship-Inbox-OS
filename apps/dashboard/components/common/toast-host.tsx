"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onToast, type Toast } from "@/lib/feedback";

const kindStyles: Record<Toast["kind"], { ring: string; dot: string; label: string }> = {
  info: {
    ring: "ring-1 ring-hairline",
    dot: "bg-ink-3",
    label: "text-ink-3"
  },
  success: {
    ring: "ring-1 ring-[oklch(72%_0.13_150)]/40",
    dot: "bg-[oklch(62%_0.16_150)]",
    label: "text-[oklch(46%_0.12_150)]"
  },
  error: {
    ring: "ring-1 ring-risk-overdue/40",
    dot: "bg-risk-overdue",
    label: "text-risk-overdue"
  }
};

// How far (px) a pointer-drag must travel before the toast is dismissed on
// release. Below the threshold it springs back.
const SWIPE_DISMISS_PX = 80;

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Pending auto-dismiss timers, keyed by toast id, so a manual dismiss
  // (X / swipe) can cancel the timer and we never double-remove or leak.
  const timersRef = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    const timers = timersRef.current;
    const handle = timers.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Single funnel for every toast source so they all get the same cap and
  // the same auto-dismiss behaviour.
  const pushToast = useCallback(
    (toast: Toast) => {
      setToasts((prev) => {
        const filtered = prev.filter((t) => t.id !== toast.id);
        return [...filtered, toast].slice(-5);
      });
      const timers = timersRef.current;
      const existing = timers.get(toast.id);
      if (existing !== undefined) {
        window.clearTimeout(existing);
      }
      const handle = window.setTimeout(() => {
        timersRef.current.delete(toast.id);
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, Math.max(2000, toast.durationMs));
      timers.set(toast.id, handle);
    },
    []
  );

  // Subscribe to in-app toast events.
  useEffect(() => {
    const off = onToast((toast) => pushToast(toast));
    return off;
  }, [pushToast]);

  // Clear every pending timer on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) {
        window.clearTimeout(handle);
      }
      timers.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      data-testid="toast-host"
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[320px] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const style = kindStyles[toast.kind];
  const [dragX, setDragX] = useState(0);
  const startXRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    // Don't start a swipe from the dismiss button.
    if ((e.target as HTMLElement).closest("[data-toast-close]")) return;
    startXRef.current = e.clientX;
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
    if (Math.abs(travelled) > SWIPE_DISMISS_PX) {
      onDismiss(toast.id);
    } else {
      setDragX(0);
    }
  };

  // Fade out as the card is dragged so the swipe feels physical.
  const opacity = Math.max(0.15, 1 - Math.min(Math.abs(dragX) / 220, 0.85));

  return (
    <div
      className={`pointer-events-auto select-none rounded-xl bg-paper p-3 shadow-sm ${style.ring}`}
      role={toast.kind === "error" ? "alert" : "status"}
      style={{
        transform: `translateX(${dragX}px)`,
        opacity,
        transition: dragging ? "none" : "transform 150ms ease, opacity 150ms ease",
        touchAction: "pan-y"
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="flex items-start gap-2">
        <span className={`mt-[6px] inline-block h-[6px] w-[6px] flex-none rounded-full ${style.dot}`} />
        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-medium leading-tight ${style.label}`}>
            {toast.title}
          </div>
          {toast.description ? (
            <div className="mt-1 break-words text-[12px] leading-snug text-ink-3">
              {toast.description}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          data-toast-close
          aria-label="Dismiss notification"
          onClick={() => onDismiss(toast.id)}
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
