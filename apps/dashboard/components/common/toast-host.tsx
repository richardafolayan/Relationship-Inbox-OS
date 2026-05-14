"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "framer-motion";
import { X } from "lucide-react";
import { onToast, type Toast } from "@/lib/feedback";
import { SPRING } from "@/lib/motion";

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

interface RunnerEventDetail {
  type?: string;
  threadId?: string;
  reason?: string;
  attempt?: number;
}

// Cap on visible toasts. Older toasts roll off when new ones arrive so
// the stack never grows beyond 5 - prevents the "wall of notifications"
// failure mode (operator sees 30 stale "Reply confirmed by platform"
// toasts because no one was dismissing them).
const MAX_VISIBLE = 5;

// Pixel/velocity thresholds for swipe-to-dismiss. Either crossing the
// distance OR the velocity triggers dismissal - matches iOS notification
// behaviour where a quick flick dismisses even on a small displacement.
const SWIPE_DISMISS_DISTANCE = 100;
const SWIPE_DISMISS_VELOCITY = 500;

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track active dismiss timers so we can cancel them when the toast is
  // closed manually (otherwise a stale timer could try to dismiss a
  // toast that no longer exists, or - worse - dismiss a NEW toast that
  // happened to inherit the same id).
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Single entry point for all incoming toasts. Both the `showToast`
  // subscription and the SSE event mirror go through here so the
  // auto-dismiss timer is set up uniformly - the previous code only
  // scheduled timers on the subscription path, so SSE toasts ("Reply
  // confirmed by platform" etc.) piled up forever.
  const addToast = useCallback((toast: Toast) => {
    setToasts((prev) => {
      const filtered = prev.filter((t) => t.id !== toast.id);
      return [...filtered, toast].slice(-MAX_VISIBLE);
    });
    // Replace any existing timer for this id (showToast can reuse an id
    // to morph a pending toast into a success/failure one).
    const existing = timersRef.current.get(toast.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timersRef.current.delete(toast.id);
      setToasts((prev) => prev.filter((t) => t.id !== toast.id));
    }, toast.durationMs);
    timersRef.current.set(toast.id, timer);
  }, []);

  // Subscribe to in-app toast events.
  useEffect(() => {
    const off = onToast(addToast);
    return off;
  }, [addToast]);

  // Mirror selected runner SSE events as toasts so background work surfaces
  // even when no UI action triggered it. Kept narrow on purpose - the SSE
  // stream is noisy and we don't want every receipt becoming a toast.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<RunnerEventDetail>).detail;
      if (!detail || typeof detail.type !== "string") return;
      // Event-type names must match what the runner emits in
      // packages/core/src/types.ts and apps/runner/src/services/send.ts.
      switch (detail.type) {
        case "MESSAGE_SEND_FAILED":
          addToast({
            id: `sse-${Date.now()}`,
            kind: "error",
            title: "Send failed",
            description: detail.reason ?? "Runner reported a failed send",
            durationMs: 9000,
            createdAt: Date.now()
          });
          break;
        case "MESSAGE_SENT":
          addToast({
            id: `sse-${Date.now()}`,
            kind: "success",
            title: "Reply confirmed by platform",
            durationMs: 3000,
            createdAt: Date.now()
          });
          break;
        default:
          break;
      }
    };
    window.addEventListener("runner-event", handler);
    return () => window.removeEventListener("runner-event", handler);
  }, [addToast]);

  // Cleanup pending timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <div
      data-testid="toast-host"
      // Top-right column. pointer-events-none so the container doesn't
      // block clicks outside the toasts themselves; individual toasts
      // re-enable pointer-events.
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[320px] flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const reduced = useReducedMotion();
  const style = kindStyles[toast.kind];

  const handleDragEnd = (
    _event: MouseEvent | TouchEvent | PointerEvent,
    info: PanInfo
  ) => {
    const distance = Math.abs(info.offset.x);
    const velocity = Math.abs(info.velocity.x);
    if (distance > SWIPE_DISMISS_DISTANCE || velocity > SWIPE_DISMISS_VELOCITY) {
      onDismiss();
    }
  };

  return (
    <motion.div
      layout
      role={toast.kind === "error" ? "alert" : "status"}
      className={`pointer-events-auto cursor-grab rounded-xl bg-paper p-3 shadow-sm active:cursor-grabbing ${style.ring}`}
      // Slide in from the right with a small overshoot. Reduced-motion
      // users get a plain fade - no horizontal motion.
      initial={reduced ? { opacity: 0 } : { opacity: 0, x: 24, scale: 0.97 }}
      animate={
        reduced
          ? { opacity: 1, transition: { duration: 0.12 } }
          : { opacity: 1, x: 0, scale: 1, transition: SPRING.bouncy }
      }
      exit={
        reduced
          ? { opacity: 0, transition: { duration: 0.1 } }
          : {
              opacity: 0,
              x: 32,
              scale: 0.95,
              transition: { duration: 0.18, ease: "easeIn" }
            }
      }
      drag={reduced ? false : "x"}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.6}
      onDragEnd={handleDragEnd}
      whileTap={reduced ? undefined : { scale: 0.99 }}
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
          onClick={onDismiss}
          // Stop the click from propagating into the motion.div's drag
          // gesture detection - without this, a fast click can register
          // as a tiny drag and onDragEnd's threshold check returns
          // false, leaving the toast visible.
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Dismiss notification"
          className="-mr-1 -mt-1 flex h-6 w-6 flex-none items-center justify-center rounded-full text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="h-[13px] w-[13px]" strokeWidth={1.8} />
        </button>
      </div>
    </motion.div>
  );
}
