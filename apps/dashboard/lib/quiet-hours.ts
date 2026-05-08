// Quiet hours = 22:00 to 06:00 local time. When the operator has the
// toggle on AND the current local hour is inside that window, we:
//   - mute the sidebar attention dot
//   - skip the dashboard's background auto-scan tick
// The toggle without the window only buried the dot 24/7, which the
// operator (rightly) called out as pointless — see issue #94.

const QUIET_HOURS_KEY = "inbox_quiet_hours";
const START_HOUR = 22; // 22:00 inclusive
const END_HOUR = 6; // 06:00 exclusive

export function isQuietHoursEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(QUIET_HOURS_KEY) === "1";
}

export function isWithinQuietWindow(now: Date = new Date()): boolean {
  const hour = now.getHours();
  return hour >= START_HOUR || hour < END_HOUR;
}

export function isQuietHoursActive(now: Date = new Date()): boolean {
  return isQuietHoursEnabled() && isWithinQuietWindow(now);
}

export const QUIET_HOURS_LABEL = "22:00 – 06:00 local";
