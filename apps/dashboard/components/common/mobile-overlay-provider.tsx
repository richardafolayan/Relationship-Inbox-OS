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

export type OverlayNavigationMode = "push" | "replace";

/** Stable actions + controller. Does not change when top/primaryActive updates. */
export interface MobileOverlayActions {
  controller: MobileOverlayController;
  open: (input: OpenOverlayInput) => OpenOverlayResult;
  close: (id?: string, options?: { silent?: boolean }) => OverlayEntry | null;
  closeTop: (options?: { silent?: boolean }) => OverlayEntry | null;
  handleDismiss: () => boolean;
  prepareNavigation: (id?: string) => OverlayNavigationMode;
  getTop: () => OverlayEntry | null;
  isPrimaryActive: () => boolean;
  hasKind: (kind: PrimaryOverlayKind) => boolean;
}

/** Reactive snapshot. Updates whenever the primary stack changes. */
export interface MobileOverlaySnapshot {
  top: OverlayEntry | null;
  primaryActive: boolean;
}

export type MobileOverlayContextValue = MobileOverlayActions & MobileOverlaySnapshot;

const MobileOverlayActionsContext = createContext<MobileOverlayActions | null>(null);
const MobileOverlaySnapshotContext = createContext<MobileOverlaySnapshot>({
  top: null,
  primaryActive: false
});

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
 *
 * Actions and snapshot are separate contexts so hooks that only need to
 * register (usePrimaryOverlay) do not re-run when top/primaryActive changes.
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
  const prepareNavigation = useCallback(
    (id?: string): OverlayNavigationMode => {
      const current = controller.getTop();
      if (!current || (id && current.id !== id)) return "push";

      const binding = historyBindingRef.current;
      if (!binding?.consumeForNavigation()) return "push";

      if (historyReleaseTimerRef.current != null) {
        clearTimeout(historyReleaseTimerRef.current);
        historyReleaseTimerRef.current = null;
      }
      historyBindingRef.current = null;
      activeIdRef.current = null;
      return "replace";
    },
    [controller]
  );
  const getTop = useCallback(() => controller.getTop(), [controller]);
  const isPrimaryActive = useCallback(() => controller.isPrimaryActive(), [controller]);
  const hasKind = useCallback(
    (kind: PrimaryOverlayKind) => controller.hasKind(kind),
    [controller]
  );

  // Stable across stack changes: only controller identity and its bound actions.
  const actions = useMemo<MobileOverlayActions>(
    () => ({
      controller,
      open,
      close,
      closeTop,
      handleDismiss,
      prepareNavigation,
      getTop,
      isPrimaryActive,
      hasKind
    }),
    [
      controller,
      open,
      close,
      closeTop,
      handleDismiss,
      prepareNavigation,
      getTop,
      isPrimaryActive,
      hasKind
    ]
  );

  const snapshot = useMemo<MobileOverlaySnapshot>(
    () => ({ top, primaryActive }),
    [top, primaryActive]
  );

  return (
    <MobileOverlayActionsContext.Provider value={actions}>
      <MobileOverlaySnapshotContext.Provider value={snapshot}>
        {children}
      </MobileOverlaySnapshotContext.Provider>
    </MobileOverlayActionsContext.Provider>
  );
}

export function useMobileOverlayActions(): MobileOverlayActions {
  const ctx = useContext(MobileOverlayActionsContext);
  if (!ctx) {
    throw new Error("useMobileOverlayActions must be used inside <MobileOverlayProvider>");
  }
  return ctx;
}

export function useMobileOverlayActionsOptional(): MobileOverlayActions | null {
  return useContext(MobileOverlayActionsContext);
}

export function useMobileOverlaySnapshot(): MobileOverlaySnapshot {
  return useContext(MobileOverlaySnapshotContext);
}

export function useMobileOverlay(): MobileOverlayContextValue {
  const actions = useMobileOverlayActions();
  const snapshot = useMobileOverlaySnapshot();
  return useMemo(
    () => ({
      ...actions,
      ...snapshot
    }),
    [actions, snapshot]
  );
}

export function useMobileOverlayOptional(): MobileOverlayContextValue | null {
  const actions = useContext(MobileOverlayActionsContext);
  const snapshot = useMobileOverlaySnapshot();
  return useMemo(() => {
    if (!actions) return null;
    return { ...actions, ...snapshot };
  }, [actions, snapshot]);
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
 *
 * Depends on the stable actions context (controller + open/close), never the
 * reactive snapshot. Depending on the full context object re-ran this effect
 * on every open (top change → cleanup close → reopen loop).
 */
export function usePrimaryOverlay(options: UsePrimaryOverlayOptions): {
  isTop: boolean;
  entryId: string | null;
  prepareNavigation: () => OverlayNavigationMode;
} {
  const actions = useMobileOverlayActionsOptional();
  const snapshot = useMobileOverlaySnapshot();
  const entryIdRef = useRef<string | null>(null);
  const [entryId, setEntryId] = useState<string | null>(null);
  const onRequestCloseRef = useRef(options.onRequestClose);
  onRequestCloseRef.current = options.onRequestClose;

  const stableClose = useCallback(() => {
    onRequestCloseRef.current();
  }, []);

  // Stable primitives only: actions context identity is fixed for the
  // provider lifetime; controller/open/close do not change when top updates.
  const controller = actions?.controller;
  const openOverlay = actions?.open;
  const prepareOverlayNavigation = actions?.prepareNavigation;

  useEffect(() => {
    if (!controller || !openOverlay) return;

    if (!options.open) {
      if (entryIdRef.current) {
        const id = entryIdRef.current;
        entryIdRef.current = null;
        setEntryId(null);
        controller.close(id, { silent: true });
      }
      return;
    }

    const result = openOverlay({
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
        controller.close(id, { silent: true });
      }
    };
  }, [
    controller,
    openOverlay,
    options.open,
    options.kind,
    options.id,
    options.policy,
    stableClose
  ]);

  const isTop = Boolean(controller && entryId && snapshot.top && snapshot.top.id === entryId);
  const prepareNavigation = useCallback(
    () => prepareOverlayNavigation?.(entryIdRef.current ?? undefined) ?? "push",
    [prepareOverlayNavigation]
  );

  return { isTop, entryId, prepareNavigation };
}
