"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Loader2 } from "lucide-react";
import { onToast, onToastDismiss, type Toast } from "@/lib/feedback";
import { resolveToastGesture } from "@/lib/toast-gesture";

const kindStyles: Record<Toast["kind"], { ring: string; dot: string; label: string }> = {
  pending: {
    ring: "ring-1 ring-hairline",
    dot: "text-ink-2",
    label: "text-ink-1"
  },
  info: {
    ring: "ring-1 ring-hairline",
    dot: "bg-ink-3",
    label: "text-ink-3"
  },
  success: {
    ring: "ring-1 ring-risk-fresh/40",
    dot: "bg-risk-fresh",
    label: "text-risk-fresh"
  },
  error: {
    ring: "ring-1 ring-hairline-strong",
    dot: "bg-ink-2",
    label: "text-ink-2"
  }
};

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
        return [...filtered, toast].slice(-3);
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

  // Programmatic dismissals (#758): app state made the toast moot (e.g. the
  // operator replied to the thread a new-message toast points at). Plain
  // removal - operator-intent hooks (onManualDismiss/onActivate) don't fire.
  useEffect(() => {
    const off = onToastDismiss((id) => dismiss(id));
    return off;
  }, [dismiss]);

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
      className="pointer-events-none fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+8px)] z-50 flex w-auto flex-col gap-1.5 sm:left-auto sm:right-4 sm:top-[56px] sm:w-[320px] sm:gap-2"
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
  const router = useRouter();
  const style = kindStyles[toast.kind];
  const [dragX, setDragX] = useState(0);
  const startXRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const interactive = Boolean(toast.href || toast.onActivate);

  // Navigate to the toast's route and clear it. Used by both a pointer
  // click (any release below the swipe threshold) and the keyboard handler.
  const activate = useCallback(() => {
    if (!toast.href && !toast.onActivate) return;
    toast.onActivate?.();
    onDismiss(toast.id);
    if (toast.href) {
      router.push(toast.href);
    }
  }, [router, onDismiss, toast]);

  // An explicit clear (X button or swipe), as opposed to auto-expiry: lets
  // the toast's source react to "the operator saw this and waved it away".
  const manualDismiss = useCallback(() => {
    toast.onManualDismiss?.();
    onDismiss(toast.id);
  }, [onDismiss, toast]);

  const onPointerDown = (e: React.PointerEvent) => {
    // Don't start a swipe from the dismiss button.
    if ((e.target as HTMLElement).closest("[data-toast-close]")) return;
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
    switch (resolveToastGesture(travelled, interactive)) {
      case "dismiss":
        e.preventDefault();
        manualDismiss();
        break;
      case "activate":
        setDragX(0);
        break;
      default:
        setDragX(0);
    }
  };

  // Fade out as the card is dragged so the swipe feels physical.
  const opacity = Math.max(0.15, 1 - Math.min(Math.abs(dragX) / 220, 0.85));

  return (
    <div
      data-toast-href={toast.href ?? undefined}
      className={`pointer-events-auto relative select-none rounded-xl bg-paper p-2.5 shadow-sm transition-shadow sm:p-3 ${style.ring} ${
        interactive ? "hover:ring-hairline-strong" : ""
      }`}
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
      {interactive ? (
        <button
          type="button"
          aria-label={`${toast.title}${toast.description ? `. ${toast.description}` : ""}. Activate.`}
          onClick={activate}
          className="absolute inset-0 z-0 cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      ) : null}
      <div className="pointer-events-none relative z-[1] flex items-start gap-2">
        {toast.kind === "pending" ? (
          <Loader2
            aria-hidden
            className={`mt-[2px] h-[12px] w-[12px] flex-none animate-spin ${style.dot}`}
          />
        ) : (
          <span
            aria-hidden
            className={`mt-[6px] inline-block h-[6px] w-[6px] flex-none rounded-full ${style.dot}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className={`text-[13px] font-medium leading-tight ${style.label}`}>
            {toast.title}
          </div>
          {toast.description ? (
            <div className="mt-1 line-clamp-2 break-words text-[12px] leading-snug text-ink-3">
              {toast.description}
            </div>
          ) : null}
        </div>
        {interactive ? (
          <ChevronRight
            aria-hidden
            className="mt-[1px] h-[14px] w-[14px] flex-none text-ink-3"
            strokeWidth={1.7}
          />
        ) : null}
        <button
          type="button"
          data-toast-close
          aria-label="Dismiss notification"
          onClick={manualDismiss}
          className="pointer-events-auto -mr-1 -mt-1 flex-none rounded-md p-1 text-ink-3 transition-colors hover:bg-hairline/60 hover:text-ink-1"
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
