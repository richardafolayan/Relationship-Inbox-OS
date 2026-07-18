// Quiet hours mute the sidebar attention dot and pause the dashboard's
// background auto-scan tick when the toggle is on AND local time is inside
// the configured window. Defaults: 22:00 inclusive to 06:00 exclusive.
//
// Host behaviour (Mac scanning) is stored in runner AppSettings so a phone
// on a Tailscale origin and the Mac desktop origin share one value. Browser
// localStorage remains a dual-read / dual-write bridge for brief migration.

export const QUIET_HOURS_KEY = "inbox_quiet_hours";
export const QUIET_HOURS_WINDOW_KEY = "inbox_quiet_hours_window";
export const QUIET_HOURS_CHANGE_EVENT = "quiet-hours-change";

export const DEFAULT_QUIET_START = "22:00";
export const DEFAULT_QUIET_END = "06:00";

export interface QuietHoursWindow {
  /** Local HH:MM, inclusive. */
  start: string;
  /** Local HH:MM, exclusive. */
  end: string;
}

export const DEFAULT_QUIET_HOURS_WINDOW: QuietHoursWindow = {
  start: DEFAULT_QUIET_START,
  end: DEFAULT_QUIET_END
};

export type QuietHoursSource = "runner" | "local" | "default";

export interface QuietHoursHostState {
  enabled: boolean;
  window: QuietHoursWindow;
  source: QuietHoursSource;
}

/** Runner AppSettings fields used for quiet hours (optional for old rows). */
export interface QuietHoursRunnerSettings {
  quietHoursEnabled?: boolean;
  quietHoursWindow?: QuietHoursWindow | null;
}

function browserLocalStorage(): Storage | null {
  if (typeof globalThis === "undefined") return null;
  const g = globalThis as { window?: { localStorage?: Storage } };
  return g.window?.localStorage ?? null;
}

function isStorageLike(value: unknown): value is Pick<Storage, "getItem"> {
  return Boolean(value && typeof value === "object" && "getItem" in value);
}

/** Parse "HH:MM" or "H:MM" into minutes from midnight. Returns null if invalid. */
export function parseTimeToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Format minutes from midnight as zero-padded HH:MM. */
export function formatMinutesAsTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Normalise a stored or user-entered time string to HH:MM, or null. */
export function normaliseQuietTime(value: string): string | null {
  const minutes = parseTimeToMinutes(value);
  if (minutes === null) return null;
  return formatMinutesAsTime(minutes);
}

export function normaliseQuietHoursWindow(
  quietWindow: Partial<QuietHoursWindow> | null | undefined
): QuietHoursWindow {
  const start =
    typeof quietWindow?.start === "string" ? normaliseQuietTime(quietWindow.start) : null;
  const end = typeof quietWindow?.end === "string" ? normaliseQuietTime(quietWindow.end) : null;
  if (!start || !end || start === end) return { ...DEFAULT_QUIET_HOURS_WINDOW };
  return { start, end };
}

export function formatQuietHoursRange(
  quietWindow: QuietHoursWindow = DEFAULT_QUIET_HOURS_WINDOW
): string {
  const start = normaliseQuietTime(quietWindow.start) ?? DEFAULT_QUIET_START;
  const end = normaliseQuietTime(quietWindow.end) ?? DEFAULT_QUIET_END;
  return `${start} to ${end}`;
}

export function isQuietHoursEnabled(
  storage: Pick<Storage, "getItem"> | null | undefined = browserLocalStorage()
): boolean {
  if (!storage) return false;
  return storage.getItem(QUIET_HOURS_KEY) === "1";
}

export function writeQuietHoursEnabled(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> | null | undefined = browserLocalStorage()
): void {
  if (!storage) return;
  storage.setItem(QUIET_HOURS_KEY, enabled ? "1" : "0");
}

export function readQuietHoursWindow(
  storage: Pick<Storage, "getItem"> | null | undefined = browserLocalStorage()
): QuietHoursWindow {
  if (!storage) return { ...DEFAULT_QUIET_HOURS_WINDOW };
  const raw = storage.getItem(QUIET_HOURS_WINDOW_KEY);
  if (!raw) return { ...DEFAULT_QUIET_HOURS_WINDOW };
  try {
    const parsed = JSON.parse(raw) as Partial<QuietHoursWindow>;
    return normaliseQuietHoursWindow(parsed);
  } catch {
    return { ...DEFAULT_QUIET_HOURS_WINDOW };
  }
}

export function writeQuietHoursWindow(
  quietWindow: QuietHoursWindow,
  storage: Pick<Storage, "setItem"> | null | undefined = browserLocalStorage()
): QuietHoursWindow {
  const next = normaliseQuietHoursWindow(quietWindow);
  if (storage) {
    storage.setItem(QUIET_HOURS_WINDOW_KEY, JSON.stringify(next));
  }
  return next;
}

/**
 * True when local time is inside the quiet window.
 * Overnight windows (start later than end, e.g. 22:00 to 06:00) wrap midnight.
 * Same-day windows (start earlier than end) do not wrap.
 */
export function isWithinQuietWindow(
  now: Date = new Date(),
  quietWindow: QuietHoursWindow = DEFAULT_QUIET_HOURS_WINDOW
): boolean {
  const start = parseTimeToMinutes(quietWindow.start);
  const end = parseTimeToMinutes(quietWindow.end);
  if (start === null || end === null || start === end) {
    const fallbackStart = parseTimeToMinutes(DEFAULT_QUIET_START)!;
    const fallbackEnd = parseTimeToMinutes(DEFAULT_QUIET_END)!;
    return isMinutesInWindow(now.getHours() * 60 + now.getMinutes(), fallbackStart, fallbackEnd);
  }
  return isMinutesInWindow(now.getHours() * 60 + now.getMinutes(), start, end);
}

