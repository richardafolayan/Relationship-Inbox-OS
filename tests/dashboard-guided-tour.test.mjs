import test from "node:test";
import assert from "node:assert/strict";

// guided-tour.ts is framework-free.
const {
  CARD_WIDTH,
  VIEWPORT_MARGIN,
  MOBILE_TOUR_BREAKPOINT,
  MOBILE_COACH_SHEET_HEIGHT,
  MOBILE_TARGET_SHEET_GAP,
  SPOTLIGHT_PAD,
  computeCardPosition,
  computeArrowGeometry,
  clampDragOffset,
  nextStepIndex,
  prevStepIndex,
  isLastStep,
  isMobileTourViewport,
  computeMobileCoachLayout,
  isTargetInTourBand,
  computeTourScrollDelta,
  shouldQueueLiveBanner,
  shouldFreezeLiveListUpdates,
  resolveFrozenListRows,
  planTourOverlayConflicts,
  isGuidedTourSurfaceActive,
  setGuidedTourSurfaceActive,
  GUIDED_TOUR_SURFACE_ACTIVE_KEY
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

// ── Mobile coach layout (#910) ─────────────────────────────────────────

const phone = { width: 390, height: 844 };

test("isMobileTourViewport matches the Tailwind sm breakpoint", () => {
  assert.equal(isMobileTourViewport(390), true);
  assert.equal(isMobileTourViewport(MOBILE_TOUR_BREAKPOINT - 1), true);
  assert.equal(isMobileTourViewport(MOBILE_TOUR_BREAKPOINT), false);
  assert.equal(isMobileTourViewport(1200), false);
});

test("computeMobileCoachLayout places a stable bottom sheet that never covers the target band", () => {
  const target = { top: 120, left: 16, width: 358, height: 72 };
  const layout = computeMobileCoachLayout({
    rect: target,
    viewport: phone,
    sheetHeight: MOBILE_COACH_SHEET_HEIGHT,
    safeInsets: { top: 47, bottom: 34 },
    dockVisible: true,
    keyboardInset: 0
  });
  assert.equal(layout.mode, "sheet");
  assert.equal(layout.showSpotlight, true);
  assert.ok(layout.sheetTop > target.top + target.height + MOBILE_TARGET_SHEET_GAP - 1);
  // Target band ends above the sheet with a gap so the spotlight stays clear.
  assert.ok(layout.targetBand.bottom <= layout.sheetTop - MOBILE_TARGET_SHEET_GAP + 1);
  assert.ok(layout.targetBand.height > target.height);
});

test("computeMobileCoachLayout falls back to fullscreen when the target cannot fit above the sheet", () => {
  // Tall target that will not fit in the remaining band on a short phone.
  const layout = computeMobileCoachLayout({
    rect: { top: 40, left: 0, width: 390, height: 700 },
    viewport: { width: 390, height: 640 },
    sheetHeight: 260,
    safeInsets: { top: 20, bottom: 20 },
    dockVisible: true
  });
  assert.equal(layout.mode, "fullscreen");
  assert.equal(layout.needsFullscreen, true);
  assert.equal(layout.showSpotlight, false);
});

test("computeMobileCoachLayout uses fullscreen when there is no target", () => {
  const layout = computeMobileCoachLayout({
    rect: null,
    viewport: phone,
    sheetHeight: MOBILE_COACH_SHEET_HEIGHT
  });
  assert.equal(layout.mode, "fullscreen");
  assert.equal(layout.showSpotlight, false);
});

test("computeMobileCoachLayout accounts for keyboard inset on the sheet bottom", () => {
  const withoutKeyboard = computeMobileCoachLayout({
    rect: { top: 80, left: 16, width: 350, height: 60 },
    viewport: phone,
    sheetHeight: 200,
    safeInsets: { bottom: 34 },
    dockVisible: false,
    keyboardInset: 0
  });
  const withKeyboard = computeMobileCoachLayout({
    rect: { top: 80, left: 16, width: 350, height: 60 },
    viewport: phone,
    sheetHeight: 200,
    safeInsets: { bottom: 34 },
    dockVisible: false,
    keyboardInset: 280
  });
  assert.ok(withKeyboard.sheetBottomInset > withoutKeyboard.sheetBottomInset);
  assert.ok(withKeyboard.sheetTop < withoutKeyboard.sheetTop);
});

test("isTargetInTourBand and computeTourScrollDelta keep the spotlight above the sheet", () => {
  const band = { top: 60, bottom: 500 };
  const inBand = { top: 120, height: 80 };
  assert.equal(isTargetInTourBand(inBand, band), true);
  assert.equal(computeTourScrollDelta(inBand, band), 0);

  const belowBand = { top: 520, height: 80 };
  assert.equal(isTargetInTourBand(belowBand, band), false);
  const delta = computeTourScrollDelta(belowBand, band);
  assert.ok(delta > 0, "target below the band should scroll down (positive delta)");

  const aboveBand = { top: -40, height: 80 };
  assert.equal(isTargetInTourBand(aboveBand, band), false);
  const up = computeTourScrollDelta(aboveBand, band);
  assert.ok(up < 0, "target above the band should scroll up (negative delta)");
});

test("live banners and list updates freeze while the tour is active", () => {
  assert.equal(shouldQueueLiveBanner(true), true);
  assert.equal(shouldQueueLiveBanner(false), false);
  assert.equal(shouldFreezeLiveListUpdates(true), true);
  assert.equal(shouldFreezeLiveListUpdates(false), false);

  const first = [{ id: "a" }, { id: "b" }];
  const second = [{ id: "b" }, { id: "c" }];
  const frozen = resolveFrozenListRows({
    tourActive: true,
    nextRows: first,
    frozenRows: null
  });
  assert.deepEqual(frozen.rows, first);
  assert.deepEqual(frozen.nextFrozen, first);

  const held = resolveFrozenListRows({
    tourActive: true,
    nextRows: second,
    frozenRows: frozen.nextFrozen
  });
  assert.deepEqual(held.rows, first, "live update must not replace the frozen list");
  assert.deepEqual(held.nextFrozen, first);

  const released = resolveFrozenListRows({
    tourActive: false,
    nextRows: second,
    frozenRows: first
  });
  assert.deepEqual(released.rows, second);
  assert.equal(released.nextFrozen, null);
});

test("planTourOverlayConflicts closes AI Assist and blocks the palette while the tour is open", () => {
  const idle = planTourOverlayConflicts({
    tourActive: false,
    aiAssistOpen: true,
    paletteOpen: true
  });
  assert.equal(idle.closeAiAssist, false);
  assert.equal(idle.closePalette, false);
  assert.equal(idle.blockPaletteOpen, false);

  const active = planTourOverlayConflicts({
    tourActive: true,
    aiAssistOpen: true,
    paletteOpen: true
  });
  assert.equal(active.closeAiAssist, true);
  assert.equal(active.closePalette, true);
  assert.equal(active.blockPaletteOpen, true);

  const alreadyClosed = planTourOverlayConflicts({
    tourActive: true,
    aiAssistOpen: false,
    paletteOpen: false
  });
  assert.equal(alreadyClosed.closeAiAssist, false);
  assert.equal(alreadyClosed.closePalette, false);
  assert.equal(alreadyClosed.blockPaletteOpen, true);
});

test("guided tour surface active flag writes and clears storage", () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k)
  };
  setGuidedTourSurfaceActive(true, { storage, variant: "pilot" });
  assert.equal(isGuidedTourSurfaceActive(storage), true);
  assert.equal(storage.getItem(GUIDED_TOUR_SURFACE_ACTIVE_KEY), "1");
  setGuidedTourSurfaceActive(false, { storage, variant: "pilot" });
  assert.equal(isGuidedTourSurfaceActive(storage), false);
});

test("GuidedTour source removes Reset position and uses mobile coach layout", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../apps/dashboard/components/common/GuidedTour.tsx", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /tour-reset-position/);
  assert.doesNotMatch(source, />\s*Reset position\s*</);
  assert.match(source, /computeMobileCoachLayout/);
  assert.match(source, /setGuidedTourSurfaceActive/);
  assert.match(source, /mobile-sheet|mobile-fullscreen|data-tour-layout/);
  assert.match(source, /Continue/);
  // Spotlight pad constant keeps the ring from covering the coach sheet math.
  assert.ok(SPOTLIGHT_PAD >= 4);
});
