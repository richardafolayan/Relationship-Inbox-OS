import type { ElementHandle, Locator, Page } from "patchright";

/**
 * Humanization helpers for browser automation.
 *
 * Playwright's defaults are deeply un-human — clicks fire the same frame
 * an element appears, mouse paths are straight lines, keystrokes hit at a
 * fixed cadence. Detection scripts on serious platforms (LinkedIn, X,
 * Instagram) flag those signatures even when navigator.webdriver is
 * suppressed. This module replaces the common Playwright actions with
 * versions that hesitate, curve, and jitter — close enough to a real
 * person to slip past behavioural fingerprinting.
 *
 * What it can't do: hide the open CDP debugger socket Playwright keeps
 * to talk to the browser. That's structural — defeating it would mean
 * switching to a CDP-patched fork (rebrowser-patches) or driving Chrome
 * over a different transport. Out of scope here.
 */

// Tunables. Conservative ranges chosen from observational research on
// real users; tighter than the defaults a "fast power user" would
// produce, looser than scripted automation.
const READING_PAUSE_MIN_MS = 600;
const READING_PAUSE_MAX_MS = 1800;
const PRE_CLICK_HESITATION_MIN_MS = 80;
const PRE_CLICK_HESITATION_MAX_MS = 240;
const TYPING_DELAY_MIN_MS = 60;
const TYPING_DELAY_MAX_MS = 180;
// Real people pause occasionally mid-word ("hmm, what was I saying").
const TYPING_THINK_CHANCE = 0.08;
const TYPING_THINK_MIN_MS = 220;
const TYPING_THINK_MAX_MS = 540;
const CURSOR_MOVE_MIN_STEPS = 18;
const CURSOR_MOVE_MAX_STEPS = 32;

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random wait between min and max ms. Replaces hardcoded waitForTimeout. */
export async function humanWait(minMs: number, maxMs: number): Promise<void> {
  await sleep(randInt(minMs, maxMs));
}

/**
 * "Operator looked at the screen, decided what to do." Insert before any
 * action that follows an element appearing or a page becoming ready.
 * Defaults are tuned for the most common case (reading a fresh row of
 * info before clicking it).
 */
export async function readingPause(
  minMs: number = READING_PAUSE_MIN_MS,
  maxMs: number = READING_PAUSE_MAX_MS
): Promise<void> {
  await sleep(randInt(minMs, maxMs));
}

/**
 * Quadratic Bézier interpolation between three points. Used to give the
 * cursor a curved path with a single control point — close enough to
 * the lazy hand-arc real users produce without the cost of a proper
 * arm/forearm IK model.
 */
function bezierPoint(
  t: number,
  from: { x: number; y: number },
  ctrl: { x: number; y: number },
  to: { x: number; y: number }
): { x: number; y: number } {
  const inv = 1 - t;
  return {
    x: inv * inv * from.x + 2 * inv * t * ctrl.x + t * t * to.x,
    y: inv * inv * from.y + 2 * inv * t * ctrl.y + t * t * to.y
  };
}

interface ResolvedElement {
  box: { x: number; y: number; width: number; height: number };
}

async function resolveBoundingBox(target: Locator | ElementHandle): Promise<ResolvedElement | null> {
  const box = await (target as Locator | ElementHandle).boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) return null;
  return { box };
}

/**
 * Move the cursor along a curved path from its current position to a
 * point inside `target`. The end point is randomised within the inner
 * 60% of the bounding box so we don't always land dead-centre. The
 * control point is offset perpendicular to the travel vector by a
 * random amount, producing a left- or right-handed arc that varies
 * shot-to-shot.
 */
export async function humanCursorMove(
  page: Page,
  target: Locator | ElementHandle
): Promise<{ x: number; y: number } | null> {
  const resolved = await resolveBoundingBox(target);
  if (!resolved) return null;
  const { box } = resolved;
  // Land inside the inner 60% of the box to avoid the literal centre.
  const insetX = box.width * 0.2;
  const insetY = box.height * 0.2;
  const targetX = box.x + insetX + Math.random() * (box.width - insetX * 2);
  const targetY = box.y + insetY + Math.random() * (box.height - insetY * 2);

  // Playwright doesn't expose the current cursor position. Approximate
  // by starting from a randomised "previous position" near the target;
  // the move is about producing visible motion before the click, not
  // tracking absolute pointer state.
  const startX = targetX + randFloat(-260, 260);
  const startY = targetY + randFloat(-160, 160);
  // Perpendicular offset for the control point creates the arc.
  const dx = targetX - startX;
  const dy = targetY - startY;
  const len = Math.hypot(dx, dy) || 1;
  const perpX = -dy / len;
  const perpY = dx / len;
  const arc = randFloat(-80, 80);
  const ctrl = {
    x: (startX + targetX) / 2 + perpX * arc,
    y: (startY + targetY) / 2 + perpY * arc
  };

  const steps = randInt(CURSOR_MOVE_MIN_STEPS, CURSOR_MOVE_MAX_STEPS);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const point = bezierPoint(
      t,
      { x: startX, y: startY },
      ctrl,
      { x: targetX, y: targetY }
    );
    // 1-step move per call so each segment renders separately.
    await page.mouse.move(point.x, point.y, { steps: 1 });
    // Small per-segment delay; total path takes ~150-400ms.
    if (i % 3 === 0) await sleep(randInt(4, 14));
  }
  return { x: targetX, y: targetY };
}

