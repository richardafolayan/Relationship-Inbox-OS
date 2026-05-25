import test from "node:test";
import assert from "node:assert/strict";

// guided-tour.ts is framework-free.
const {
  CARD_WIDTH,
  VIEWPORT_MARGIN,
  computeCardPosition,
  computeArrowGeometry,
  clampDragOffset,
  nextStepIndex,
  prevStepIndex,
  isLastStep
} = await import("../apps/dashboard/lib/guided-tour.ts");

const viewport = { width: 1200, height: 800 };
const cardSize = { width: CARD_WIDTH, height: 200 };

function rect({ top = 100, left = 100, width = 200, height = 50 } = {}) {
  return { top, left, width, height, right: left + width, bottom: top + height, x: left, y: top };
}

// ── computeCardPosition ────────────────────────────────────────────────

test("computeCardPosition renders anchorless steps centred", () => {
  const pos = computeCardPosition({
    rect: null,
    placement: "bottom",
    dragOffset: { x: 0, y: 0 },
    viewport,
    cardSize
  });
  assert.equal(pos.anchored, false);
  assert.equal(pos.resolvedPlacement, "center");
  // Centred horizontally
  assert.equal(pos.left, Math.round(viewport.width / 2 - cardSize.width / 2));
});

test("computeCardPosition places the card below a bottom-anchored target", () => {
  const pos = computeCardPosition({
    rect: rect({ top: 100, left: 400, width: 200, height: 50 }),
    placement: "bottom",
    dragOffset: { x: 0, y: 0 },
    viewport,
    cardSize
  });
  assert.equal(pos.anchored, true);
  assert.equal(pos.resolvedPlacement, "bottom");
  // Card top sits just below the anchor + gap.
  assert.ok(pos.top > 100 + 50);
});

test("computeCardPosition auto-flips when the chosen side would overflow the viewport", () => {
  // Anchor near the very top → placement: "top" would put the card above
  // the viewport. We expect a flip to "bottom".
  const pos = computeCardPosition({
    rect: rect({ top: 20, left: 400, width: 200, height: 50 }),
    placement: "top",
    dragOffset: { x: 0, y: 0 },
    viewport,
    cardSize
  });
  assert.equal(pos.resolvedPlacement, "bottom");
  assert.ok(pos.top >= 20 + 50);
});

test("computeCardPosition clamps the card to the viewport margins", () => {
  // Anchor pushed off the right edge → card.left would be > viewport.
  const pos = computeCardPosition({
    rect: rect({ top: 100, left: viewport.width - 50, width: 30, height: 50 }),
    placement: "right",
    dragOffset: { x: 0, y: 0 },
    viewport,
    cardSize
  });
  assert.ok(pos.left + cardSize.width <= viewport.width - VIEWPORT_MARGIN + 1);
  assert.ok(pos.left >= VIEWPORT_MARGIN);
});

test("computeCardPosition pins the card to a corner when the anchor scrolls fully off-screen", () => {
  // Anchor above the viewport (operator scrolled down past it).
  const pos = computeCardPosition({
    rect: rect({ top: -400, left: 400, width: 200, height: 50 }),
    placement: "bottom",
    dragOffset: { x: 0, y: 0 },
    viewport,
    cardSize
  });
  assert.equal(pos.pinned, true);
  assert.equal(pos.anchored, true);
  // Card sits near the bottom-right corner.
  assert.ok(pos.left + cardSize.width <= viewport.width - VIEWPORT_MARGIN + 1);
  assert.ok(pos.top + cardSize.height <= viewport.height - VIEWPORT_MARGIN + 1);
});

test("computeCardPosition respects safeTop so the card never sits behind a sticky header", () => {
  // Anchor near the top of the page; without safeTop the card placed
  // above the anchor would end up clamped to 24 (sticky header would
  // cover it). With safeTop=100 the card top must be at least 124.
  const pos = computeCardPosition({
    rect: rect({ top: 200, left: 400, width: 200, height: 50 }),
    placement: "top",
    dragOffset: { x: 0, y: 0 },
    viewport,
    safeTop: 100,
    cardSize
  });
  assert.ok(pos.top >= 100 + VIEWPORT_MARGIN, `card top ${pos.top} should sit below the safe area`);
});

test("computeCardPosition is not pinned when the anchor is partially visible", () => {
  // Anchor straddles the top edge: top is above the viewport but bottom is visible.
  const pos = computeCardPosition({
    rect: rect({ top: -20, left: 400, width: 200, height: 200 }),
    placement: "bottom",
    dragOffset: { x: 0, y: 0 },
    viewport,
    cardSize
  });
  assert.equal(pos.pinned, false);
  assert.equal(pos.anchored, true);
});

