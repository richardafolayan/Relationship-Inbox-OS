// Shared guided-tour primitive. Used by both the pilot first-run
// walkthrough and the full presenter demo. Lives apart from the
// React component so unit tests can exercise the positioning maths
// and step traversal helpers without rendering.
//
// Conventions:
//   - Anchor lookup is by `[data-demo-target="<name>"]`, with
//     `[data-tour="<name>"]` accepted as a fallback so legacy anchors
//     still resolve.
//   - Steps with `targets: []` are anchorless and render centred.
//   - All coordinates are viewport coordinates (page-relative would
//     require recomputing on scroll, which the primitive does anyway).

export type GuidedTourPlacement = "top" | "bottom" | "left" | "right" | "center";
export type GuidedTourContinueMode = "next" | "click-target";

export interface GuidedTourStep {
  /** Stable id for tests, telemetry, and localStorage. */
  key: string;
  title: string;
  /** Body copy. Short, direct, no negative comparisons, no em dashes. */
  body: string;
  /**
   * Anchors to try in order. The first one that resolves to a DOM node
   * wins; the rest are fallbacks. Empty array means "no anchor, render
   * centred".
   */
  targets?: string[];
  /** Side of the target to anchor the card. Ignored when anchorless. */
  placement?: GuidedTourPlacement;
  /**
   * Returns a route the controller should navigate to before the step
   * shows. Returning the current pathname is a no-op. Returning null
   * means "stay where you are".
   */
  navigateTo?: () => string | null;
  /**
   * "next" (default) — operator presses Next.
   * "click-target" — primitive listens for a click inside the resolved
   * anchor and advances. Useful for safe navigation steps so the tour
   * mirrors the real interaction. Never for destructive actions.
   */
  continueMode?: GuidedTourContinueMode;
  /** Optional pre-body caption for "soft beat" steps (scanning, loading). */
  beat?: string;
}

export interface GuidedTourCardOffset {
  /** Pixels offset from the computed anchor position. Used for dragging. */
  x: number;
  y: number;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Width of the card. Lifted to a constant so position helpers and tests stay in sync. */
export const CARD_WIDTH = 360;
/** Approximate card height ceiling for clamping; cards are usually shorter. */
export const CARD_HEIGHT_CEILING = 240;
/** Gap between the anchor edge and the card edge. */
export const CARD_GAP = 14;
/** Inner viewport margin. The card never sits closer than this to any edge. */
export const VIEWPORT_MARGIN = 24;

// ── Anchor resolution ──────────────────────────────────────────────────

/**
 * Resolve a list of fallback target names to the first matching element.
 * Tries `[data-demo-target]` first, then `[data-tour]`. Returns null
 * during SSR.
 */
export function resolveTourTarget(targets: string[]): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const name of targets) {
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(name)
        : name.replace(/"/g, '\\"');
    const el =
      document.querySelector<HTMLElement>(`[data-demo-target="${escaped}"]`) ??
      document.querySelector<HTMLElement>(`[data-tour="${escaped}"]`);
    if (el) return el;
  }
  return null;
}

// ── Position helpers ──────────────────────────────────────────────────

export interface ComputeCardPositionInput {
  /** Anchor rect (viewport coords). Null = render centred. */
  rect: DOMRect | null;
  /** Desired placement relative to the anchor. */
  placement: GuidedTourPlacement;
  /** Operator's drag offset (in pixels), or { x: 0, y: 0 } if untouched. */
  dragOffset: GuidedTourCardOffset;
  viewport: { width: number; height: number };
  cardSize?: { width: number; height: number };
}

export interface ComputedCardPosition {
  top: number;
  left: number;
  width: number;
  /** Where the card actually ended up after viewport clamping. */
  resolvedPlacement: GuidedTourPlacement;
  /** True when the card is anchored to a real target. */
  anchored: boolean;
}

export function computeCardPosition(input: ComputeCardPositionInput): ComputedCardPosition {
  const width = input.cardSize?.width ?? CARD_WIDTH;
  const height = input.cardSize?.height ?? CARD_HEIGHT_CEILING;
  const vw = input.viewport.width;
  const vh = input.viewport.height;
  const minLeft = VIEWPORT_MARGIN;
  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN);
  const minTop = VIEWPORT_MARGIN;
  const maxTop = Math.max(VIEWPORT_MARGIN, vh - height - VIEWPORT_MARGIN);

  if (!input.rect) {
    const top = clamp(Math.round(vh / 2 - height / 2) + input.dragOffset.y, minTop, maxTop);
    const left = clamp(Math.round(vw / 2 - width / 2) + input.dragOffset.x, minLeft, maxLeft);
    return { top, left, width, resolvedPlacement: "center", anchored: false };
  }

  const rect = input.rect;
  let placement = input.placement;
  let top: number;
  let left: number;

  switch (placement) {
    case "top":
      top = rect.top - CARD_GAP - height;
      left = rect.left + rect.width / 2 - width / 2;
      break;
    case "left":
      top = rect.top + rect.height / 2 - height / 2;
      left = rect.left - CARD_GAP - width;
      break;
    case "right":
      top = rect.top + rect.height / 2 - height / 2;
      left = rect.left + rect.width + CARD_GAP;
      break;
    case "center":
      top = rect.top + rect.height / 2 - height / 2;
      left = rect.left + rect.width / 2 - width / 2;
      break;
    case "bottom":
    default:
      top = rect.top + rect.height + CARD_GAP;
      left = rect.left + rect.width / 2 - width / 2;
      break;
  }

  // Auto-flip if the chosen side overflows the viewport. Symmetric flip
  // (top ↔ bottom, left ↔ right). Centre stays put — we clamp it
  // into the viewport instead.
  if (placement === "bottom" && top + height > vh - VIEWPORT_MARGIN) {
    top = rect.top - CARD_GAP - height;
    placement = "top";
  } else if (placement === "top" && top < VIEWPORT_MARGIN) {
    top = rect.top + rect.height + CARD_GAP;
    placement = "bottom";
  } else if (placement === "right" && left + width > vw - VIEWPORT_MARGIN) {
    left = rect.left - CARD_GAP - width;
    placement = "left";
  } else if (placement === "left" && left < VIEWPORT_MARGIN) {
    left = rect.left + rect.width + CARD_GAP;
    placement = "right";
  }

  top = clamp(Math.round(top + input.dragOffset.y), minTop, maxTop);
  left = clamp(Math.round(left + input.dragOffset.x), minLeft, maxLeft);

  return { top, left, width, resolvedPlacement: placement, anchored: true };
}

