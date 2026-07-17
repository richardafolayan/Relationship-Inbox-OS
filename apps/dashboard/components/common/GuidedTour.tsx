"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";

import {
  CARD_GAP,
  CARD_HEIGHT_CEILING,
  CARD_WIDTH,
  MOBILE_COACH_SHEET_HEIGHT,
  MOBILE_TOUR_BREAKPOINT,
  SPOTLIGHT_PAD,
  clampDragOffset,
  computeArrowGeometry,
  computeCardPosition,
  computeMobileCoachLayout,
  computeTourScrollDelta,
  isMobileTourViewport,
  isTargetInTourBand,
  resolveTourTarget,
  setGuidedTourSurfaceActive,
  type GuidedTourCardOffset,
  type GuidedTourStep,
  type MobileCoachLayout
} from "@/lib/guided-tour";

/**
 * Shared guided-tour overlay. Used by both the pilot first-run walkthrough
 * and the full presenter demo. Purely presentational — the parent owns
 * step state and decides when to advance/end.
 *
 * Desktop: draggable card pointing at the current step's anchor.
 * Mobile: stable bottom coach sheet with reserved clearance, auto-scroll,
 * and a full-screen fallback when no safe placement exists. No drag handle
 * and no user-facing position reset control.
 */
export interface GuidedTourProps {
  steps: GuidedTourStep[];
  stepIndex: number;
  active: boolean;
  /**
   * When true the card renders but the Next button is disabled.
   * Useful while the parent is seeding the sandbox.
   */
  busy?: boolean;
  /** Hide the Back button regardless of position. */
  hideBack?: boolean;
  /** Hide the Skip button (e.g. presenter demo uses Exit instead). */
  hideSkip?: boolean;
  /** Show the Restart button. */
  showRestart?: boolean;
  /** Show the Exit button. Pilot uses Skip; presenter uses Exit. */
  showExit?: boolean;
  /**
   * Footer renderer for extra controls (e.g. autoplay toggle). Rendered
   * above the row of Back / Next / Skip buttons.
   */
  renderFooterExtra?: () => ReactNode;
  onNext: () => void;
  onBack: () => void;
  onSkip?: () => void;
  onExit?: () => void;
  onRestart?: () => void;
  /** Stable variant id used for test ids and the draggable-position key. */
  variant: "pilot" | "presenter";
}

interface ResolvedAnchor {
  rect: DOMRect | null;
  element: HTMLElement | null;
}

const HEADER_HEIGHT = 26;

function readSafeInsets(): { top: number; bottom: number; left: number; right: number } {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return { top: 0, bottom: 0, left: 0, right: 0 };
  }
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.documentElement.appendChild(probe);
  const style = getComputedStyle(probe);
  const parse = (value: string) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  const insets = {
    top: parse(style.paddingTop),
    right: parse(style.paddingRight),
    bottom: parse(style.paddingBottom),
    left: parse(style.paddingLeft)
  };
  probe.remove();
  return insets;
}

function readKeyboardInset(viewportHeight: number): number {
  if (typeof window === "undefined" || !window.visualViewport) return 0;
  const vv = window.visualViewport;
  // How much of the layout viewport is covered below the visual viewport
  // (software keyboard, browser chrome collapse differences).
  return Math.max(0, Math.round(viewportHeight - vv.height - vv.offsetTop));
}

function isDockVisible(): boolean {
  if (typeof window === "undefined") return false;
  if (!isMobileTourViewport(window.innerWidth)) return false;
  if (window.location.pathname.startsWith("/thread/")) return false;
  return true;
}

