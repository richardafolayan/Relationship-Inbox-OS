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
