"use client";

import { ApiRequestError } from "./api";

export type ToastKind = "info" | "success" | "error";

export interface ToastInput {
  id?: string;
  kind: ToastKind;
  title: string;
  description?: string;
  receiptId?: string;
  durationMs?: number;
}

export interface Toast extends Required<Pick<ToastInput, "id" | "kind" | "title" | "durationMs">> {
  description?: string;
  receiptId?: string;
  createdAt: number;
}

const TOAST_EVENT = "inbox-toast";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}${counter}`;
}

export function showToast(input: ToastInput): void {
  if (typeof window === "undefined") return;
  const toast: Toast = {
    id: input.id ?? nextId(),
    kind: input.kind,
    title: input.title,
    description: input.description,
    receiptId: input.receiptId,
    durationMs: input.durationMs ?? (input.kind === "error" ? 8000 : 3500),
    createdAt: Date.now()
  };
  window.dispatchEvent(new CustomEvent<Toast>(TOAST_EVENT, { detail: toast }));
}

export function onToast(handler: (toast: Toast) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<Toast>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(TOAST_EVENT, wrapped);
  return () => window.removeEventListener(TOAST_EVENT, wrapped);
}

// Wraps a fire-and-forget action with optimistic + result toasts.
// Mirrors `runAction` (api.ts) but adds user-visible feedback.
export function runActionWithFeedback<T>(
  promise: Promise<T>,
  opts: {
    pending: string;
    success: string | ((value: T) => string);
    failure?: string | ((err: unknown) => string);
    setError?: (message: string | null) => void;
    onDone?: (value: T) => void | Promise<void>;
  }
): void {
  const pendingId = nextId();
  showToast({ id: pendingId, kind: "info", title: opts.pending, durationMs: 60_000 });

  promise
    .then(async (value) => {
      const successText = typeof opts.success === "function" ? opts.success(value) : opts.success;
      // Replace the pending toast by reusing its id.
      showToast({ id: pendingId, kind: "success", title: successText });
      opts.setError?.(null);
      if (opts.onDone) await opts.onDone(value);
    })
    .catch((err: unknown) => {
      const fallback =
        err instanceof ApiRequestError ? err.message : err instanceof Error ? err.message : String(err);
      const failureText =
        typeof opts.failure === "function"
          ? opts.failure(err)
          : (opts.failure ?? "Something went wrong");
      showToast({
        id: pendingId,
        kind: "error",
        title: failureText,
        description: fallback,
        durationMs: 9000
      });
      opts.setError?.(fallback);
      console.warn("[action]", failureText, err);
    });
}
