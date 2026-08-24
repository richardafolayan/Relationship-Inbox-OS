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
    <button
      {...props}
      type={type}
      disabled={disabled || state?.phase === "running"}
      data-phase={state?.phase ?? "idle"}
      aria-live="polite"
    >
      {state?.label ?? idleLabel}
    </button>
  );
}
