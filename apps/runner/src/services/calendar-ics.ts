import ICAL from "ical.js";

// ICS (iCalendar) parsing for calendar auto-focus (issue #786).
//
// The operator pastes the read-only "secret address in iCal format" URL that
// Google / Apple / Outlook calendars expose. The runner fetches that feed
// (see calendar-fetch.ts) and this module answers one question from the raw
// text: "is a real, busy, timed event happening right now — and what is the
// next one?". The calendar-focus service turns a live event into a Focus
// window; the Settings "check calendar" button uses the same summary to show
// the operator their connection works.
//
// Recurrence, timezones, EXDATE and modified occurrences are handled by
// ical.js (a maintained, dependency-free library) rather than a hand-rolled
// parser — DST, RECURRENCE-ID overrides and VTIMEZONE make that too risky to
// reimplement.
//
// This module is framework-free (ical.js only) so the test suite can import it
// without dragging in the runner's db/session wiring.

/** A single concrete event occurrence resolved to absolute epoch millis. */
export interface IcsOccurrence {
  /** Stable, short id for THIS occurrence (uid + start). Used as the focus
   *  window's sourceEventKey so an auto-window can be dismissed per event. */
  key: string;
  /** The event's UID (may repeat across occurrences of a recurring event). */
  uid: string;
  /** SUMMARY, trimmed. "" when the event has no title. */
  title: string;
  /** Occurrence start, epoch millis. */
  startMs: number;
  /** Occurrence end, epoch millis. */
  endMs: number;
}

export interface CalendarSummary {
  /** The event covering `now` (start <= now < end), or null. When several
   *  overlap, the one that STARTED most recently wins (that is "what you are
   *  in right now"); ties break on the later end. */
  active: IcsOccurrence | null;
  /** The soonest event starting after `now`, or null. Powers the Settings
   *  preview ("next: Deep work at 2pm") — not used to open windows. */
  next: IcsOccurrence | null;
}

export interface SummarizeOptions {
  now?: Date;
  /** Case-insensitive SUMMARY filter. "" / undefined = every busy timed event. */
  keyword?: string;
  /** How far ahead to look for `next`. Defaults to 366 days. */
  horizonMs?: number;
}

// Hard caps so a pathological feed (FREQ=SECONDLY, a decade-old daily event)
// can never spin the tick. A daily event a few years old is well under this.
const MAX_OCCURRENCES_PER_EVENT = 5000;
const DEFAULT_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

/** FNV-1a hash → short base36 id, so a long UID + timestamp still fits the
 *  focus window's 80-char id budget while staying unique per occurrence. */
