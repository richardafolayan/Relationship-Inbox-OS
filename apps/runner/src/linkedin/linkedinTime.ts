const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
};

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function buildDate(year: number, monthIndex: number, day: number, hour = 12, minute = 0): Date {
  return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

/**
 * Parse a LinkedIn list-row timestamp like "8:01 AM", "Yesterday", "Wed",
 * "Feb 19", or "Feb 19, 2026". Time-only inputs default to today; if today's
 * computed time is in the future relative to `now`, falls back to yesterday.
 */
export function parseLinkedInListTimestamp(text: string, now: Date): Date | null {
  const normalized = clean(text);
  if (!normalized || normalized === "-") {
    return null;
  }

  const lowered = normalized.toLowerCase();
  if (lowered === "yesterday") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0, 0);
  }
  if (lowered === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    const parsedIso = new Date(normalized);
    return Number.isNaN(parsedIso.getTime()) ? null : parsedIso;
  }

  const timeMatch = normalized.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (timeMatch) {
    const [, rawHour, rawMinute, meridiem] = timeMatch;
    let hour = Number(rawHour) % 12;
    if ((meridiem ?? "").toUpperCase() === "PM") {
      hour += 12;
    }
    const minute = Number(rawMinute);
    const candidate = buildDate(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    if (candidate.getTime() > now.getTime()) {
      return buildDate(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute);
    }
    return candidate;
  }

  // 24-hour time, e.g. "19:16" — same logic as 12-hour with meridiem.
  const time24Match = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (time24Match) {
    const [, rawHour, rawMinute] = time24Match;
    const hour = Number(rawHour);
    const minute = Number(rawMinute);
    if (hour <= 23 && minute <= 59) {
      const candidate = buildDate(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
      if (candidate.getTime() > now.getTime()) {
        return buildDate(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute);
      }
      return candidate;
    }
  }

  // Weekday name, e.g. "Wed", "Saturday". Resolve to most recent past
  // occurrence of that weekday relative to `now` (today inclusive).
  const weekdayIndex = WEEKDAYS[lowered];
  if (typeof weekdayIndex === "number") {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    let diff = today.getDay() - weekdayIndex;
    if (diff < 0) {
      diff += 7;
    }
    today.setDate(today.getDate() - diff);
    return today;
  }

  const monthDayYearMatch = normalized.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (monthDayYearMatch) {
    const [, monthName, rawDay, rawYear] = monthDayYearMatch;
    const monthIndex = MONTHS[(monthName ?? "").toLowerCase()];
    if (typeof monthIndex !== "number") {
      return null;
    }
    return buildDate(Number(rawYear), monthIndex, Number(rawDay));
  }

  const monthDayMatch = normalized.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  if (monthDayMatch) {
    const [, monthName, rawDay] = monthDayMatch;
    const monthIndex = MONTHS[(monthName ?? "").toLowerCase()];
    if (typeof monthIndex !== "number") {
      return null;
    }
    const day = Number(rawDay);
    let year = now.getFullYear();
    let candidate = buildDate(year, monthIndex, day);
    if (candidate.getTime() > now.getTime()) {
      year -= 1;
      candidate = buildDate(year, monthIndex, day);
    }
    return candidate;
  }

  return null;
}

/**
 * Combine a per-message time-of-day ("4:52 PM" or "19:16") with a date
 * heading from the message-list group ("Feb 20", "Mar 28", "Saturday",
 * "Today", "Yesterday"). Returns the full ISO datetime, or null if either
 * input is unparseable.
 *
 * LinkedIn's message DOM stores the date once per group as a
 * `<time class="msg-s-message-list__time-heading">` and only the time on
 * each individual message bubble. Without this combination the parser was
 * defaulting every message to today + the bubble's time-of-day, producing
 * `lastMessageAt` values months in the future of the actual message date.
 */
export function parseLinkedInMessageTimestamp(
  timeOfDayText: string | null | undefined,
  dateHeaderText: string | null | undefined,
  now: Date
): Date | null {
  const timeText = clean(timeOfDayText ?? "");
  const dateText = clean(dateHeaderText ?? "");

  // If there's no time-of-day, we can still anchor to the date header (noon).
  if (!timeText) {
    return dateText ? parseLinkedInListTimestamp(dateText, now) : null;
  }

  // Parse the time-of-day portion.
  let hour: number | null = null;
  let minute: number | null = null;
  const ampm = timeText.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (ampm) {
    const [, rawHour, rawMinute, meridiem] = ampm;
    hour = Number(rawHour) % 12;
    if ((meridiem ?? "").toUpperCase() === "PM") {
      hour += 12;
    }
    minute = Number(rawMinute);
  } else {
    const m24 = timeText.match(/^(\d{1,2}):(\d{2})$/);
    if (m24) {
      const h = Number(m24[1]);
      const mn = Number(m24[2]);
      if (h <= 23 && mn <= 59) {
        hour = h;
        minute = mn;
      }
    }
  }
  if (hour === null || minute === null) {
    // Time text didn't parse — fall back to date-only.
    return dateText ? parseLinkedInListTimestamp(dateText, now) : null;
  }

  // No date heading → use today + time-of-day (existing behaviour).
  if (!dateText) {
    const candidate = buildDate(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    if (candidate.getTime() > now.getTime()) {
      return buildDate(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, minute);
    }
    return candidate;
  }

  // Resolve the date heading to a calendar day, then layer the time onto it.
  const dayAnchor = parseLinkedInListTimestamp(dateText, now);
  if (!dayAnchor) {
    return null;
  }
  return buildDate(dayAnchor.getFullYear(), dayAnchor.getMonth(), dayAnchor.getDate(), hour, minute);
}
