"use client";

import React, { type ButtonHTMLAttributes } from "react";
import type { InlineActionState } from "@/lib/feedback";

interface InlineActionButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  idleLabel: string;
  state?: InlineActionState | null;
}

export function InlineActionButton({
  idleLabel,
  state,
  disabled,
  type = "button",
  ...props
}: InlineActionButtonProps) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2 align-middle">
      <button
        {...props}
        type={type}
        disabled={disabled || state?.phase === "running"}
        data-phase={state?.phase ?? "idle"}
        aria-live={state?.phase === "running" ? "polite" : undefined}
      >
        {state?.phase === "running" ? state.label : idleLabel}
      </button>
      {state && state.phase !== "running" ? (
        <span
          role="status"
          className={`font-mono text-[11px] ${
            state.phase === "error" ? "text-ink-2" : "text-risk-fresh"
          }`}
        >
          {state.label}
        </span>
      ) : null}
    </span>
  );
}