// ── Arrow geometry ─────────────────────────────────────────────────────

export interface ComputeArrowInput {
  /** Position of the card after clamping. */
  card: { top: number; left: number; width: number };
  /** Anchor rect (viewport coords). */
  rect: DOMRect;
  /** Resolved placement (after auto-flip). */
  resolvedPlacement: GuidedTourPlacement;
  /** True when the card has been dragged away from its computed position. */
  dragged: boolean;
}

export interface ArrowGeometry {
  /** Which edge of the card the arrow sticks out from. */
  side: "top" | "bottom" | "left" | "right";
  /**
   * Offset along the card edge in pixels. For top/bottom: offset from card
   * left edge. For left/right: offset from card top edge.
   */
  offset: number;
}

/**
 * Compute where the arrow should sit on the card so it points at the
 * anchor. Returns null when the arrow should not render: anchor missing,
 * placement is "center", or the operator has dragged the card too far
 * for an honest pointer.
 */
export function computeArrowGeometry(input: ComputeArrowInput): ArrowGeometry | null {
  if (input.resolvedPlacement === "center") return null;
  const card = input.card;
  const rect = input.rect;
  const cardHeight = CARD_HEIGHT_CEILING; // upper bound; the arrow snaps near the edge

  // If the operator has dragged the card far from the anchor, the
  // pointer would lie about where the target is. Drop the arrow when
  // the card no longer overlaps the anchor's perpendicular axis.
  if (input.dragged) {
    if (input.resolvedPlacement === "top" || input.resolvedPlacement === "bottom") {
      const centreX = card.left + card.width / 2;
      if (centreX < rect.left - 80 || centreX > rect.right + 80) return null;
    } else {
      const centreY = card.top + cardHeight / 2;
      if (centreY < rect.top - 80 || centreY > rect.bottom + 80) return null;
    }
  }

  if (input.resolvedPlacement === "top" || input.resolvedPlacement === "bottom") {
    const targetCentreX = rect.left + rect.width / 2;
    const rawOffset = targetCentreX - card.left;
    const offset = clamp(rawOffset, 16, card.width - 16);
    return {
      side: input.resolvedPlacement === "top" ? "bottom" : "top",
      offset
    };
  }

  const targetCentreY = rect.top + rect.height / 2;
  const rawOffset = targetCentreY - card.top;
  const offset = clamp(rawOffset, 16, cardHeight - 16);
  return {
    side: input.resolvedPlacement === "left" ? "right" : "left",
    offset
  };
}

// ── Drag clamping ──────────────────────────────────────────────────────

export interface ClampDragInput {
  /** Card position before applying the new drag delta. */
  baseTop: number;
  baseLeft: number;
  width: number;
  height: number;
  /** Cumulative drag offset before the new delta. */
  offset: GuidedTourCardOffset;
  /** Mouse delta since drag start. */
  delta: { x: number; y: number };
  viewport: { width: number; height: number };
}

/**
 * Apply a new drag delta and clamp the result so the card cannot leave
 * the viewport. Returns the new cumulative offset.
 */
export function clampDragOffset(input: ClampDragInput): GuidedTourCardOffset {
  const nextOffsetX = input.offset.x + input.delta.x;
  const nextOffsetY = input.offset.y + input.delta.y;
  const nextLeft = input.baseLeft + nextOffsetX;
  const nextTop = input.baseTop + nextOffsetY;
  const minLeft = VIEWPORT_MARGIN;
  const maxLeft = Math.max(VIEWPORT_MARGIN, input.viewport.width - input.width - VIEWPORT_MARGIN);
  const minTop = VIEWPORT_MARGIN;
  const maxTop = Math.max(VIEWPORT_MARGIN, input.viewport.height - input.height - VIEWPORT_MARGIN);
  const clampedLeft = clamp(nextLeft, minLeft, maxLeft);
  const clampedTop = clamp(nextTop, minTop, maxTop);
  return {
    x: clampedLeft - input.baseLeft,
    y: clampedTop - input.baseTop
  };
}

// ── Step traversal ─────────────────────────────────────────────────────

export function nextStepIndex(steps: GuidedTourStep[], current: number): number | null {
  const next = current + 1;
  return next < steps.length ? next : null;
}

export function prevStepIndex(_steps: GuidedTourStep[], current: number): number {
  return current > 0 ? current - 1 : 0;
}

export function isLastStep(steps: GuidedTourStep[], current: number): boolean {
  return current >= steps.length - 1;
}

// ── Util ──────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
