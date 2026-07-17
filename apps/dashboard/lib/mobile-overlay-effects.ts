// DOM side-effects owned by the shared overlay contract:
//   - body scroll lock while a primary overlay is active
//   - focus capture snapshot + restore on close
//   - history.pushState / popstate so system Back closes the top overlay first
//   - visualViewport tracking for keyboard-aware sizing
//
// Injectable hosts keep these unit-testable without a browser.

export const MOBILE_OVERLAY_HISTORY_KEY = "__riosMobileOverlay";

export interface ScrollLockHost {
  bodyStyle: {
    overflow: string;
    paddingRight: string;
  };
  documentElementStyle?: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  };
  /** Optional scrollbar compensation (window.innerWidth - documentElement.clientWidth). */
  scrollbarGapPx?: number;
}

export interface ScrollLockHandle {
  release: () => void;
}

/**
 * Lock background scrolling. Nested locks are ref-counted via the returned
 * release function; only the outermost release restores the prior styles.
 */
export function createScrollLock(host: ScrollLockHost): ScrollLockHandle {
  const previousOverflow = host.bodyStyle.overflow;
  const previousPaddingRight = host.bodyStyle.paddingRight;
  const gap = host.scrollbarGapPx ?? 0;

  host.bodyStyle.overflow = "hidden";
  if (gap > 0) {
    host.bodyStyle.paddingRight = `${gap}px`;
  }
  host.documentElementStyle?.setProperty("--overlay-scroll-locked", "1");

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      host.bodyStyle.overflow = previousOverflow;
      host.bodyStyle.paddingRight = previousPaddingRight;
      host.documentElementStyle?.removeProperty("--overlay-scroll-locked");
    }
  };
}

/** Ref-counted scroll lock manager for multiple overlapping consumers. */
export function createScrollLockManager(getHost: () => ScrollLockHost | null) {
  let depth = 0;
  let handle: ScrollLockHandle | null = null;

  return {
    getDepth: () => depth,
    isLocked: () => depth > 0,
    acquire: () => {
      depth += 1;
      if (depth === 1) {
        const host = getHost();
        if (host) handle = createScrollLock(host);
      }
      return () => {
        if (depth === 0) return;
        depth -= 1;
        if (depth === 0 && handle) {
          handle.release();
          handle = null;
        }
      };
    },
    /** Force-release everything (e.g. provider unmount). */
    releaseAll: () => {
      depth = 0;
      if (handle) {
        handle.release();
        handle = null;
      }
    }
  };
}

export interface FocusRestoreHost {
  activeElement: Element | null;
  focus?: (element: Element) => void;
}

/**
 * Snapshot the currently focused element and restore it later. Safe when the
 * element has been removed from the document (no-op restore).
 */
export function captureFocus(host: FocusRestoreHost): () => void {
  const previous = host.activeElement;
  return () => {
    if (!previous) return;
    if (typeof (previous as HTMLElement).focus === "function") {
      try {
        (previous as HTMLElement).focus();
      } catch {
        // Element may no longer accept focus.
      }
      return;
    }
    host.focus?.(previous);
  };
}

export interface HistoryHost {
  state: unknown;
  pushState: (data: unknown, unused: string, url?: string | null) => void;
  replaceState: (data: unknown, unused: string, url?: string | null) => void;
  back: () => void;
  addEventListener: (type: "popstate", listener: (event: { state: unknown }) => void) => void;
  removeEventListener: (type: "popstate", listener: (event: { state: unknown }) => void) => void;
}

export interface HistoryBindingOptions {
  history: HistoryHost;
  /** Return true when a primary overlay is active and was closed by this Back. */
  onBack: () => boolean;
  overlayId: string;
}

export interface HistoryBinding {
  /** False after system Back or release; provider must not retarget a dead binding. */
  isActive: () => boolean;
  /**
   * Swap the overlay marker in place when one primary replaces another.
   * Must not call history.back(): browsers fire popstate asynchronously, and
   * a rebinding listener would treat that deferred traversal as a user Back.
   */
  retarget: (overlayId: string) => void;
  /** Call when the overlay is closed by UI (X, Escape), not by system Back. */
  release: () => void;
}

function overlayHistoryState(history: HistoryHost, overlayId: string): Record<string, unknown> {
  const base =
    typeof history.state === "object" && history.state !== null
      ? (history.state as Record<string, unknown>)
      : {};
  return {
    ...base,
    [MOBILE_OVERLAY_HISTORY_KEY]: overlayId
  };
}

/** Programmatic history.back() counts per host that must not dismiss overlays. */
const programmaticPopsToIgnore = new WeakMap<object, number>();
/** Per-host flag set by the absorber for the current popstate dispatch. */
const suppressOverlayPop = new WeakMap<object, boolean>();
const historyHostsWithAbsorber = new WeakSet<object>();

/**
 * Runs before overlay listeners (installed first) so a deferred history.back()
 * from release is consumed even when a replacement binding already exists.
 */
