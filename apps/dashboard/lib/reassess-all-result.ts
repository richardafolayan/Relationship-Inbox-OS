// Pure mapper for the "Reset all for reassessment" admin action result.
//
// POST /runner/control/threads/mark-all-for-reassess normally returns
// `{ ok: true, threadsMarked: N }`. But in the live presenter demo the
// dashboard installs a fetch interceptor (lib/full-demo-fetch.ts) that
// short-circuits every `/control/...` mutation and resolves with a
// read-only sentinel `{ ok: true, intercepted: true, action }` WITHOUT a
// `threadsMarked` field. The runner-side presenter-guard returns a 403
// (surfaced as a thrown ApiRequestError) when the interceptor is absent.
//
// Before this mapper, ReassessAllControl read `result.threadsMarked`
// straight into its success line and rendered "undefined active threads
// reset for reassessment" whenever the interceptor swallowed the call.
// This helper folds the three success-path shapes into an explicit
// outcome so the component can render an honest line:
//   - intercepted sentinel  -> read-only notice (no count)
//   - real numeric count     -> "<n> active threads reset…"
//   - anything else          -> generic done (never "undefined")
//
// Kept as a tiny dependency-free helper so the decision is unit-testable
// without jsdom, mirroring lib/reassess-status.ts.

export interface MarkAllReassessResponse {
  ok?: boolean;
  intercepted?: boolean;
  threadsMarked?: number;
}

export type ReassessAllOutcome =
  | { status: "intercepted"; count: null }
  | { status: "done"; count: number | null };

/**
 * Map a mark-all-for-reassess response to a render outcome.
 *
 * `intercepted: true` (the live-demo read-only sentinel) takes priority
 * over any count — a swallowed request never reset anything. A numeric
 * `threadsMarked` becomes a concrete count; any other shape resolves to a
 * countless "done" so the UI never prints `undefined`.
 */
export function interpretReassessAllResult(
  result: MarkAllReassessResponse | null | undefined
): ReassessAllOutcome {
  if (result?.intercepted) {
    return { status: "intercepted", count: null };
  }
  if (typeof result?.threadsMarked === "number") {
    return { status: "done", count: result.threadsMarked };
  }
  return { status: "done", count: null };
}
