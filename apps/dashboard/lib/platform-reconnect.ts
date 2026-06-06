// Helper for the TopStatus platform-reconnect modal (components/layout/
// top-status.tsx). The modal's open-state (`reconnectOpen`, a boolean) is
// tracked separately from the data that justifies it (`degradedPlatforms`,
// derived fresh each render from the polled /data/platforms snapshot). When
// the last degraded platform reconnects — whether via the operator's own
// "Reconnect" click, a background 5s poll, or a runner-event refresh — the
// derived list empties but the boolean stays true, leaving the modal showing
// its "These platforms aren't connected" header over an empty list: a
// self-contradictory dead-end until the operator manually clicks Close.
//
// This is the optimistic-update / poll-desync failure mode. The fix keeps
// the open-state honest: the modal should auto-close once there is nothing
// left to reconnect, which doubles as clear confirmation the reconnect
// worked. Extracted as a pure predicate so the decision is unit-testable
// without mounting the component.

/**
 * Whether the open reconnect modal should auto-close itself. True only when
 * the modal is currently open AND no platforms remain degraded — i.e. the
 * data that justified opening it has gone away. Returns false when the modal
 * is already closed (nothing to do) or while degraded platforms remain (the
 * operator still has work to do in the modal).
 */
export function shouldAutoCloseReconnect(
  reconnectOpen: boolean,
  hasDegraded: boolean
): boolean {
  return reconnectOpen && !hasDegraded;
}
