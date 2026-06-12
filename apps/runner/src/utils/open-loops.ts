import { safeJsonParse } from "./json";

/**
 * Filter a thread's open-loop bullets by the operator-dismissed set stored
 * on `dismissedOpenLoopsJson`.
 *
 * `dismissedJson` is the raw JSON column value (or null). It is parsed with
 * {@link safeJsonParse}, not bare `JSON.parse`, because this runs inside the
 * `/data/thread/:threadId` read path: a single corrupt/truncated column
 * (partial write, manual edit) would otherwise throw out of the route and
 * 500 the whole thread response. A malformed value degrades to "nothing
 * dismissed" (all loops shown) rather than blocking the thread from opening.
 */
export function filterDismissedOpenLoops(
  loops: string[],
  dismissedJson: string | null
): string[] {
  if (!dismissedJson) return loops;
  const dismissed = new Set(safeJsonParse<string[]>(dismissedJson, []));
  return loops.filter((loop) => !dismissed.has(loop));
}
