"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import {
  createMobileOverlayController,
  type MobileOverlayController,
  type OpenConflictPolicy,
  type OpenOverlayInput,
  type OpenOverlayResult,
  type OverlayEntry,
  type PrimaryOverlayKind
} from "@/lib/mobile-overlay-controller";
import {
  bindOverlayHistory,
  bindVisualViewport,
  browserFocusHost,
  browserHistoryHost,
  browserScrollLockHost,
  browserVisualViewportHost,
  captureFocus,
  createScrollLockManager,
  type HistoryBinding
} from "@/lib/mobile-overlay-effects";

interface MobileOverlayContextValue {
  controller: MobileOverlayController;
  open: (input: OpenOverlayInput) => OpenOverlayResult;
  close: (id?: string, options?: { silent?: boolean }) => OverlayEntry | null;
  closeTop: (options?: { silent?: boolean }) => OverlayEntry | null;
  handleDismiss: () => boolean;
  getTop: () => OverlayEntry | null;
  isPrimaryActive: () => boolean;
  hasKind: (kind: PrimaryOverlayKind) => boolean;
  top: OverlayEntry | null;
  primaryActive: boolean;
}

const MobileOverlayContext = createContext<MobileOverlayContextValue | null>(null);

function useControllerSnapshot(controller: MobileOverlayController): readonly OverlayEntry[] {
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
}

/**
 * Owns the singleton primary-overlay controller for the app shell.
 * Installs scroll lock, focus restore, history Back, Escape, and
 * visualViewport tracking whenever a primary overlay is active.
 */
export function MobileOverlayProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<MobileOverlayController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createMobileOverlayController();
  }
  const controller = controllerRef.current;

  const stack = useControllerSnapshot(controller);
  const top = stack[stack.length - 1] ?? null;
  const primaryActive = stack.length > 0;

  const scrollLocks = useRef(createScrollLockManager(browserScrollLockHost));
  const focusRestoreRef = useRef<(() => void) | null>(null);
  const historyBindingRef = useRef<HistoryBinding | null>(null);
  const viewportBindingRef = useRef<ReturnType<typeof bindVisualViewport> | null>(null);
  const activeIdRef = useRef<string | null>(null);
  /** Deferred history.back when the primary stack empties; cancelled if a replace re-opens. */
  const historyReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!primaryActive || !top) {
      viewportBindingRef.current?.release();
      viewportBindingRef.current = null;
      if (focusRestoreRef.current) {
        const restore = focusRestoreRef.current;
        focusRestoreRef.current = null;
        requestAnimationFrame(() => restore());
      }
      // Defer history.back until we know another primary is not about to open
      // (Search close + Feedback open in consecutive renders). Immediate
      // release + rebind races: browsers apply back asynchronously and the new
      // listener would treat it as a user Back.
      if (historyBindingRef.current && historyReleaseTimerRef.current == null) {
        const binding = historyBindingRef.current;
        historyReleaseTimerRef.current = setTimeout(() => {
          historyReleaseTimerRef.current = null;
          if (historyBindingRef.current === binding) {
            binding.release();
            historyBindingRef.current = null;
            activeIdRef.current = null;
          }
        }, 0);
      }
      return;
    }

    if (historyReleaseTimerRef.current != null) {
      clearTimeout(historyReleaseTimerRef.current);
      historyReleaseTimerRef.current = null;
    }

    const releaseScroll = scrollLocks.current.acquire();

    if (!focusRestoreRef.current) {
      const focusHost = browserFocusHost();
      if (focusHost) focusRestoreRef.current = captureFocus(focusHost);
    }

    // One history frame for the whole primary-active lifetime. Replace policy
    // retargets the marker in place (replaceState); never release+push on
    // identity change or a deferred back from the old binding dismisses the new primary.
    // System Back deactivates the binding before React re-renders; drop it so we
    // push a fresh frame instead of retargeting a dead listener.
    if (historyBindingRef.current && !historyBindingRef.current.isActive()) {
      historyBindingRef.current = null;
      activeIdRef.current = null;
    }

    if (!historyBindingRef.current) {
      activeIdRef.current = top.id;
      const historyHost = browserHistoryHost();
      if (historyHost) {
        historyBindingRef.current = bindOverlayHistory({
          history: historyHost,
          overlayId: top.id,
          onBack: () => controller.handleDismiss()
        });
      }
    } else if (activeIdRef.current !== top.id) {
      historyBindingRef.current.retarget(top.id);
      activeIdRef.current = top.id;
    }

    if (!viewportBindingRef.current) {
      const vvHost = browserVisualViewportHost();
      if (vvHost) {
        viewportBindingRef.current = bindVisualViewport(vvHost);
      }
    }

    return () => {
      releaseScroll();
    };
  }, [controller, primaryActive, top]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (!controller.isPrimaryActive()) return;
      event.preventDefault();
      event.stopPropagation();
      controller.handleDismiss();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [controller]);

  useEffect(() => {
    const locks = scrollLocks.current;
    return () => {
      if (historyReleaseTimerRef.current != null) {
        clearTimeout(historyReleaseTimerRef.current);
        historyReleaseTimerRef.current = null;
      }
      historyBindingRef.current?.release();
      historyBindingRef.current = null;
      viewportBindingRef.current?.release();
      viewportBindingRef.current = null;
      locks.releaseAll();
    };
  }, []);

  const open = useCallback((input: OpenOverlayInput) => controller.open(input), [controller]);
  const close = useCallback(
    (id?: string, options?: { silent?: boolean }) => controller.close(id, options),
    [controller]
  );
  const closeTop = useCallback(
    (options?: { silent?: boolean }) => controller.closeTop(options),
    [controller]
  );
  const handleDismiss = useCallback(() => controller.handleDismiss(), [controller]);
  const getTop = useCallback(() => controller.getTop(), [controller]);
  const isPrimaryActive = useCallback(() => controller.isPrimaryActive(), [controller]);
  const hasKind = useCallback(
    (kind: PrimaryOverlayKind) => controller.hasKind(kind),
    [controller]
  );

  const value = useMemo<MobileOverlayContextValue>(
    () => ({
      controller,
      open,
      close,
      closeTop,
      handleDismiss,
      getTop,
      isPrimaryActive,
      hasKind,
      top,
      primaryActive
    }),
    [
      controller,
      open,
      close,
      closeTop,
      handleDismiss,
      getTop,
      isPrimaryActive,
      hasKind,
      top,
      primaryActive
    ]
  );

  return (
    <MobileOverlayContext.Provider value={value}>{children}</MobileOverlayContext.Provider>
  );
}

