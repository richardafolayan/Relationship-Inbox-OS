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
  /** Call when the overlay is closed by UI (X, Escape), not by system Back. */
  release: () => void;
}

/**
 * Push a history entry for the open overlay. System Back fires popstate and
 * calls onBack(); if onBack returns true the navigation is consumed (overlay
 * closed, no further route change). Programmatic close calls release(), which
 * history.back()s once without re-triggering onBack.
 */
export function bindOverlayHistory(options: HistoryBindingOptions): HistoryBinding {
  const { history, onBack, overlayId } = options;
  let active = true;
  let ignoringPop = false;

  const marker = { [MOBILE_OVERLAY_HISTORY_KEY]: overlayId };

  history.pushState(
    {
      ...(typeof history.state === "object" && history.state !== null
        ? (history.state as Record<string, unknown>)
        : {}),
      ...marker
    },
    ""
  );

  const onPopState = () => {
    if (ignoringPop) {
      ignoringPop = false;
      return;
    }
    if (!active) return;
    active = false;
    onBack();
  };

  history.addEventListener("popstate", onPopState);

  return {
    release: () => {
      if (!active) {
        history.removeEventListener("popstate", onPopState);
        return;
      }
      active = false;
      ignoringPop = true;
      history.removeEventListener("popstate", onPopState);
      try {
        history.back();
      } catch {
        ignoringPop = false;
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
