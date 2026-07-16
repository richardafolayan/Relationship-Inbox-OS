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
  clampDragOffset,
  computeArrowGeometry,
  computeCardPosition,
  resolveTourTarget,
  type GuidedTourCardOffset,
  type GuidedTourStep
} from "@/lib/guided-tour";

/**
 * Shared guided-tour overlay. Used by both the pilot first-run walkthrough
 * and the full presenter demo. Purely presentational — the parent owns
 * step state and decides when to advance/end.
 *
 * Behaviour:
 *  - Renders a draggable card pointing at the current step's anchor.
 *  - Dim only the area outside the anchor (the anchor itself stays crisp).
 *  - Arrow on whichever edge faces the target; hides when there's no
 *    anchor or after the operator has dragged the card far from it.
 *  - Controls: Back / Next / Skip / Exit / Restart. Hidden flags allow
 *    each surface to render only the buttons that apply.
 *  - Click-target steps (continueMode === "click-target") hide Next and
 *    listen for a click inside the anchor, then call onNext.
 *
 * Accessibility: the card has role="dialog" with aria-live="polite", a
 * label tied to the step title, and focus moves to it on every step
 * change. Escape calls onSkip if provided, otherwise onExit. Drag handle
 * is keyboard-skippable (tabindex -1).
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

  // ── Anchor measurement ─────────────────────────────────────────────
  const elementRef = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<ResolvedAnchor>({ rect: null, element: null });
  // Track which (step + element) pair we have already scrolled into view
  // so the polling re-measure does not keep yanking the page back. Reset
  // on step change so the next step gets one fresh scroll.
  const scrolledForRef = useRef<{ stepIndex: number; element: HTMLElement } | null>(null);
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
      // If the anchor is off-screen (or only partially visible), scroll
      // it into view once so the operator can actually see what the step
      // is pointing at. Once per (step, element) pair — subsequent
      // measure ticks must not re-trigger the scroll, otherwise the
      // page would yank back whenever the operator scrolls away.
      const already =
        scrolledForRef.current &&
        scrolledForRef.current.stepIndex === stepIndex &&
        scrolledForRef.current.element === el;
      if (!already) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const offscreen = r.bottom <= 0 || r.top >= vh || r.top < 0 || r.bottom > vh;
        if (offscreen) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
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
  }, [active, targets, stepIndex]);

  // ── Drag state ─────────────────────────────────────────────────────
  // Preserved across steps so the operator's preferred position sticks.
  // Reset to {0,0} whenever the operator presses "Reset position" or
  // the tour ends.
  const [dragOffset, setDragOffset] = useState<GuidedTourCardOffset>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active) setDragOffset({ x: 0, y: 0 });
  }, [active]);

  // ── Card position ──────────────────────────────────────────────────
  const [viewport, setViewport] = useState(() =>
    typeof window === "undefined"
      ? { width: 1200, height: 800 }
      : { width: window.innerWidth, height: window.innerHeight }
  );
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const [cardHeight, setCardHeight] = useState(CARD_HEIGHT_CEILING);
  useLayoutEffect(() => {
    if (!cardRef.current) return;
    const next = cardRef.current.getBoundingClientRect().height;
    if (Math.abs(next - cardHeight) > 4) setCardHeight(next);
  }, [step, cardHeight]);

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
  // Hide the arrow whenever the anchor is off-screen — the card is now
  // pinned to a corner and any arrow would point at empty space.
  const arrow =
    position.anchored && !position.pinned && anchor.rect
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

  // Focus the card on every step change for screen-reader and
  // keyboard users.
  useEffect(() => {
    if (!active || !cardRef.current) return;
    cardRef.current.focus();
  }, [active, stepIndex]);

  // ── Drag handlers ──────────────────────────────────────────────────
  const onDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // Only initiate drag from the header handle.
      const handle = (event.target as HTMLElement)?.closest("[data-drag-handle]");
      if (!handle) return;
      event.preventDefault();
      setDragging(true);
      dragStartRef.current = { x: event.clientX, y: event.clientY };
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      // Capture pointer so move/up fire even if the cursor leaves the
      // card while the operator drags fast.
      try {
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
      } catch {
        /* ignored: jsdom or older browsers without pointer capture */
      }
    },
    []
  );

  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (event: PointerEvent) => {
      const last = lastPointerRef.current;
      if (!last) return;
      const delta = { x: event.clientX - last.x, y: event.clientY - last.y };
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      setDragOffset((prev) => {
        // We want delta to be applied to the unclamped position, then
        // clamp to viewport. computeCardPosition already clamps, so the
        // base values here are the *current* clamped position.
        return clampDragOffset({
          baseTop: position.top - prev.y,
          baseLeft: position.left - prev.x,
          width: position.width,
          height: cardHeight,
          offset: prev,
          delta,
          viewport
        });
      });
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
  }, [dragging, position.top, position.left, position.width, cardHeight, viewport]);

  const resetPosition = useCallback(() => setDragOffset({ x: 0, y: 0 }), []);

  if (!active || !step) return null;

  const isLast = stepIndex >= steps.length - 1;
  const isFirst = stepIndex === 0;
  const isClickTarget = step.continueMode === "click-target";
  const showBackButton = !hideBack;

  const arrowStyle: React.CSSProperties | null = arrow
    ? (() => {
        const size = 8;
        const paperBg = "var(--paper)";
        const base: React.CSSProperties = {
          position: "absolute",
          // Decorative only — never absorb clicks. Without this, the
          // arrow inherits pointer-events:auto from the card and could
          // block a click on the highlighted target if the gap between
          // card and anchor ever shrinks below the 8px arrow extent.
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

  // Highlight ring uses a box-shadow with a large spread so the dim
  // sits *outside* the anchor rect. The anchor itself stays crisp and
  // readable. Anchorless / centred steps get a flat dim instead.
  const ringStyle: React.CSSProperties | null =
    position.anchored && !position.pinned && anchor.rect
      ? {
          top: anchor.rect.top - 6,
          left: anchor.rect.left - 6,
          width: anchor.rect.width + 12,
          height: anchor.rect.height + 12,
          // Tailwind shadow + ring would also work but a single
          // box-shadow lets us paint a large dim spread without
          // covering the anchor.
          boxShadow:
            "0 0 0 9999px color-mix(in oklch, var(--ink) 32%, transparent), 0 0 0 2px color-mix(in oklch, var(--accent) 70%, transparent)",
          borderRadius: 14,
          transition: "top 200ms, left 200ms, width 200ms, height 200ms"
        }
      : null;

  return (
    <div
      data-testid={`${variant}-tour-overlay`}
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
        className="pointer-events-auto absolute rounded-card border border-hairline bg-paper p-5 shadow-card outline-none"
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          cursor: dragging ? "grabbing" : undefined,
          // While dragging, kill transitions so the card tracks the
          // pointer 1:1.
          transition: dragging ? "none" : "top 180ms ease-out, left 180ms ease-out"
        }}
        onPointerDown={onDragPointerDown}
      >
        {arrowStyle ? <span aria-hidden style={arrowStyle} /> : null}

        <div
          data-drag-handle
          className="flex cursor-grab select-none items-center justify-between gap-3"
          style={{ minHeight: HEADER_HEIGHT, marginBottom: 8 }}
        >
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-ink-3">
            <span aria-hidden className="inline-flex flex-col gap-[2px]">
              <span className="block h-[2px] w-3 rounded-full bg-ink-4" />
              <span className="block h-[2px] w-3 rounded-full bg-ink-4" />
              <span className="block h-[2px] w-3 rounded-full bg-ink-4" />
            </span>
            <span>
              Step {stepIndex + 1} of {steps.length}
            </span>
          </div>
          {dragged ? (
            <button
              type="button"
              onClick={resetPosition}
              className="text-[10px] font-medium uppercase tracking-[0.06em] text-ink-3 hover:text-ink-2"
              data-testid={`${variant}-tour-reset-position`}
            >
              Reset position
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
            Click the highlighted area to continue.
          </p>
        ) : null}

        {renderFooterExtra ? <div className="mt-3">{renderFooterExtra()}</div> : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
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
              {isLast ? "Done" : "Next"}
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
                Skip tour
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

// Re-export the lib helpers under a stable surface so call sites don't
// have to remember whether a helper lives in the lib or the component.
export { CARD_WIDTH, CARD_GAP, CARD_HEIGHT_CEILING, resolveTourTarget } from "@/lib/guided-tour";
export type { GuidedTourStep, GuidedTourPlacement, GuidedTourContinueMode } from "@/lib/guided-tour";
