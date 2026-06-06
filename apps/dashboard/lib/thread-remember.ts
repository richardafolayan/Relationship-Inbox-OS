// Pure helpers for the thread "things to remember" section.
//
// Deliberately free of React / Next imports so the date logic can be
// unit-tested with the repo's `node --import tsx --test` runner (see
// tests/dashboard-thread-remember.test.mjs). The component in
// components/thread/ThingsToRemember.tsx is a thin renderer over these.

/**
 * A durable fact worth remembering about a contact — an exam, a trip, a life
 * event. Produced by the AI summary (Thread.rememberJson) and surfaced in the
 * thread context rail. Mirrors the runner's RememberItem in @inbox-os/core;
 * the runner -> dashboard contract is JSON, so the shape is declared on both
 * sides rather than imported across the boundary.
 */
export interface RememberItem {
  note: string;
  /** ISO YYYY-MM-DD, or null when no specific date is known. */
  date: string | null;
}

/** How soon a remember item's date is, relative to "now". */
export type RememberDateStatus = "past" | "today" | "soon" | "later" | "none";

/** An item with its computed status + a human label, ready to render. */
export interface PreparedRememberItem {
  note: string;
  /** Normalised ISO YYYY-MM-DD, or null when undated / unparseable. */
  date: string | null;
  status: RememberDateStatus;
  /** Human relative label ("tomorrow", "in 5 days", "12 Jun"). Empty when undated. */
  label: string;
}

// Items dated within this many days count as "soon" and get the upcoming
// emphasis. A fortnight is enough lead time to actually act on (send a
// good-luck note before an exam) without the section filling with distant
// noise.
export const REMEMBER_SOON_DAYS = 14;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse an ISO YYYY-MM-DD string into a Date at UTC midnight. Returns null for
 * anything that isn't a real calendar date in strict ISO form. The runner
 * already normalises dates before persisting, but a malformed value from an
 * older row must never throw the thread page.
 */
export function parseRememberDate(date: string | null | undefined): Date | null {
  if (typeof date !== "string") return null;
  const trimmed = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject values that don't round-trip (e.g. 2026-02-30 rolls to Mar 2).
  return parsed.toISOString().slice(0, 10) === trimmed ? parsed : null;
}

/**
 * Whole calendar days from `now` to `date`, counting day boundaries crossed
 * rather than 24h windows. Positive = future, 0 = today, negative = past.
 *
 * `date` is a remember date: UTC midnight of a bare calendar date (see
 * parseRememberDate), so its UTC day index *is* its calendar day. `now`,
 * however, is a wall-clock instant from the operator's machine, so it must be
 * reduced by the operator's LOCAL midnight — not UTC midnight. Flooring `now`
 * by UTC drifts a day for any non-UTC operator (e.g. an evening in the
 * Americas has already rolled to the next UTC day), which made today/tomorrow
 * items mislabel and silently drop out of the section.
 */
export function daysUntil(date: Date, now: Date): number {
  const nowLocalMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const nowDayIndex = Math.floor(
    (nowLocalMidnight.getTime() - nowLocalMidnight.getTimezoneOffset() * 60 * 1000) / DAY_MS
  );
  return Math.floor(date.getTime() / DAY_MS) - nowDayIndex;
}

/** Classify how soon a remember date is. Undated / unparseable -> "none". */
export function rememberDateStatus(
  date: string | null | undefined,
  now: Date
): RememberDateStatus {
  const parsed = parseRememberDate(date);
  if (!parsed) return "none";
  const delta = daysUntil(parsed, now);
  if (delta < 0) return "past";
  if (delta === 0) return "today";
  if (delta <= REMEMBER_SOON_DAYS) return "soon";
  return "later";
}

/**
 * Human relative label for a remember date. Near dates read naturally
 * ("today", "tomorrow", "in 5 days"); anything past a fortnight falls back to
 * an absolute "12 Jun" so the operator isn't counting weeks in their head.
 * Returns "" for an undated / unparseable item.
 */
export function describeRememberDate(date: string | null | undefined, now: Date): string {
  const parsed = parseRememberDate(date);
  if (!parsed) return "";
  const delta = daysUntil(parsed, now);
  if (delta < 0) return delta === -1 ? "yesterday" : `${Math.abs(delta)} days ago`;
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta <= REMEMBER_SOON_DAYS) return `in ${delta} days`;
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]}`;
}

/**
 * Filter + sort raw remember items for display. Past-dated events are dropped
 * — they're no longer "upcoming", and the AI is asked to drop them too, so
 * this is the belt-and-braces UI guard. Items missing a usable note are
 * skipped. Dated items sort soonest-first; undated items fall to the end with
 * their original order preserved.
 */
export function prepareRememberItems(
  items: RememberItem[] | null | undefined,
  now: Date
): PreparedRememberItem[] {
  if (!Array.isArray(items)) return [];

  const prepared = items
    .filter(
      (item): item is RememberItem =>
        Boolean(item) && typeof item.note === "string" && item.note.trim().length > 0
    )
    .map((item) => {
      const parsed = parseRememberDate(item.date);
      const isoDate = parsed ? parsed.toISOString().slice(0, 10) : null;
      return {
        note: item.note.trim(),
        date: isoDate,
        status: rememberDateStatus(isoDate, now),
        label: describeRememberDate(isoDate, now)
      };
    })
    .filter((item) => item.status !== "past");

  return prepared.sort((a, b) => {
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    return 0;
  });
}