export function GuidedTour(props: GuidedTourProps) {
  const {
    steps,
    stepIndex,
    active,
    busy,
    hideBack,
    hideSkip,
    showRestart,
    showExit,
    renderFooterExtra,
    onNext,
    onBack,
    onSkip,
    onExit,
    onRestart,
    variant
  } = props;
  const step = active ? steps[stepIndex] ?? null : null;
  const targets = useMemo(() => step?.targets ?? [], [step]);
  const placement = step?.placement ?? "bottom";

  // ── Viewport / mobile detection ────────────────────────────────────
  const [viewport, setViewport] = useState(() =>
    typeof window === "undefined"
      ? { width: 1200, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight }
  );
  const mobile = isMobileTourViewport(viewport.width);
  const [safeInsets, setSafeInsets] = useState(() => readSafeInsets());
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [dockVisible, setDockVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () => {
      const width = window.innerWidth;
      const height = window.visualViewport?.height
        ? Math.round(window.visualViewport.height + window.visualViewport.offsetTop)
        : window.innerHeight;
      setViewport({ width, height: window.innerHeight });
      setSafeInsets(readSafeInsets());
      setKeyboardInset(readKeyboardInset(window.innerHeight));
      setDockVisible(isDockVisible());
      void height;
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);

  // Publish tour surface so shell/thread can close AI Assist, block the
  // palette, and freeze live list updates for the duration of the tour.
  useEffect(() => {
    if (!active) return undefined;
    setGuidedTourSurfaceActive(true, { variant });
    return () => setGuidedTourSurfaceActive(false, { variant });
  }, [active, variant]);

  // ── Anchor measurement ─────────────────────────────────────────────
  const elementRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<ResolvedAnchor>({ rect: null, element: null });
  // Track which (step + element) pair we have already scrolled into view
  // so the polling re-measure does not keep yanking the page back. Reset
  // on step change so the next step gets one fresh scroll.
  const scrolledForRef = useRef<{ stepIndex: number; element: HTMLElement } | null>(null);
  const mobileLayoutRef = useRef<MobileCoachLayout | null>(null);

  useLayoutEffect(() => {
    if (!active || targets.length === 0) {
      elementRef.current = null;
      setAnchor({ rect: null, element: null });
      return undefined;
    }
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const el = resolveTourTarget(targets);
      elementRef.current = el;
      if (!el) {
        setAnchor((prev) => (prev.element === null && prev.rect === null ? prev : { rect: null, element: null }));
        return;
      }
      const already =
        scrolledForRef.current &&
        scrolledForRef.current.stepIndex === stepIndex &&
        scrolledForRef.current.element === el;
      if (!already) {
        const r = el.getBoundingClientRect();
        if (mobile && mobileLayoutRef.current) {
          const band = mobileLayoutRef.current.targetBand;
          if (!isTargetInTourBand(r, band)) {
            const delta = computeTourScrollDelta(r, band);
            if (delta !== 0) {
              // Prefer scrolling the nearest scroll parent; fall back to
              // the element itself so nested list scrollers still move.
              const scroller = findScrollParent(el);
              if (scroller) {
                scroller.scrollBy({ top: delta, behavior: "smooth" });
              } else {
                el.scrollIntoView({ block: "center", behavior: "smooth" });
              }
            }
          }
        } else {
          const vh = window.innerHeight;
          const offscreen = r.bottom <= 0 || r.top >= vh || r.top < 0 || r.bottom > vh;
          if (offscreen) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        }
        scrolledForRef.current = { stepIndex, element: el };
      }
      const next = el.getBoundingClientRect();
      setAnchor((prev) => {
        if (
          prev.element === el &&
          prev.rect &&
          prev.rect.top === next.top &&
          prev.rect.left === next.left &&
          prev.rect.width === next.width &&
          prev.rect.height === next.height
        ) {
          return prev;
        }
        return { rect: next, element: el };
      });
    };
    measure();
    const interval = window.setInterval(measure, 250);
    const onChange = () => measure();
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [active, targets, stepIndex, mobile]);

  // Reset the one-shot scroll latch on step change.
  useEffect(() => {
    scrolledForRef.current = null;
  }, [stepIndex]);

  // ── Drag state (desktop only) ──────────────────────────────────────
  const [dragOffset, setDragOffset] = useState<GuidedTourCardOffset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) setDragOffset({ x: 0, y: 0 });
  }, [active]);

  const [cardHeight, setCardHeight] = useState(CARD_HEIGHT_CEILING);
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const next = cardRef.current.getBoundingClientRect().height;
    if (Math.abs(next - cardHeight) > 4) setCardHeight(next);
  }, [step, cardHeight, mobile, viewport.width]);

  const mobileLayout = useMemo(() => {
    if (!mobile) return null;
    return computeMobileCoachLayout({
      rect: anchor.rect,
      viewport,
      sheetHeight: cardHeight || MOBILE_COACH_SHEET_HEIGHT,
      safeInsets,
      dockVisible,
      keyboardInset
    });
  }, [mobile, anchor.rect, viewport, cardHeight, safeInsets, dockVisible, keyboardInset]);

  mobileLayoutRef.current = mobileLayout;

  // Re-scroll once the sheet height is known so the first paint does not
  // leave the target under the sheet after layout settles.
  useLayoutEffect(() => {
    if (!mobile || !mobileLayout || !anchor.element) return;
    if (mobileLayout.mode !== "sheet") return;
    const el = anchor.element;
    const r = el.getBoundingClientRect();
    if (isTargetInTourBand(r, mobileLayout.targetBand)) return;
    const delta = computeTourScrollDelta(r, mobileLayout.targetBand);
    if (delta === 0) return;
    const scroller = findScrollParent(el);
    if (scroller) scroller.scrollBy({ top: delta, behavior: "smooth" });
    else el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [mobile, mobileLayout, stepIndex, anchor.element]);

  const position = useMemo(
    () =>
      computeCardPosition({
        rect: anchor.rect,
        placement,
        dragOffset,
        viewport,
        cardSize: { width: CARD_WIDTH, height: cardHeight }
      }),
    [anchor.rect, placement, dragOffset, viewport, cardHeight]
  );

  const dragged = dragOffset.x !== 0 || dragOffset.y !== 0;
  const arrow =
    !mobile && position.anchored && !position.pinned && anchor.rect
      ? computeArrowGeometry({
          card: { top: position.top, left: position.left, width: position.width },
          rect: anchor.rect,
          resolvedPlacement: position.resolvedPlacement,
          dragged
        })
      : null;

  // ── Click-target advance ───────────────────────────────────────────
  useEffect(() => {
    if (!step || step.continueMode !== "click-target") return undefined;
    const onCapture = (event: MouseEvent) => {
      const el = elementRef.current;
      if (!el) return;
      const target = event.target instanceof Node ? event.target : null;
      if (!target || !el.contains(target)) return;
      onNext();
    };
    document.addEventListener("click", onCapture, true);
    return () => document.removeEventListener("click", onCapture, true);
  }, [step, onNext]);

  // ── Keyboard ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (onSkip) onSkip();
        else if (onExit) onExit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, onSkip, onExit]);

  useEffect(() => {
    if (!active || !cardRef.current) return;
    cardRef.current.focus();
  }, [active, stepIndex]);

  // ── Drag handlers (desktop) ────────────────────────────────────────
  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (mobile) return;
      if (event.button !== 0) return;
      const handle = (event.target as HTMLElement)?.closest("[data-drag-handle]");
      if (!handle) return;
      event.preventDefault();
      setDragging(true);
      dragStartRef.current = { x: event.clientX, y: event.clientY };
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      try {
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      } catch {
        /* ignored: jsdom or older browsers without pointer capture */
      }
    },
    [mobile]
  );

  useEffect(() => {
    if (!dragging || mobile) return undefined;
    const onMove = (event: PointerEvent) => {
      const last = lastPointerRef.current;
      if (!last) return;
      const delta = { x: event.clientX - last.x, y: event.clientY - last.y };
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      setDragOffset((prev) =>
        clampDragOffset({
          baseTop: position.top - prev.y,
          baseLeft: position.left - prev.x,
          width: position.width,
          height: cardHeight,
          offset: prev,
          delta,
          viewport
        })
      );
    };
    const onUp = () => {
      setDragging(false);
      dragStartRef.current = null;
      lastPointerRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging, mobile, position.top, position.left, position.width, cardHeight, viewport]);

  if (!active || !step) return null;

  const isLast = stepIndex >= steps.length - 1;
  const isFirst = stepIndex === 0;
  const isClickTarget = step.continueMode === "click-target";
  const showBackButton = !hideBack;
  const primaryLabel = isLast ? "Done" : mobile ? "Continue" : "Next";
  const fullscreen = mobile && mobileLayout?.mode === "fullscreen";
  const showSpotlight =
    mobile
      ? Boolean(mobileLayout?.showSpotlight && anchor.rect)
      : Boolean(position.anchored && !position.pinned && anchor.rect);

  const arrowStyle: React.CSSProperties | null = arrow
    ? (() => {
        const size = 8;
        const paperBg = "var(--paper)";
        const base: React.CSSProperties = {
          position: "absolute",
          pointerEvents: "none",
          width: 0,
          height: 0
        };
        if (arrow.side === "top") {
          return {
            ...base,
            top: -size,
            left: arrow.offset,
            transform: "translateX(-50%)",
            borderStyle: "solid",
            borderColor: `transparent transparent ${paperBg} transparent`,
            borderWidth: `0 ${size}px ${size}px ${size}px`
          };
        }
        if (arrow.side === "bottom") {
          return {
            ...base,
            bottom: -size,
            left: arrow.offset,
            transform: "translateX(-50%)",
            borderStyle: "solid",
            borderColor: `${paperBg} transparent transparent transparent`,
            borderWidth: `${size}px ${size}px 0 ${size}px`
          };
        }
        if (arrow.side === "left") {
          return {
            ...base,
            left: -size,
            top: arrow.offset,
            transform: "translateY(-50%)",
            borderStyle: "solid",
            borderColor: `transparent ${paperBg} transparent transparent`,
            borderWidth: `${size}px ${size}px ${size}px 0`
          };
        }
        return {
          ...base,
          right: -size,
          top: arrow.offset,
          transform: "translateY(-50%)",
          borderStyle: "solid",
          borderColor: `transparent transparent transparent ${paperBg}`,
          borderWidth: `${size}px 0 ${size}px ${size}px`
        };
      })()
    : null;

  const ringStyle: React.CSSProperties | null =
    showSpotlight && anchor.rect
      ? {
          top: anchor.rect.top - SPOTLIGHT_PAD,
          left: anchor.rect.left - SPOTLIGHT_PAD,
          width: anchor.rect.width + SPOTLIGHT_PAD * 2,
          height: anchor.rect.height + SPOTLIGHT_PAD * 2,
          boxShadow:
            "0 0 0 9999px color-mix(in oklch, var(--ink) 32%, transparent), 0 0 0 2px color-mix(in oklch, var(--accent) 70%, transparent)",
          borderRadius: 14,
          transition: "top 200ms, left 200ms, width 200ms, height 200ms"
        }
      : null;

  const cardStyle: React.CSSProperties = mobile
    ? fullscreen
      ? {
          top: mobileLayout?.sheetTop ?? Math.round(viewport.height * 0.12),
          left: 12,
          right: 12,
          width: "auto",
          bottom: (mobileLayout?.sheetBottomInset ?? 0) + 12,
          maxHeight: `calc(100dvh - ${(mobileLayout?.sheetTop ?? 48) + (mobileLayout?.sheetBottomInset ?? 0) + 24}px)`,
          overflow: "auto"
        }
      : {
          top: mobileLayout?.sheetTop ?? undefined,
          left: 0,
          right: 0,
          width: "auto",
          bottom: 0,
          paddingBottom: `max(12px, ${(mobileLayout?.sheetBottomInset ?? 0) + 8}px)`,
          borderRadius: "16px 16px 0 0",
          maxHeight: "min(48dvh, 360px)",
          overflow: "auto"
        }
    : {
        top: position.top,
        left: position.left,
        width: position.width,
        cursor: dragging ? "grabbing" : undefined,
        transition: dragging ? "none" : "top 180ms ease-out, left 180ms ease-out"
      };

  return (
    <div
      data-testid={`${variant}-tour-overlay`}
      data-tour-layout={mobile ? (fullscreen ? "mobile-fullscreen" : "mobile-sheet") : "desktop"}
      data-tour-mobile={mobile ? "true" : "false"}
      className="pointer-events-none fixed inset-0 z-[80]"
      aria-live="polite"
    >
      {ringStyle ? (
        <div aria-hidden className="pointer-events-none absolute" style={ringStyle} />
      ) : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: "color-mix(in oklch, var(--ink) 32%, transparent)" }}
        />
      )}

      <div
        ref={cardRef}
        role="dialog"
        aria-label={step.title}
        aria-modal={false}
        tabIndex={-1}
        data-testid={`${variant}-tour-card`}
        data-tour-mode={mobile ? (fullscreen ? "fullscreen" : "sheet") : "floating"}
        className={
          mobile
            ? "pointer-events-auto absolute border border-hairline bg-paper p-5 shadow-card outline-none"
            : "pointer-events-auto absolute rounded-card border border-hairline bg-paper p-5 shadow-card outline-none"
        }
        style={cardStyle}
        onPointerDown={onDragPointerDown}
      >
        {arrowStyle ? <span aria-hidden style={arrowStyle} /> : null}

        <div
          data-drag-handle={mobile ? undefined : true}
          className={
            mobile
              ? "flex select-none items-center justify-between gap-3"
              : "flex cursor-grab select-none items-center justify-between gap-3"
          }
          style={{ minHeight: HEADER_HEIGHT, marginBottom: 8 }}
        >
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-ink-3">
            {mobile ? null : (
              <span aria-hidden className="inline-flex flex-col gap-[2px]">
                <span className="block h-[2px] w-3 rounded-full bg-ink-4" />
                <span className="block h-[2px] w-3 rounded-full bg-ink-4" />
                <span className="block h-[2px] w-3 rounded-full bg-ink-4" />
              </span>
            )}
            <span>
              Step {stepIndex + 1} of {steps.length}
            </span>
          </div>
          {(onSkip || onExit) && mobile ? (
            <button
              type="button"
              onClick={() => {
                if (onSkip) onSkip();
                else if (onExit) onExit();
              }}
              className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-3 hover:text-ink-2"
              data-testid={`${variant}-tour-close`}
              aria-label="Close walkthrough"
            >
              Close
            </button>
          ) : null}
        </div>

        {step.beat ? (
          <p className="m-0 mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
            {step.beat}
          </p>
        ) : null}

        <h2 className="m-0 font-display text-[16px] font-semibold leading-[1.3] tracking-[-0.01em] text-ink">
          {step.title}
        </h2>

        <p className="m-0 mt-2 text-[13.5px] leading-[1.55] text-ink-2">{step.body}</p>

        {isClickTarget ? (
          <p className="m-0 mt-3 text-[12px] leading-[1.45] text-ink-3">
            {mobile ? "Tap the highlighted area to continue." : "Click the highlighted area to continue."}
          </p>
        ) : null}

        {renderFooterExtra ? <div className="mt-3">{renderFooterExtra()}</div> : null}

        <div
          className={
            mobile
              ? "mt-4 flex flex-wrap items-center gap-2"
              : "mt-4 flex flex-wrap items-center gap-2"
          }
          data-testid={`${variant}-tour-controls`}
        >
          {showBackButton ? (
            <button
              type="button"
              onClick={onBack}
              disabled={isFirst}
              data-testid={`${variant}-tour-back`}
              className="rounded-pill border border-hairline bg-paper px-3 py-[6px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Back
            </button>
          ) : null}

          {isClickTarget ? null : (
            <button
              type="button"
              onClick={onNext}
              disabled={!!busy}
              data-testid={`${variant}-tour-next`}
              className="rounded-pill bg-ink px-3 py-[6px] text-[12.5px] font-medium text-paper transition-colors duration-calm hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {primaryLabel}
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            {showRestart && onRestart ? (
              <button
                type="button"
                onClick={onRestart}
                data-testid={`${variant}-tour-restart`}
                className="text-[11.5px] font-medium text-ink-3 hover:text-ink-2"
              >
                Restart
              </button>
            ) : null}
            {!hideSkip && onSkip ? (
              <button
                type="button"
                onClick={onSkip}
                data-testid={`${variant}-tour-skip`}
                className="text-[11.5px] font-medium text-ink-3 hover:text-ink-2"
              >
                {mobile ? "Skip" : "Skip tour"}
              </button>
            ) : null}
            {showExit && onExit ? (
              <button
                type="button"
                onClick={onExit}
                data-testid={`${variant}-tour-exit`}
                className="text-[11.5px] font-medium text-ink-3 hover:text-ink-2"
              >
                Exit
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

// Re-export the lib helpers under a stable surface so call sites don't
// have to remember whether a helper lives in the lib or the component.
export {
  CARD_WIDTH,
  CARD_GAP,
  CARD_HEIGHT_CEILING,
  MOBILE_TOUR_BREAKPOINT,
  resolveTourTarget
} from "@/lib/guided-tour";
export type { GuidedTourStep, GuidedTourPlacement, GuidedTourContinueMode } from "@/lib/guided-tour";
