// Quiet hours mute the sidebar attention dot and pause the dashboard's
// background auto-scan tick when the toggle is on AND local time is inside
// the configured window. Defaults: 22:00 inclusive to 06:00 exclusive.
// The toggle without a window only buried the dot 24/7, which the operator
// (rightly) called out as pointless - see issue #94.

export const QUIET_HOURS_KEY = "inbox_quiet_hours";
export const QUIET_HOURS_WINDOW_KEY = "inbox_quiet_hours_window";

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

function browserLocalStorage(): Storage | null {
  if (typeof globalThis === "undefined") return null;
  const g = globalThis as { window?: { localStorage?: Storage } };
  return g.window?.localStorage ?? null;
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
    const start = typeof parsed.start === "string" ? normaliseQuietTime(parsed.start) : null;
    const end = typeof parsed.end === "string" ? normaliseQuietTime(parsed.end) : null;
    if (!start || !end || start === end) return { ...DEFAULT_QUIET_HOURS_WINDOW };
    return { start, end };
  } catch {
    return { ...DEFAULT_QUIET_HOURS_WINDOW };
  }
}

export function writeQuietHoursWindow(
  quietWindow: QuietHoursWindow,
  storage: Pick<Storage, "setItem"> | null | undefined = browserLocalStorage()
): QuietHoursWindow {
  const start = normaliseQuietTime(quietWindow.start) ?? DEFAULT_QUIET_START;
  const end = normaliseQuietTime(quietWindow.end) ?? DEFAULT_QUIET_END;
  const next =
    start === end
      ? { ...DEFAULT_QUIET_HOURS_WINDOW }
      : { start, end };
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
  quietWindow: QuietHoursWindow = browserLocalStorage()
    ? readQuietHoursWindow()
    : DEFAULT_QUIET_HOURS_WINDOW
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

export function isQuietHoursActive(
  now: Date = new Date(),
  storage: Pick<Storage, "getItem"> | null | undefined = browserLocalStorage()
): boolean {
  return isQuietHoursEnabled(storage) && isWithinQuietWindow(now, readQuietHoursWindow(storage));
}

export const QUIET_HOURS_LABEL = `${DEFAULT_QUIET_START} - ${DEFAULT_QUIET_END} local`;
