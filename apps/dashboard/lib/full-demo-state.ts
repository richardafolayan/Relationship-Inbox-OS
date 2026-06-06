/**
 * localStorage helpers for the full-presenter-demo runtime state. The
 * server is the source of truth for "is presenter mode active" via
 * AppSettings.presenterDemoMode + presenterReadOnly — these client keys
 * persist the controller's step + autoplay state so a page navigation
 * doesn't reset the walkthrough.
 *
 * Keys are namespaced under "relationship-inbox-os:full-demo:" so
 * existing flat localStorage keys (linkedin_dashboard_autoscan_enabled,
 * inbox_quiet_hours, etc.) aren't disturbed.
 */

export const KEYS = {
  active: "relationship-inbox-os:full-demo:active",
  mode: "relationship-inbox-os:full-demo:mode",
  step: "relationship-inbox-os:full-demo:step",
  autoplay: "relationship-inbox-os:full-demo:autoplay",
  liveThreads: "relationship-inbox-os:full-demo:live-threads"
} as const;

export type FullDemoMode = "sandbox" | "live";

export interface FullDemoLocalState {
  active: boolean;
  mode: FullDemoMode | null;
  stepId: string | null;
  autoplay: boolean;
  liveThreadIds: string[];
}

function safeRead(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* swallow — quota / private-browsing */
  }
}

export function readFullDemoState(): FullDemoLocalState {
  const mode = safeRead(KEYS.mode);
  const liveRaw = safeRead(KEYS.liveThreads);
  let liveThreadIds: string[] = [];
  if (liveRaw) {
    try {
      const parsed = JSON.parse(liveRaw);
      if (Array.isArray(parsed)) {
        liveThreadIds = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      liveThreadIds = [];
    }
  }
  return {
    active: safeRead(KEYS.active) === "1",
    mode: mode === "sandbox" || mode === "live" ? mode : null,
    stepId: safeRead(KEYS.step),
    autoplay: safeRead(KEYS.autoplay) === "1",
    liveThreadIds
  };
}

export function writeFullDemoState(partial: Partial<FullDemoLocalState>): void {
  if ("active" in partial) safeWrite(KEYS.active, partial.active ? "1" : null);
  if ("mode" in partial) safeWrite(KEYS.mode, partial.mode ?? null);
  if ("stepId" in partial) safeWrite(KEYS.step, partial.stepId ?? null);
  if ("autoplay" in partial) safeWrite(KEYS.autoplay, partial.autoplay ? "1" : null);
  if ("liveThreadIds" in partial) {
    safeWrite(
      KEYS.liveThreads,
      partial.liveThreadIds && partial.liveThreadIds.length > 0
        ? JSON.stringify(partial.liveThreadIds)
        : null
    );
  }
}

export function clearFullDemoState(): void {
  safeWrite(KEYS.active, null);
  safeWrite(KEYS.mode, null);
  safeWrite(KEYS.step, null);
  safeWrite(KEYS.autoplay, null);
  safeWrite(KEYS.liveThreads, null);
}

/**
 * Build the platformThreadId → internal-id map the presenter/pilot flows use
 * to resolve script-referenced showcase threads to the runner's cuid. Rows
 * without a platformThreadId are skipped. Pure so the provider's refresh can be
 * unit-tested for content-stability (see threadIdMapsEqual).
 */
export function buildThreadIdMap(
  rows: ReadonlyArray<{ id: string; platformThreadId?: string | null }> | null | undefined
): Map<string, string> {
  const next = new Map<string, string>();
  for (const row of rows ?? []) {
    if (row.platformThreadId) next.set(row.platformThreadId, row.id);
  }
  return next;
}

/**
 * Content-equality for two threadId maps. Used to skip a setState (and the
 * re-render it triggers) when a refetch produced the same map. Without this,
 * a showcase thread that never seeds churns the route-change effect into an
 * unbounded /data/inbox refetch loop: each identical fetch replaces the map
 * with a new reference, re-running the effect, which refetches again.
 */
export function threadIdMapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}
