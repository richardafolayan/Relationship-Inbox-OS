"use client";

import { ApiRequestError } from "./api";

// `pending` is the in-flight kind: shows a spinner instead of a static dot,
// stays put until the same id is replaced by a success/error toast.
export type ToastKind = "pending" | "info" | "success" | "error";

export interface ToastInput {
  id?: string;
  kind: ToastKind;
  title: string;
  description?: string;
  receiptId?: string;
  durationMs?: number;
  // Optional in-app route. When set, the toast becomes clickable and
  // navigates here (e.g. a new-message toast opens the thread).
  href?: string;
  // Optional hooks for callers that mirror the toast elsewhere (the
  // notification center). The ToastHost fires:
  //   - onManualDismiss when the operator explicitly clears the toast
  //     (X button or swipe),
  //   - onActivate when they click the toast.
  // Auto-expiry fires neither: an unattended toast was never seen.
  onManualDismiss?: () => void;
  onActivate?: () => void;
}

export interface Toast extends Required<Pick<ToastInput, "id" | "kind" | "title" | "durationMs">> {
  description?: string;
  receiptId?: string;
  href?: string;
  onManualDismiss?: () => void;
  onActivate?: () => void;
  createdAt: number;
}

export interface InlineActionState {
  phase: "running" | "success" | "error";
  label: string;
}

export type InlineActionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export interface InlineActionOptions<T> {
  pending: string;
  success: string | ((value: T) => string);
  failure: string | ((error: unknown) => string);
  setState: (state: InlineActionState) => void;
  setError?: (message: string | null) => void;
  onDone?: (value: T) => void | Promise<void>;
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
    href: input.href,
    onManualDismiss: input.onManualDismiss,
    onActivate: input.onActivate,
    durationMs:
      input.durationMs ??
      (input.kind === "pending" ? 60_000 : input.kind === "error" ? 8000 : 3500),
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

// Programmatic removal by id, for toasts made moot by app state rather than
// by the operator (#758: a new-message toast disappears once that thread is
// replied to). Removal only - deliberately does NOT fire onManualDismiss /
// onActivate, which encode operator intent ("seen it" / "open it").
const TOAST_DISMISS_EVENT = "inbox-toast-dismiss";

export function dismissToast(id: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(TOAST_DISMISS_EVENT, { detail: id }));
}

export function onToastDismiss(handler: (id: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<string>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(TOAST_DISMISS_EVENT, wrapped);
  return () => window.removeEventListener(TOAST_DISMISS_EVENT, wrapped);
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
  showToast({ id: pendingId, kind: "pending", title: opts.pending });

  promise
    .then(async (value) => {
      const successText = typeof opts.success === "function" ? opts.success(value) : opts.success;
      // Replace the pending toast by reusing its id.
      showToast({ id: pendingId, kind: "success", title: successText });
      opts.setError?.(null);
      // The action has already SUCCEEDED and we've already shown the success
      // toast, so a throwing onDone (e.g. a refresh() that explodes) must not
      // reach the outer .catch - that would overwrite the success toast with a
      // contradictory error toast and flip setError to a failure. Isolate the
      // follow-up: log its failure for DevTools only, leave the success UI.
      if (opts.onDone) {
        try {
          await opts.onDone(value);
        } catch (onDoneErr) {
          console.warn("[action] onDone failed after success", onDoneErr);
        }
      }
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

export async function runActionWithInlineFeedback<T>(
  promise: Promise<T>,
  opts: InlineActionOptions<T>
): Promise<InlineActionOutcome<T>> {
  opts.setError?.(null);
  opts.setState({ phase: "running", label: opts.pending });
  try {
    const value = await promise;
    const success = typeof opts.success === "function" ? opts.success(value) : opts.success;
    opts.setState({ phase: "success", label: success });
    if (opts.onDone) {
      try {
        await opts.onDone(value);
      } catch (error) {
        console.warn("[action] onDone failed after success", error);
      }
    }
    return { ok: true, value };
  } catch (error) {
    const detail =
      error instanceof ApiRequestError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    const failure = typeof opts.failure === "function" ? opts.failure(error) : opts.failure;
    opts.setState({ phase: "error", label: failure });
    opts.setError?.(detail);
    console.warn("[action]", failure, error);
    return { ok: false, error };
  }
}

export async function runSingleFlightInlineAction<T>(
  gate: { current: boolean },
  work: () => Promise<T>,
  opts: InlineActionOptions<T>
): Promise<InlineActionOutcome<T> | null> {
  if (gate.current) return null;
  gate.current = true;
  try {
    return await runActionWithInlineFeedback(work(), opts);
  } finally {
    gate.current = false;
  }
}