function ensureProgrammaticPopAbsorber(history: HistoryHost): void {
  const hostKey = history as object;
  if (historyHostsWithAbsorber.has(hostKey)) return;
  historyHostsWithAbsorber.add(hostKey);
  history.addEventListener("popstate", () => {
    const pending = programmaticPopsToIgnore.get(hostKey) ?? 0;
    if (pending > 0) {
      programmaticPopsToIgnore.set(hostKey, pending - 1);
      suppressOverlayPop.set(hostKey, true);
    } else {
      suppressOverlayPop.set(hostKey, false);
    }
  });
}

/**
 * Push a single history entry for the primary-overlay lifetime. System Back
 * fires popstate and calls onBack(). When one primary replaces another, call
 * retarget() (replaceState) so the deferred history.back from a release cannot
 * dismiss the new surface. Programmatic close of the last primary calls
 * release(), which history.back()s once without re-triggering onBack.
 */
export function bindOverlayHistory(options: HistoryBindingOptions): HistoryBinding {
  const { history, onBack } = options;
  const hostKey = history as object;
  let active = true;
  let overlayId = options.overlayId;

  ensureProgrammaticPopAbsorber(history);
  history.pushState(overlayHistoryState(history, overlayId), "");

  const onPopState = () => {
    if (suppressOverlayPop.get(hostKey)) return;
    if (!active) return;
    active = false;
    history.removeEventListener("popstate", onPopState);
    onBack();
  };

  history.addEventListener("popstate", onPopState);

  return {
    isActive: () => active,
    retarget: (nextOverlayId: string) => {
      if (!active) return;
      overlayId = nextOverlayId;
      try {
        history.replaceState(overlayHistoryState(history, overlayId), "");
      } catch {
        // History may be unavailable; marker is best-effort.
      }
    },
    release: () => {
      if (!active) {
        history.removeEventListener("popstate", onPopState);
        return;
      }
      active = false;
      history.removeEventListener("popstate", onPopState);
      programmaticPopsToIgnore.set(
        hostKey,
        (programmaticPopsToIgnore.get(hostKey) ?? 0) + 1
      );
      try {
        history.back();
      } catch {
        const pending = programmaticPopsToIgnore.get(hostKey) ?? 0;
        programmaticPopsToIgnore.set(hostKey, Math.max(0, pending - 1));
      }
    }
  };
}

export interface VisualViewportHost {
  visualViewport: {
    height: number;
    offsetTop: number;
    addEventListener: (type: "resize" | "scroll", listener: () => void) => void;
    removeEventListener: (type: "resize" | "scroll", listener: () => void) => void;
  } | null;
  innerHeight: number;
  documentElementStyle: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  };
}

export interface VisualViewportBinding {
  release: () => void;
  /** Latest computed overlay height in CSS pixels. */
  getOverlayHeightPx: () => number;
}

/**
 * Keeps --overlay-vvh (visual viewport height) and --overlay-keyboard-inset
 * in sync so fixed overlays can size above the soft keyboard.
 */
export function bindVisualViewport(host: VisualViewportHost): VisualViewportBinding {
  let overlayHeightPx = host.innerHeight;

  const apply = () => {
    const vv = host.visualViewport;
    const height = vv?.height ?? host.innerHeight;
    const offsetTop = vv?.offsetTop ?? 0;
    const keyboardInset = Math.max(0, host.innerHeight - height - offsetTop);
    overlayHeightPx = height;
    host.documentElementStyle.setProperty("--overlay-vvh", `${height}px`);
    host.documentElementStyle.setProperty("--overlay-keyboard-inset", `${keyboardInset}px`);
    host.documentElementStyle.setProperty("--overlay-vv-offset-top", `${offsetTop}px`);
  };

  apply();

  const vv = host.visualViewport;
  if (vv) {
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
  }

  return {
    getOverlayHeightPx: () => overlayHeightPx,
    release: () => {
      if (vv) {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      }
      host.documentElementStyle.removeProperty("--overlay-vvh");
      host.documentElementStyle.removeProperty("--overlay-keyboard-inset");
      host.documentElementStyle.removeProperty("--overlay-vv-offset-top");
    }
  };
}

/** Build a ScrollLockHost from the real document (browser only). */
export function browserScrollLockHost(): ScrollLockHost | null {
  if (typeof document === "undefined") return null;
  const gap =
    typeof window !== "undefined"
      ? Math.max(0, window.innerWidth - document.documentElement.clientWidth)
      : 0;
  return {
    bodyStyle: document.body.style,
    documentElementStyle: document.documentElement.style,
    scrollbarGapPx: gap
  };
}

export function browserFocusHost(): FocusRestoreHost | null {
  if (typeof document === "undefined") return null;
  return { activeElement: document.activeElement };
}

export function browserHistoryHost(): HistoryHost | null {
  if (typeof window === "undefined") return null;
  return window.history as unknown as HistoryHost;
}

export function browserVisualViewportHost(): VisualViewportHost | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    visualViewport: window.visualViewport
      ? {
          height: window.visualViewport.height,
          offsetTop: window.visualViewport.offsetTop,
          addEventListener: (type, listener) =>
            window.visualViewport!.addEventListener(type, listener),
          removeEventListener: (type, listener) =>
            window.visualViewport!.removeEventListener(type, listener)
        }
      : null,
    innerHeight: window.innerHeight,
    documentElementStyle: document.documentElement.style
  };
}