test("computeCardPosition applies dragOffset on top of the computed anchor", () => {
  const base = computeCardPosition({
    rect: rect({ top: 200, left: 400 }),
    placement: "bottom",
    dragOffset: { x: 0, y: 0 },
    viewport,
    cardSize
  });
  const dragged = computeCardPosition({
    rect: rect({ top: 200, left: 400 }),
    placement: "bottom",
    dragOffset: { x: 30, y: 25 },
    viewport,
    cardSize
  });
  assert.equal(dragged.left - base.left, 30);
  assert.equal(dragged.top - base.top, 25);
});

// ── computeArrowGeometry ──────────────────────────────────────────────

test("computeArrowGeometry hides the arrow when placement is centre", () => {
  const r = rect();
  const geometry = computeArrowGeometry({
    card: { top: 100, left: 100, width: CARD_WIDTH },
    rect: r,
    resolvedPlacement: "center",
    dragged: false
  });
  assert.equal(geometry, null);
});

test("computeArrowGeometry returns a 'top' side for a placement-bottom card (card under anchor)", () => {
  const r = rect({ top: 100, left: 400, width: 200, height: 50 });
  const geometry = computeArrowGeometry({
    card: { top: 200, left: 380, width: CARD_WIDTH },
    rect: r,
    resolvedPlacement: "bottom",
    dragged: false
  });
  assert.ok(geometry, "expected geometry, got null");
  assert.equal(geometry.side, "top");
  // Offset should fall between 16 and card.width - 16 so the arrow
  // never pokes through the rounded corner.
  assert.ok(geometry.offset >= 16);
  assert.ok(geometry.offset <= CARD_WIDTH - 16);
});

test("computeArrowGeometry hides the arrow when the card has been dragged far from the anchor", () => {
  const r = rect({ top: 100, left: 400, width: 200, height: 50 });
  const geometry = computeArrowGeometry({
    // Card dragged far to the right of the anchor.
    card: { top: 200, left: 900, width: CARD_WIDTH },
    rect: r,
    resolvedPlacement: "bottom",
    dragged: true
  });
  assert.equal(geometry, null, "arrow should hide when the card no longer aligns with the anchor");
});

// ── clampDragOffset ────────────────────────────────────────────────────

test("clampDragOffset prevents the card from leaving the right edge", () => {
  const result = clampDragOffset({
    baseTop: 100,
    baseLeft: viewport.width - cardSize.width - VIEWPORT_MARGIN,
    width: cardSize.width,
    height: cardSize.height,
    offset: { x: 0, y: 0 },
    delta: { x: 9999, y: 0 },
    viewport
  });
  // The right edge after applying the delta should not exceed
  // viewport.width - VIEWPORT_MARGIN.
  const newLeft = (viewport.width - cardSize.width - VIEWPORT_MARGIN) + result.x;
  assert.ok(newLeft <= viewport.width - cardSize.width - VIEWPORT_MARGIN + 1);
});

test("clampDragOffset prevents the card from leaving the top edge", () => {
  const result = clampDragOffset({
    baseTop: 100,
    baseLeft: 100,
    width: cardSize.width,
    height: cardSize.height,
    offset: { x: 0, y: 0 },
    delta: { x: 0, y: -9999 },
    viewport
  });
  const newTop = 100 + result.y;
  assert.ok(newTop >= VIEWPORT_MARGIN);
});

test("clampDragOffset accumulates onto the existing offset", () => {
  const first = clampDragOffset({
    baseTop: 100,
    baseLeft: 100,
    width: cardSize.width,
    height: cardSize.height,
    offset: { x: 0, y: 0 },
    delta: { x: 20, y: 15 },
    viewport
  });
  assert.equal(first.x, 20);
  assert.equal(first.y, 15);

  const second = clampDragOffset({
    baseTop: 100,
    baseLeft: 100,
    width: cardSize.width,
    height: cardSize.height,
    offset: first,
    delta: { x: 5, y: 5 },
    viewport
  });
  assert.equal(second.x, 25);
  assert.equal(second.y, 20);
});

// ── Step traversal ─────────────────────────────────────────────────────

test("nextStepIndex returns null when at the last step", () => {
  const steps = [{ key: "a", title: "A", body: "a" }, { key: "b", title: "B", body: "b" }];
  assert.equal(nextStepIndex(steps, 0), 1);
  assert.equal(nextStepIndex(steps, 1), null);
});

test("prevStepIndex floors at zero", () => {
  const steps = [{ key: "a", title: "A", body: "a" }, { key: "b", title: "B", body: "b" }];
  assert.equal(prevStepIndex(steps, 1), 0);
  assert.equal(prevStepIndex(steps, 0), 0);
});

test("isLastStep is true only on the final index", () => {
  const steps = [{ key: "a" }, { key: "b" }, { key: "c" }];
  assert.equal(isLastStep(steps, 0), false);
  assert.equal(isLastStep(steps, 1), false);
  assert.equal(isLastStep(steps, 2), true);
});
