"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "./button";

type Status = "idle" | "running" | "done";

interface ActionButtonProps {
  // Resting label (may include an icon).
  children: ReactNode;
  // Verb shown beside the spinner while in flight, e.g. "Saving…".
  runningLabel: string;
  // Confirmation shown briefly after success, e.g. "Saved".
  doneLabel: string;
  action: () => Promise<unknown>;
  onError?: (message: string | null) => void;
  onSuccess?: () => void;
  variant?: "primary" | "ghost" | "quiet" | "danger";
  className?: string;
  title?: string;
  disabled?: boolean;
  // How long the success confirmation lingers before reverting (ms).
  doneMs?: number;
}

// Action button that surfaces its own running + success state inline
// (#432/#426): rest → spinner + "Saving…" → "Saved" ✓ → rest. Progress
// stays on the button rather than firing a popup, matching the app's
// notification-style split (ticker/inline for progress, toasts for events).
export function ActionButton({
  children,
  runningLabel,
  doneLabel,
  action,
  onError,
  onSuccess,
  variant = "ghost",
  className,
  title,
  disabled,
  doneMs = 2400
}: ActionButtonProps) {
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const run = async () => {
    if (status === "running") return;
    if (timer.current) clearTimeout(timer.current);
    setStatus("running");
    try {
      await action();
      onError?.(null);
      setStatus("done");
      timer.current = setTimeout(() => setStatus("idle"), doneMs);
      onSuccess?.();
    } catch (err) {
      setStatus("idle");
      const message = err instanceof Error ? err.message : String(err);
      onError?.(message);
      // eslint-disable-next-line no-console
      console.warn("[action]", message, err);
    }
  };

  return (
    <Button
      variant={variant}
      className={className}
      title={title}
      disabled={disabled || status === "running"}
      onClick={() => void run()}
    >
      {status === "running" ? (
        <>
          <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.8} />
          {runningLabel}
        </>
      ) : status === "done" ? (
        <>
          <Check className="h-[13px] w-[13px]" strokeWidth={2} />
          {doneLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
