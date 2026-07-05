"use client";

// Pilot R-0087 (#754): the auto-scan cadence is adjustable. The shell's
// scan loop used a hard-coded 8-13 minute jitter window (a randomised "every
// 10 min"); Richard wants to be able to slow that to half-hourly, hourly, or
// once a day.
//
// The jitter itself is load-bearing: a perfectly periodic scan is one of the
// strongest behavioural fingerprints the LinkedIn session produces, so every
// cadence keeps the same proportional spread the 10-minute default always
// had (base x 0.8 .. base x 1.3 - the historical 8-13 min window is exactly
// 10 min x [0.8, 1.3]).
//
// Like the auto-scan on/off toggle, the choice lives in localStorage: it is
// a per-browser dashboard behaviour (the dashboard drives the scan loop),
// not runner state.

export type ScanIntervalId = "10m" | "30m" | "1h" | "1d";

export const SCAN_INTERVAL_STORAGE_KEY = "inbox_auto_scan_interval_v1";
// Same-tab change fan-out (the storage event only fires in OTHER tabs).
export const SCAN_INTERVAL_CHANGE_EVENT = "inbox-scan-interval";
export const DEFAULT_SCAN_INTERVAL: ScanIntervalId = "10m";

const BASE_MS: Record<ScanIntervalId, number> = {
  "10m": 10 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
};

// Pill labels for Settings; captions for the auto-scan row's state line.
export const SCAN_INTERVAL_OPTIONS: Array<{ id: ScanIntervalId; label: string; caption: string }> = [
  { id: "10m", label: "Every 10 min", caption: "every 10 min" },
  { id: "30m", label: "Every 30 min", caption: "every 30 min" },
  { id: "1h", label: "Hourly", caption: "hourly" },
  { id: "1d", label: "Once a day", caption: "daily" }
];

export function scanIntervalCaption(id: ScanIntervalId): string {
  return SCAN_INTERVAL_OPTIONS.find((option) => option.id === id)?.caption ?? "every 10 min";
}

export function parseScanInterval(raw: string | null | undefined): ScanIntervalId {
  return raw === "30m" || raw === "1h" || raw === "1d" || raw === "10m"
    ? raw
    : DEFAULT_SCAN_INTERVAL;
}

export function scanIntervalWindowMs(id: ScanIntervalId): { min: number; max: number } {
  const base = BASE_MS[id] ?? BASE_MS[DEFAULT_SCAN_INTERVAL];
  return { min: Math.round(base * 0.8), max: Math.round(base * 1.3) };
}

/**
 * The delay until the next scan attempt. `skipped` = the tick that just ran
 * did NOT scan (mid-scan, quiet hours, outside active hours): retry on the
 * short 10-minute window regardless of the configured cadence, otherwise a
 * daily scan whose timer happens to land at night would starve for days -
 * the active-hours/quiet-hours gates still decide whether the retry actually
 * scans, so the configured cadence only ever stretches, never tightens.
 */
export function nextScanDelayMs(
  id: ScanIntervalId,
  options?: { skipped?: boolean; random?: () => number }
): number {
  const window = scanIntervalWindowMs(options?.skipped ? DEFAULT_SCAN_INTERVAL : id);
  const random = options?.random ?? Math.random;
  return Math.floor(random() * (window.max - window.min + 1)) + window.min;
}

export function readScanInterval(): ScanIntervalId {
  if (typeof window === "undefined") return DEFAULT_SCAN_INTERVAL;
  try {
    return parseScanInterval(window.localStorage.getItem(SCAN_INTERVAL_STORAGE_KEY));
  } catch {
    return DEFAULT_SCAN_INTERVAL;
  }
}

export function writeScanInterval(id: ScanIntervalId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SCAN_INTERVAL_STORAGE_KEY, id);
  } catch {
    // Privacy mode: the loop keeps its default; Settings shows unsaved.
  }
  window.dispatchEvent(new CustomEvent(SCAN_INTERVAL_CHANGE_EVENT));
}

// Re-render/re-arm hook: same-tab custom event + sibling-tab storage event.
export function onScanIntervalChange(handler: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SCAN_INTERVAL_STORAGE_KEY) handler();
  };
  window.addEventListener(SCAN_INTERVAL_CHANGE_EVENT, handler);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SCAN_INTERVAL_CHANGE_EVENT, handler);
    window.removeEventListener("storage", onStorage);
  };
}