export interface HumanClickOptions {
  /**
   * Reading-pause range to apply before the click. Pass `null` to skip
   * (use when the previous step already paused, or when this click is
   * a chained action like "select-all then submit").
   */
  reading?: { min: number; max: number } | null;
  /** Skip the curved cursor move (useful when the target isn't visible). */
  skipCursorMove?: boolean;
  /** Force-click bypass for elements covered by other elements. */
  force?: boolean;
  /** Maximum wait for the element to be actionable. */
  timeout?: number;
}

/**
 * Click a target with human-shaped timing: reading pause → curved
 * cursor approach → small hesitation → click. Use this in place of
 * `locator.click()` everywhere a real user would deliberately click
 * (so basically everywhere visible — the few places where a "click"
 * is a hidden state-toggle don't need it).
 */
export async function humanClick(
  page: Page,
  target: Locator | ElementHandle,
  options: HumanClickOptions = {}
): Promise<void> {
  const reading = options.reading === undefined
    ? { min: READING_PAUSE_MIN_MS, max: READING_PAUSE_MAX_MS }
    : options.reading;
  if (reading) await sleep(randInt(reading.min, reading.max));
  if (!options.skipCursorMove) {
    await humanCursorMove(page, target).catch(() => undefined);
  }
  await sleep(randInt(PRE_CLICK_HESITATION_MIN_MS, PRE_CLICK_HESITATION_MAX_MS));
  await (target as Locator | ElementHandle).click({
    force: options.force,
    timeout: options.timeout
  });
}

export interface HumanTypeOptions {
  /** Skip the focus click (caller already focused the field). */
  alreadyFocused?: boolean;
  /** Per-keystroke delay range. Defaults to a real-person typing rhythm. */
  delay?: { min: number; max: number };
  /** Reading pause before starting to type. */
  reading?: { min: number; max: number } | null;
  /** Disable mid-word "thinking" pauses (use for short fields like passwords). */
  noThink?: boolean;
}

/**
 * Split text into the units `humanType` types one at a time. Uses
 * `Array.from`, which iterates by Unicode code point, so a non-BMP
 * character (emoji, e.g. 😂) stays a single unit instead of being cut
 * into its two UTF-16 surrogate halves. Iterating by `text.length` /
 * `text[i]` would feed `page.keyboard.type` a lone surrogate and corrupt
 * the sent message; for plain BMP/ASCII text this is a no-op.
 */
export function toTypingUnits(text: string): string[] {
  return Array.from(text);
}

/**
 * Type text into a target with jittered per-keystroke delays and
 * occasional mid-word "thinking" pauses. Replaces both `locator.fill()`
 * and `page.keyboard.type(text, { delay })` — `fill()` is instant and
 * the constant `delay` is a giveaway.
 */
export async function humanType(
  page: Page,
  target: Locator | ElementHandle,
  text: string,
  options: HumanTypeOptions = {}
): Promise<void> {
  const reading = options.reading === undefined
    ? { min: 200, max: 600 }
    : options.reading;
  if (reading) await sleep(randInt(reading.min, reading.max));
  if (!options.alreadyFocused) {
    await humanCursorMove(page, target).catch(() => undefined);
    await sleep(randInt(PRE_CLICK_HESITATION_MIN_MS, PRE_CLICK_HESITATION_MAX_MS));
    await (target as Locator | ElementHandle).click({ timeout: 5000 }).catch(async () => {
      // Fallback: focus via the locator if click somehow didn't land.
      await (target as Locator | ElementHandle).focus().catch(() => undefined);
    });
    await sleep(randInt(120, 320));
  }
  const minDelay = options.delay?.min ?? TYPING_DELAY_MIN_MS;
  const maxDelay = options.delay?.max ?? TYPING_DELAY_MAX_MS;
  const units = toTypingUnits(text);
  for (let i = 0; i < units.length; i += 1) {
    await page.keyboard.type(units[i] ?? "");
    await sleep(randInt(minDelay, maxDelay));
    if (!options.noThink && Math.random() < TYPING_THINK_CHANCE && i < units.length - 1) {
      await sleep(randInt(TYPING_THINK_MIN_MS, TYPING_THINK_MAX_MS));
    }
  }
}

/**
 * Hover over a target with a curved cursor approach. Use before
 * `mouse.wheel(...)` so the wheel event has a believable origin.
 */
export async function humanHover(
  page: Page,
  target: Locator | ElementHandle
): Promise<void> {
  await humanCursorMove(page, target).catch(() => undefined);
  await sleep(randInt(60, 160));
}

/**
 * Add a small wait jitter on top of a fixed wait — useful when a
 * waitForTimeout call has a load-bearing minimum but the exact value
 * shouldn't be a constant.
 */
export async function humanWaitAround(baseMs: number, jitterMs: number = 200): Promise<void> {
  const min = Math.max(0, baseMs - jitterMs);
  const max = baseMs + jitterMs;
  await sleep(randInt(min, max));
}
