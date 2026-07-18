// Pure swipe-dismiss decision for the mobile action sheet, factored out so
// unit tests can cover the threshold without a DOM.

export const SHEET_SWIPE_DISMISS_PX = 72;

// A downward drag past the threshold dismisses. Upward or short drags
// spring the sheet back. Velocity is optional: a quick flick also dismisses
// when travel is at least half the threshold.
export function shouldDismissSheetSwipe(deltaY: number, velocityY = 0): boolean {
  if (deltaY >= SHEET_SWIPE_DISMISS_PX) return true;
  if (deltaY >= SHEET_SWIPE_DISMISS_PX / 2 && velocityY > 0.55) return true;
  return false;
}
