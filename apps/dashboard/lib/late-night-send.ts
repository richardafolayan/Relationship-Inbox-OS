// Late-night LinkedIn send nudge.
//
// When the operator is drafting a LinkedIn reply during the quiet window
// (22:00 to 06:00 local), firing it off straight away lands a professional
// ping at an odd hour. So the composer surfaces one subtle, one-click line
// that schedules the current draft for the next 08:00 local instead, reusing
// the existing scheduled-send path. The whole thing is opt-in: it only ever
// appears while a LinkedIn draft is open late at night, and a single click
// schedules it (reversible via the normal scheduled-send pill).
//
// Scope notes:
//   - LinkedIn only. iMessage is excluded (a late personal text is normal),
//     and Instagram / TikTok are out of scope for now. Widening later is a
//     one-line change to LATE_NIGHT_NUDGE_PLATFORMS plus a test.
//   - The window check uses the fixed default quiet window (22:00-06:00),
//     not the operator's custom quiet-hours times. Those times mute the
//     operator's own scans and notifications; this nudge is about the hour
//     the *recipient* would receive the message.

import { DEFAULT_QUIET_HOURS_WINDOW, isWithinQuietWindow } from "./quiet-hours";

// Platforms where a late-night message reads badly and the nudge applies.
const LATE_NIGHT_NUDGE_PLATFORMS = new Set<string>(["LINKEDIN"]);

// The local hour the nudge schedules toward.
const MORNING_HOUR = 8;

export function isLateNightSchedulePlatform(platform: string): boolean {
  return LATE_NIGHT_NUDGE_PLATFORMS.has(platform);
}

// The next local 08:00 strictly after `now`:
//   22:00 to 23:59 -> tomorrow 08:00
//   00:00 to 05:59 -> today 08:00
// Inside the quiet window it is always still before 08:00 on the relevant
// day, so "strictly after now" resolves to the right morning with no special
// casing of the date. Defined for any time of day so it is safe to call even
// when the nudge is not shown.
export function nextMorningSendSlot(now: Date = new Date()): Date {
  const slot = new Date(now);
  slot.setHours(MORNING_HOUR, 0, 0, 0);
  if (slot.getTime() <= now.getTime()) {
    slot.setDate(slot.getDate() + 1);
  }
  return slot;
}

// Whether the subtle "schedule for 8 AM" nudge should be offered. This is the
// pure eligibility signal only (platform + non-empty draft + inside the quiet
// window). Transient send / schedule-in-flight state is handled by the
// caller's disabled styling, not here, so this stays trivial to unit-test.
export function shouldOfferLateNightSchedule(input: {
  platform: string;
  hasDraft: boolean;
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  return (
    input.hasDraft &&
    isLateNightSchedulePlatform(input.platform) &&
    isWithinQuietWindow(now, DEFAULT_QUIET_HOURS_WINDOW)
  );
}
