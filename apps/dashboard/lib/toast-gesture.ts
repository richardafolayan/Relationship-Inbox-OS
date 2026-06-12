// Pure decision for what a pointer release on a toast card should do, factored
// out of <ToastCard> so the swipe-vs-click logic is unit-testable without a DOM.

// How far (px) a pointer-drag must travel before the toast is dismissed on
// release. Below the threshold it springs back (or activates, if interactive).
export const SWIPE_DISMISS_PX = 80;

export type ToastGesture = "dismiss" | "activate" | "springback";

// Decide the outcome of a pointer release given how far it travelled and
// whether the toast is interactive (has an href).
//
//   - travel beyond SWIPE_DISMISS_PX  -> dismiss (a swipe)
//   - any shorter release on an interactive toast -> activate (a click/tap)
//   - any shorter release otherwise   -> springback
//
// An interactive toast must activate on EVERY release below the dismiss
// threshold: a click rarely lands pixel-perfect, and a 7-80px release used to
// fall into a dead zone that neither navigated nor dismissed (the toast was
// silently swallowed).
export function resolveToastGesture(travelledPx: number, interactive: boolean): ToastGesture {
  if (Math.abs(travelledPx) > SWIPE_DISMISS_PX) return "dismiss";
  if (interactive) return "activate";
  return "springback";
}

// Same decision for a notification-center row. Rows are always clickable
// (they open the thread) and only a LEFT swipe dismisses: the panel hugs the
// right edge of the screen, so a right drag reads as "put it back", not
// "throw it away". A long right drag therefore springs back instead of
// activating - releasing way off to the right is an abandoned gesture, not
// a click.
export function resolveCenterRowGesture(travelledPx: number): ToastGesture {
  if (travelledPx < -SWIPE_DISMISS_PX) return "dismiss";
  if (travelledPx > SWIPE_DISMISS_PX) return "springback";
  return "activate";
}