export function useMobileOverlay(): MobileOverlayContextValue {
  const ctx = useContext(MobileOverlayContext);
  if (!ctx) {
    throw new Error("useMobileOverlay must be used inside <MobileOverlayProvider>");
  }
  return ctx;
}

export function useMobileOverlayOptional(): MobileOverlayContextValue | null {
  return useContext(MobileOverlayContext);
}

export interface UsePrimaryOverlayOptions {
  kind: PrimaryOverlayKind;
  open: boolean;
  onRequestClose: () => void;
  policy?: OpenConflictPolicy;
  id?: string;
  payload?: unknown;
}

/**
 * Register a primary overlay with the shared controller while `open` is true.
 * Owner-driven close uses silent unregister so onRequestClose is not re-entered.
 * Controller-driven dismiss (Back, Escape, replace) calls onRequestClose.
 */
export function usePrimaryOverlay(options: UsePrimaryOverlayOptions): {
  isTop: boolean;
  entryId: string | null;
} {
  const overlay = useMobileOverlayOptional();
  const entryIdRef = useRef<string | null>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  const onRequestCloseRef = useRef(options.onRequestClose);
  onRequestCloseRef.current = options.onRequestClose;

  const stableClose = useCallback(() => {
    onRequestCloseRef.current();
  }, []);

  useEffect(() => {
    if (!overlay) return;

    if (!options.open) {
      if (entryIdRef.current) {
        const id = entryIdRef.current;
        entryIdRef.current = null;
        setEntryId(null);
        overlay.controller.close(id, { silent: true });
      }
      return;
    }

    const result = overlay.open({
      kind: options.kind,
      id: options.id,
      policy: options.policy ?? "replace",
      onRequestClose: stableClose,
      payload: options.payload
    });

    if (result.ok) {
      entryIdRef.current = result.id;
      setEntryId(result.id);
    } else {
      entryIdRef.current = null;
      setEntryId(null);
      stableClose();
    }

    return () => {
      if (entryIdRef.current) {
        const id = entryIdRef.current;
        entryIdRef.current = null;
        overlay.controller.close(id, { silent: true });
      }
    };
  }, [overlay, options.open, options.kind, options.id, options.policy, stableClose]);

  const isTop = Boolean(overlay && entryId && overlay.top && overlay.top.id === entryId);

  return { isTop, entryId };
}
