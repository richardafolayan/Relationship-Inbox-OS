// After marking an At Risk thread handled in reply-focus mode, the focus index
// must stay PUT — it must NOT advance. Archiving the handled thread triggers a
// refresh that drops it from the sorted list and slides the next thread into
// the current focus index; advancing as well would skip that next thread.
// (When the handled thread was the last one, the kept index points past the
// shrunk list and the caller shows the "All done." state.)
export function nextFocusIndexAfterMarkHandled(focusIndex: number): number {
  return focusIndex;
}
