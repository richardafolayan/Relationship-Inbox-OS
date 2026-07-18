// Shared primary-overlay controller for the mobile (and desktop) shell.
//
// Primary surfaces (Search, feedback, AI Assist, walkthroughs, action sheets,
// drawers) must not stack two full interaction layers. Lightweight toasts stay
// outside this contract.
//
// Framework-free so unit tests can exercise open/replace/reject, dismiss
// (Back/Escape), and stack inspection without a DOM or React.

export type PrimaryOverlayKind =
  | "search"
  | "feedback"
  | "ai-assist"
  | "walkthrough"
  | "action-sheet"
  | "profile-drawer"
  | "browser"
  | "focus-sheet"
  | "custom";

/** What to do when open() is called while a primary overlay is already active. */
export type OpenConflictPolicy = "replace" | "reject";

export interface OpenOverlayInput {
  kind: PrimaryOverlayKind;
  /** Stable id; auto-generated when omitted. */
  id?: string;
  /** Default: "replace". */
  policy?: OpenConflictPolicy;
  /**
   * Invoked when the controller closes this entry (Escape, system Back,
   * replace by another primary, or explicit close). Consumers should set
   * their local open flag to false. Must be idempotent.
   */
  onRequestClose: () => void;
  /** Opaque payload for the owning surface. */
  payload?: unknown;
}

export interface OverlayEntry {
  id: string;
  kind: PrimaryOverlayKind;
  onRequestClose: () => void;
  payload?: unknown;
  openedAt: number;
}

export type OpenOverlayResult =
  | { ok: true; id: string; entry: OverlayEntry; replaced: OverlayEntry | null }
  | { ok: false; reason: "rejected_primary_active"; active: OverlayEntry };

export interface CloseOptions {
  /**
   * When true, remove the entry without invoking onRequestClose. Use when the
   * owning surface already closed itself (X button, submit, unmount).
   */
  silent?: boolean;
}

export interface MobileOverlayController {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly OverlayEntry[];
  getTop: () => OverlayEntry | null;
  isPrimaryActive: () => boolean;
  hasKind: (kind: PrimaryOverlayKind) => boolean;
  open: (input: OpenOverlayInput) => OpenOverlayResult;
  /** Close by id, or the top entry when id is omitted. Returns the closed entry. */
  close: (id?: string, options?: CloseOptions) => OverlayEntry | null;
  closeTop: (options?: CloseOptions) => OverlayEntry | null;
  closeAll: (options?: CloseOptions) => OverlayEntry[];
  /**
   * Escape / system Back entry point. Closes the top primary overlay and
   * returns true when the event was consumed (so navigation must not proceed).
   */
  handleDismiss: () => boolean;
}

export interface CreateMobileOverlayControllerOptions {
  now?: () => number;
  generateId?: () => string;
}

let nextAutoId = 0;

function defaultGenerateId(): string {
  nextAutoId += 1;
  return `overlay-${nextAutoId}`;
}

export function createMobileOverlayController(
  options: CreateMobileOverlayControllerOptions = {}
): MobileOverlayController {
  const now = options.now ?? (() => Date.now());
  const generateId = options.generateId ?? defaultGenerateId;

  let stack: OverlayEntry[] = [];
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const getSnapshot = () => stack;
  const getTop = () => stack[stack.length - 1] ?? null;
  const isPrimaryActive = () => stack.length > 0;
  const hasKind = (kind: PrimaryOverlayKind) => stack.some((entry) => entry.kind === kind);

  const invokeClose = (entry: OverlayEntry) => {
    try {
      entry.onRequestClose();
    } catch {
      // Consumer close handlers must not break the controller.
    }
  };

  const open = (input: OpenOverlayInput): OpenOverlayResult => {
    const policy: OpenConflictPolicy = input.policy ?? "replace";
    const current = getTop();

    if (current) {
      if (policy === "reject") {
        return { ok: false, reason: "rejected_primary_active", active: current };
      }
      // Same kind + same id re-open is a no-op keep; still return ok so the
      // caller can treat the surface as open.
      if (input.id && current.id === input.id) {
        return { ok: true, id: current.id, entry: current, replaced: null };
      }
    }

    const entry: OverlayEntry = {
      id: input.id ?? generateId(),
      kind: input.kind,
      onRequestClose: input.onRequestClose,
      payload: input.payload,
      openedAt: now()
    };

    let replaced: OverlayEntry | null = null;
    if (current) {
      replaced = current;
      stack = [entry];
      notify();
      // Close the previous surface after the new top is committed so UI does
      // not flash an empty gap between two primaries.
      invokeClose(replaced);
      return { ok: true, id: entry.id, entry, replaced };
    }

    stack = [entry];
    notify();
    return { ok: true, id: entry.id, entry, replaced: null };
  };

  const close = (id?: string, options: CloseOptions = {}): OverlayEntry | null => {
    if (stack.length === 0) return null;
    const targetId = id ?? stack[stack.length - 1]!.id;
    const index = stack.findIndex((entry) => entry.id === targetId);
    if (index < 0) return null;
    const closed = stack[index]!;
    stack = stack.filter((entry) => entry.id !== targetId);
    notify();
    if (!options.silent) invokeClose(closed);
    return closed;
  };

  const closeTop = (options?: CloseOptions) => close(undefined, options);

  const closeAll = (options: CloseOptions = {}): OverlayEntry[] => {
    if (stack.length === 0) return [];
    const closed = [...stack];
    stack = [];
    notify();
    if (!options.silent) {
      for (const entry of closed) invokeClose(entry);
    }
    return closed;
  };

  const handleDismiss = (): boolean => {
    if (stack.length === 0) return false;
    closeTop();
    return true;
  };

  return {
    subscribe,
    getSnapshot,
    getTop,
    isPrimaryActive,
    hasKind,
    open,
    close,
    closeTop,
    closeAll,
    handleDismiss
  };
}
