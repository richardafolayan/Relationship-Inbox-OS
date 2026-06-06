// Identity guard for the contact Profile drawer's async AI writebacks.
//
// The Profile drawer does NOT remount across open/close cycles (it is rendered
// behind `profileEverOpened` and toggled via the `open` prop), so its state
// survives between opens. An async action started in one open session — the
// "Ask the AI about them" answer or the friendship summary — can therefore
// resolve AFTER the operator has already closed the drawer or switched it to a
// different person. Writing that stale result into state at that point makes it
// resurface on the next open, showing an answer the operator never asked for in
// the current session.
//
// `isCurrentDrawerRequest` is the single decision: apply the result only when
// the open-session token the request started with is still the live token.
// Callers snapshot `drawerRequestTokenRef.current` before the await
// (`snapshotToken`) and pass the live token after it resolves (`currentToken`).
// The token is advanced on every open and every personId change, so this also
// covers the close -> reopen-same-person case that comparing personId would
// miss. This mirrors `thread-identity-guard.ts` for the thread page.
export function isCurrentDrawerRequest(
  snapshotToken: number,
  currentToken: number
): boolean {
  return snapshotToken === currentToken;
}
