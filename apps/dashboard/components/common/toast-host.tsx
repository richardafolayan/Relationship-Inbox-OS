"use client";

import { useEffect, useState } from "react";
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

interface RunnerEventDetail {
  type?: string;
  threadId?: string;
  reason?: string;
  attempt?: number;
}

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Subscribe to in-app toast events.
  useEffect(() => {
    const off = onToast((toast) => {
      setToasts((prev) => {
        const filtered = prev.filter((t) => t.id !== toast.id);
        return [...filtered, toast].slice(-5);
      });
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id));
      }, toast.durationMs);
    });
    return off;
  }, []);

  // Mirror selected runner SSE events as toasts so background work surfaces
  // even when no UI action triggered it. Kept narrow on purpose - the SSE
  // stream is noisy and we don't want every receipt becoming a toast.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<RunnerEventDetail>).detail;
      if (!detail || typeof detail.type !== "string") return;
      switch (detail.type) {
        case "SEND_FAILED":
          setToasts((prev) => [
            ...prev,
            {
              id: `sse-${Date.now()}`,
              kind: "error",
              title: "Send failed",
              description: detail.reason ?? "Runner reported a failed send",
              durationMs: 9000,
              createdAt: Date.now()
            }
          ]);
          break;
        case "SEND_CONFIRMED":
          setToasts((prev) => [
            ...prev,
            {
              id: `sse-${Date.now()}`,
              kind: "success",
              title: "Reply confirmed by platform",
              durationMs: 3000,
              createdAt: Date.now()
            }
          ]);
          break;
        default:
          break;
      }
    };
    window.addEventListener("runner-event", handler);
    return () => window.removeEventListener("runner-event", handler);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      data-testid="toast-host"
      className="pointer-events-none fixed right-4 top-4 z-50 flex w-[320px] flex-col gap-2"
    >
      {toasts.map((toast) => {
        const style = kindStyles[toast.kind];
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-xl bg-paper p-3 shadow-sm ${style.ring}`}
            role={toast.kind === "error" ? "alert" : "status"}
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
            </div>
          </div>
        );
      })}
    </div>
  );
}
