"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type TouchEvent as ReactTouchEvent
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { shouldDismissSheetSwipe } from "@/lib/action-sheet-gesture";

export type ActionSheetItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
};

export type ActionSheetGroup = {
  id: string;
  label?: string;
  items: ActionSheetItem[];
};

type ActionSheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  groups: ActionSheetGroup[];
  /** Restore focus here when the sheet closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Optional scroller to lock while open (e.g. thread timeline). */
  scrollLockTargetRef?: RefObject<HTMLElement | null>;
  /** history.state marker so Back closes the sheet before leaving the page. */
  historyKey?: string;
  /** Optional footer below the action list. */
  footer?: ReactNode;
};

export function ActionSheet({
  open,
  onClose,
  title,
  groups,
  returnFocusRef,
  scrollLockTargetRef,
  historyKey = "actionSheet",
  footer
}: ActionSheetProps) {
  const [mounted, setMounted] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const historyPushedRef = useRef(false);
  const scrollTopRef = useRef<number | null>(null);
  const bodyOverflowRef = useRef<string | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const touchLastYRef = useRef<number | null>(null);
  const touchLastTRef = useRef<number | null>(null);
  const velocityYRef = useRef(0);
  // Keep the latest onClose without re-binding history/escape effects on
  // every parent render (inline lambdas would otherwise re-pushState).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const requestClose = useCallback(() => {
    if (historyPushedRef.current) {
      historyPushedRef.current = false;
      window.history.back();
      return;
    }
    onCloseRef.current();
  }, []);

  // Escape closes before anything else (capture phase).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, requestClose]);

  // System / browser Back closes the sheet before leaving the page.
  // pushState on open; popstate closes; button/Escape/swipe/item close pop
  // the extra history entry via requestClose or effect cleanup.
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ [historyKey]: true }, "");
    historyPushedRef.current = true;
    const onPopState = () => {
      historyPushedRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      if (historyPushedRef.current) {
        historyPushedRef.current = false;
        // Parent closed us (item select / controlled close). Pop our entry
        // without waiting for a second popstate callback.
        window.history.back();
      }
    };
  }, [open, historyKey]);

  // Lock background scroll and preserve the thread message position.
  useEffect(() => {
    if (!open) return;
    const target = scrollLockTargetRef?.current ?? null;
    if (target) {
      scrollTopRef.current = target.scrollTop;
      target.style.overflow = "hidden";
    }
    bodyOverflowRef.current = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      if (target) {
        target.style.overflow = "";
        if (scrollTopRef.current != null) {
          target.scrollTop = scrollTopRef.current;
        }
        scrollTopRef.current = null;
      }
      if (bodyOverflowRef.current != null) {
        document.body.style.overflow = bodyOverflowRef.current;
        bodyOverflowRef.current = null;
      }
    };
  }, [open, scrollLockTargetRef]);

  // Focus close control on open; restore trigger focus on close.
  useEffect(() => {
    if (open) {
      const id = window.requestAnimationFrame(() => {
        closeButtonRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    const returnTo = returnFocusRef?.current ?? null;
    if (returnTo && document.contains(returnTo)) {
      returnTo.focus();
    }
  }, [open, returnFocusRef]);

  // Trap Tab inside the sheet while open.
  useEffect(() => {
    if (!open) return;
    const FOCUSABLE =
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const panel = sheetRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? panel.contains(active) : false;
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const onTouchStart = (event: ReactTouchEvent) => {
    const y = event.touches[0]?.clientY;
    if (y == null) return;
    touchStartYRef.current = y;
    touchLastYRef.current = y;
    touchLastTRef.current = event.timeStamp;
    velocityYRef.current = 0;
    setDragging(true);
  };

  const onTouchMove = (event: ReactTouchEvent) => {
    if (touchStartYRef.current == null) return;
    const y = event.touches[0]?.clientY;
    if (y == null) return;
    const delta = Math.max(0, y - touchStartYRef.current);
    const lastY = touchLastYRef.current;
    const lastT = touchLastTRef.current;
    if (lastY != null && lastT != null) {
      const dt = Math.max(1, event.timeStamp - lastT);
      velocityYRef.current = (y - lastY) / dt;
    }
    touchLastYRef.current = y;
    touchLastTRef.current = event.timeStamp;
    setDragY(delta);
  };

  const onTouchEnd = () => {
    const delta = dragY;
    const velocity = velocityYRef.current;
    touchStartYRef.current = null;
    touchLastYRef.current = null;
    touchLastTRef.current = null;
    setDragging(false);
    setDragY(0);
    if (shouldDismissSheetSwipe(delta, velocity)) {
      requestClose();
    }
  };

  if (!mounted || !open) return null;

  const content = (
    <div
      className="fixed inset-0 z-[110] flex items-end justify-center sm:hidden"
      data-testid="thread-action-sheet-root"
    >
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute inset-0 cursor-default bg-[color-mix(in_oklch,var(--ink)_38%,transparent)] backdrop-blur-[2px]"
        onClick={requestClose}
        data-testid="thread-action-sheet-backdrop"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="thread-action-sheet"
        style={{
          transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
          transition: dragging ? "none" : "transform 160ms ease-out"
        }}
        className="relative z-[1] flex max-h-[min(78dvh,640px)] w-full max-w-[520px] flex-col overflow-hidden rounded-t-[18px] border border-b-0 border-hairline bg-paper shadow-pop pb-[env(safe-area-inset-bottom)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="flex shrink-0 flex-col items-center pt-2"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          data-testid="thread-action-sheet-handle"
        >
          <div
            aria-hidden
            className="mb-1 h-1 w-10 rounded-full bg-hairline-strong"
          />
          <div className="flex w-full items-center gap-3 px-4 pb-2 pt-1">
            <p className="m-0 min-w-0 flex-1 text-[14px] font-semibold tracking-[-0.01em] text-ink">
              {title}
            </p>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={requestClose}
              aria-label="Close"
              title="Close"
              data-testid="thread-action-sheet-close"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
            >
              <X className="h-[15px] w-[15px]" strokeWidth={1.7} />
            </button>
          </div>
        </div>

        <div
          className="app-main-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3"
          data-testid="thread-action-sheet-body"
        >
          {groups.map((group, groupIndex) => {
            if (group.items.length === 0) return null;
            return (
              <section
                key={group.id}
                className={cn(groupIndex > 0 ? "mt-2 border-t border-hairline pt-2" : "")}
                data-testid={`thread-action-sheet-group-${group.id}`}
              >
                {group.label ? (
                  <p className="m-0 px-3 pb-1 pt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
                    {group.label}
                  </p>
                ) : null}
                <ul className="m-0 flex list-none flex-col p-0">
                  {group.items.map((item) => (
                    <li key={`${group.id}:${item.label}`}>
                      <button
                        type="button"
                        disabled={item.disabled}
                        onClick={() => {
                          // Close first so history cleanup + scroll unlock run,
                          // then fire the action on the next tick.
                          onClose();
                          window.setTimeout(() => item.onSelect(), 0);
                        }}
                        className={cn(
                          "flex w-full items-center rounded-[10px] px-3 py-[12px] text-left text-[15px] transition-colors duration-calm",
                          "hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-45",
                          item.danger
                            ? "text-accent-ink hover:bg-accent-soft"
                            : "text-ink"
                        )}
                      >
                        {item.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {footer ? <div className="mt-2 px-2 pt-1">{footer}</div> : null}
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
