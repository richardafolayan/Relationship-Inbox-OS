/**
 * Shared birthday helpers used by the runner (to build the upcoming-
 * birthdays feed) and the dashboard (to label birthday badges and cards).
 * Birthdays live on Person.birthday as a zero-padded "MM-DD" string, with
 * the year, when known, on Person.birthYear.
 */

/** How many days ahead the dashboard surfaces an upcoming birthday. */
export const BIRTHDAY_HORIZON_DAYS = 14;

function parseMonthDay(monthDay: string | null | undefined): { month: number; day: number } | null {
  if (!monthDay) return null;
  const match = /^(\d{2})-(\d{2})$/.exec(monthDay.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

/**
 * The next calendar date (at local midnight) on which a "MM-DD" birthday
 * falls. If this year's date has already passed, returns next year's. A
 * 29 Feb birthday rolls forward to 1 Mar in non-leap years via JavaScript's
 * Date normalization, matching the common "celebrate on the 1st" convention.
 */
function nextBirthdayDate(month: number, day: number, now: Date): Date {
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thisYear = new Date(now.getFullYear(), month - 1, day);
  return thisYear.getTime() < todayMidnight.getTime()
    ? new Date(now.getFullYear() + 1, month - 1, day)
    : thisYear;
}

/**
 * Whole days from `now` until the next occurrence of a "MM-DD" birthday.
 * 0 means the birthday is today, 1 tomorrow, and so on. Returns null when
 * the input is missing or malformed. The comparison runs at local-midnight
 * day granularity so a birthday today reads as 0 regardless of the time.
 */
export function daysUntilBirthday(
  monthDay: string | null | undefined,
  now: Date = new Date()
): number | null {
  const parsed = parseMonthDay(monthDay);
  if (!parsed) return null;
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const next = nextBirthdayDate(parsed.month, parsed.day, now);
  // Round rather than floor: a day boundary that crosses a DST change spans
  // 23 or 25 hours, and rounding keeps the result on whole days.
  return Math.round((next.getTime() - todayMidnight.getTime()) / 86_400_000);
}

/**
 * Human label for a day count from `daysUntilBirthday`: "today", "tomorrow",
 * or "in N days". Zero or negative counts collapse to "today".
 */
export function birthdayCountdownLabel(daysUntil: number): string {
  if (daysUntil <= 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil} days`;
}

/**
 * Age the contact reaches on their next birthday, or null when the birth
 * year is unknown (year-less contact cards) or the data looks implausible.
 * Lets birthday surfaces show "turns 30" where the year is available.
 */
export function ageOnNextBirthday(
  birthYear: number | null | undefined,
  monthDay: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!birthYear) return null;
  const parsed = parseMonthDay(monthDay);
  if (!parsed) return null;
  const next = nextBirthdayDate(parsed.month, parsed.day, now);
  const age = next.getFullYear() - birthYear;
  return age > 0 && age < 150 ? age : null;
}