function isMinutesInWindow(current: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) {
    // Same calendar day, e.g. 13:00 to 17:00.
    return current >= start && current < end;
  }
  // Overnight, e.g. 22:00 to 06:00.
  return current >= start || current < end;
}

// --- Shared host state (runner-backed) ------------------------------------

let hostState: QuietHoursHostState | null = null;

function readLocalHostFallback(
  storage: Pick<Storage, "getItem"> | null | undefined = browserLocalStorage()
): QuietHoursHostState {
  if (!storage) {
    return {
      enabled: false,
      window: { ...DEFAULT_QUIET_HOURS_WINDOW },
      source: "default"
    };
  }
  return {
    enabled: isQuietHoursEnabled(storage),
    window: readQuietHoursWindow(storage),
    source: "local"
  };
}

function emitQuietHoursChange(state: QuietHoursHostState): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent(QUIET_HOURS_CHANGE_EVENT, {
        detail: { enabled: state.enabled, window: state.window, source: state.source }
      })
    );
  } catch {
    // CustomEvent may be unavailable in some test hosts.
  }
}

/** Current quiet hours used by AppShell scan/notify paths. */
export function getQuietHoursHostState(
  storage: Pick<Storage, "getItem"> | null | undefined = browserLocalStorage()
): QuietHoursHostState {
  if (hostState) return hostState;
  return readLocalHostFallback(storage);
}

/**
 * Apply runner AppSettings quiet-hours fields. When the runner has never
 * stored them (undefined), dual-read localStorage so Mac clients keep working
 * until the first settings save migrates the value.
 */
export function applyQuietHoursFromRunner(
  settings: QuietHoursRunnerSettings | null | undefined,
  storage: Pick<Storage, "getItem"> | null | undefined = browserLocalStorage()
): QuietHoursHostState {
  if (settings && typeof settings.quietHoursEnabled === "boolean") {
    hostState = {
      enabled: settings.quietHoursEnabled,
      window: normaliseQuietHoursWindow(settings.quietHoursWindow ?? undefined),
      source: "runner"
    };
    return hostState;
  }
  hostState = readLocalHostFallback(storage);
  return hostState;
}

/**
 * Update shared host state after a settings toggle/window edit.
 * Dual-writes localStorage so a mid-session fallback still matches.
 */
export function setQuietHoursHostState(
  next: { enabled: boolean; window?: QuietHoursWindow },
  storage: Pick<Storage, "getItem" | "setItem"> | null | undefined = browserLocalStorage()
): QuietHoursHostState {
  const window = normaliseQuietHoursWindow(next.window ?? hostState?.window);
  hostState = {
    enabled: Boolean(next.enabled),
    window,
    source: "runner"
  };
  if (storage && "setItem" in storage) {
    writeQuietHoursEnabled(hostState.enabled, storage);
    writeQuietHoursWindow(hostState.window, storage);
  }
  emitQuietHoursChange(hostState);
  return hostState;
}

/** True when local values exist that should be migrated into runner settings. */
export function shouldMigrateLocalQuietHours(
  settings: QuietHoursRunnerSettings | null | undefined,
  storage: Pick<Storage, "getItem"> | null | undefined = browserLocalStorage()
): boolean {
  if (settings && typeof settings.quietHoursEnabled === "boolean") return false;
  if (!storage) return false;
  if (isQuietHoursEnabled(storage)) return true;
  const window = readQuietHoursWindow(storage);
  const raw = storage.getItem(QUIET_HOURS_WINDOW_KEY);
  if (!raw) return false;
  return (
    window.start !== DEFAULT_QUIET_HOURS_WINDOW.start ||
    window.end !== DEFAULT_QUIET_HOURS_WINDOW.end
  );
}

export function quietHoursPayloadForRunner(state: QuietHoursHostState): {
  quietHoursEnabled: boolean;
  quietHoursWindow: QuietHoursWindow;
} {
  return {
    quietHoursEnabled: state.enabled,
    quietHoursWindow: { ...state.window }
  };
}

/**
 * Active when the toggle is on and local time is inside the window.
 * Second argument may be localStorage (legacy/tests) or an explicit host state.
 * With no second argument, uses the shared host state (runner-backed).
 */
export function isQuietHoursActive(
  now: Date = new Date(),
  source?: Pick<Storage, "getItem"> | QuietHoursHostState | null
): boolean {
  if (isStorageLike(source)) {
    return isQuietHoursEnabled(source) && isWithinQuietWindow(now, readQuietHoursWindow(source));
  }
  const state = source ?? getQuietHoursHostState();
  return state.enabled && isWithinQuietWindow(now, state.window);
}

/** Pure scan-gate helper: phone-written runner state pauses Mac auto-scan. */
export function shouldSkipAutoScanForQuietHours(
  now: Date = new Date(),
  state: QuietHoursHostState = getQuietHoursHostState()
): boolean {
  return isQuietHoursActive(now, state);
}

/** Test helper: clear module host cache between cases. */
export function resetQuietHoursHostStateForTests(): void {
  hostState = null;
}

export const QUIET_HOURS_LABEL = `${DEFAULT_QUIET_START} - ${DEFAULT_QUIET_END} local`;