function occurrenceKey(uid: string, startMs: number): string {
  const input = `${uid}|${startMs}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `cal_${(hash >>> 0).toString(36)}`;
}

/**
 * Static per-event filters that don't depend on which occurrence we're on:
 * all-day events, free/transparent time, cancelled events, and the optional
 * keyword match. `event` may be the master or a modified (RECURRENCE-ID)
 * occurrence, so an override that cancels or renames a single instance is
 * respected.
 */
function eventPasses(event: ICAL.Event, keywordLower: string): boolean {
  // All-day events (DTSTART;VALUE=DATE) would hold focus on for the whole day.
  if (event.startDate?.isDate) return false;
  const component = event.component;
  const status = String(component.getFirstPropertyValue("status") ?? "").toUpperCase();
  if (status === "CANCELLED") return false;
  const transp = String(component.getFirstPropertyValue("transp") ?? "").toUpperCase();
  if (transp === "TRANSPARENT") return false; // marked "free", not "busy"
  if (keywordLower) {
    const summary = String(event.summary ?? "").toLowerCase();
    if (!summary.includes(keywordLower)) return false;
  }
  return true;
}

function toOccurrence(uid: string, title: string, startMs: number, endMs: number): IcsOccurrence {
  return { key: occurrenceKey(uid, startMs), uid, title: (title ?? "").trim(), startMs, endMs };
}

/**
 * Group VEVENTs into recurrence masters and their RECURRENCE-ID exceptions,
 * relate the exceptions to their master (so ical.js applies modified/cancelled
 * instances during expansion), and return the list of master events plus any
 * orphan exceptions (which we treat as one-offs).
 */
function collectEvents(root: ICAL.Component): ICAL.Event[] {
  const vevents = root.getAllSubcomponents("vevent");
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const comp of vevents) {
    const hasRecurrenceId = !!comp.getFirstProperty("recurrence-id");
    const event = new ICAL.Event(comp);
    if (hasRecurrenceId) {
      exceptions.push(event);
    } else {
      const uid = String(comp.getFirstPropertyValue("uid") ?? "");
      // Last master wins on duplicate UID (rare); good enough for a read feed.
      masters.set(uid || `__anon_${masters.size}`, event);
    }
  }
  for (const exception of exceptions) {
    const master = masters.get(exception.uid);
    if (master && master.isRecurring()) {
      try {
        master.relateException(exception);
      } catch {
        // A malformed exception shouldn't sink the whole feed.
      }
    }
  }
  // Orphan exceptions (no surviving master) still describe a real one-off slot.
  const orphanExceptions = exceptions.filter((ex) => !masters.has(ex.uid));
  return [...masters.values(), ...orphanExceptions];
}

/** Walk one event's occurrences within [now, now+horizon], updating the running
 *  active/next picks. Non-recurring events contribute a single occurrence. */
function scanEvent(
  event: ICAL.Event,
  nowMs: number,
  horizonEndMs: number,
  keywordLower: string,
  picks: { active: IcsOccurrence | null; next: IcsOccurrence | null }
): void {
  if (!event.isRecurring()) {
    if (!eventPasses(event, keywordLower)) return;
    const start = event.startDate?.toJSDate();
    const end = event.endDate?.toJSDate();
    if (!start || !end) return;
    consider(
      toOccurrence(event.uid, event.summary ?? "", start.getTime(), end.getTime()),
      nowMs,
      picks
    );
    return;
  }

  const iterator = event.iterator();
  let time: ICAL.Time | null;
  let count = 0;
  while ((time = iterator.next()) && count < MAX_OCCURRENCES_PER_EVENT) {
    count++;
    let details;
    try {
      details = event.getOccurrenceDetails(time);
    } catch {
      continue;
    }
    const start = details.startDate?.toJSDate();
    const end = details.endDate?.toJSDate();
    if (!start || !end) continue;
    const startMs = start.getTime();
    // Occurrences are chronological: once one starts past our look-ahead
    // horizon, nothing later matters either.
    if (startMs > horizonEndMs) break;
    // `details.item` is the master or the modified occurrence; filter on it so
    // a renamed / cancelled single instance is judged on its own fields.
    const perOccurrenceEvent = (details.item as ICAL.Event) ?? event;
    if (!eventPasses(perOccurrenceEvent, keywordLower)) continue;
    const title = perOccurrenceEvent.summary ?? event.summary ?? "";
    consider(toOccurrence(event.uid, title, startMs, end.getTime()), nowMs, picks);
    // Keep going past `now` only far enough to have settled `next`; once we
    // have a next pick and have moved past now, we can stop this event.
    if (startMs > nowMs && picks.next && picks.next.startMs <= startMs) break;
  }
}

/** Fold one occurrence into the active/next picks. */
function consider(
  occ: IcsOccurrence,
  nowMs: number,
  picks: { active: IcsOccurrence | null; next: IcsOccurrence | null }
): void {
  if (occ.startMs <= nowMs && nowMs < occ.endMs) {
    // Live now. Prefer the most-recently-started (tie: later end).
    const cur = picks.active;
    if (
      !cur ||
      occ.startMs > cur.startMs ||
      (occ.startMs === cur.startMs && occ.endMs > cur.endMs)
    ) {
      picks.active = occ;
    }
  } else if (occ.startMs > nowMs) {
    // Upcoming. Keep the soonest.
    if (!picks.next || occ.startMs < picks.next.startMs) {
      picks.next = occ;
    }
  }
}

/**
 * Parse an ICS feed and report the currently-live event and the next upcoming
 * one. Throws if the text is not parseable iCalendar (callers decide whether
 * that's a silent tick failure or a surfaced "couldn't read that calendar").
 */
export function summarizeCalendar(icsText: string, opts: SummarizeOptions = {}): CalendarSummary {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const horizonEndMs = nowMs + (opts.horizonMs ?? DEFAULT_HORIZON_MS);
  const keywordLower = (opts.keyword ?? "").trim().toLowerCase();

  const jcal = ICAL.parse(icsText);
  const root = new ICAL.Component(jcal);
  // Register any embedded VTIMEZONEs so floating-in-zone times resolve.
  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    try {
      const tzid = vtz.getFirstPropertyValue("tzid");
      if (tzid && !ICAL.TimezoneService.has(String(tzid))) {
        ICAL.TimezoneService.register(vtz);
      }
    } catch {
      // A bad VTIMEZONE just means that event falls back to floating/UTC.
    }
  }

  const picks: { active: IcsOccurrence | null; next: IcsOccurrence | null } = {
    active: null,
    next: null
  };
  for (const event of collectEvents(root)) {
    scanEvent(event, nowMs, horizonEndMs, keywordLower, picks);
  }
  return picks;
}

/** Convenience wrapper: the live occurrence, or null. */
export function findActiveOccurrence(icsText: string, opts: SummarizeOptions = {}): IcsOccurrence | null {
  return summarizeCalendar(icsText, opts).active;
}

/** Convenience wrapper: the next upcoming occurrence, or null. */
export function findNextOccurrence(icsText: string, opts: SummarizeOptions = {}): IcsOccurrence | null {
  return summarizeCalendar(icsText, opts).next;
}
