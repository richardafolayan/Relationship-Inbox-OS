import type {
  CalendarSyncSettings,
  FocusWindowState,
  SettingsStore
} from "../types/runtime";
import { fetchIcsText } from "./calendar-fetch";
import { summarizeCalendar, type IcsOccurrence } from "./calendar-ics";

// Calendar auto-focus (issue #786, pilot R-0097).
//
// A single-instance interval timer (like scheduled-send-promoter) that, while
// the operator has a calendar subscription enabled, opens a Focus window on
// its own whenever a real busy event is live and closes it when the event
// ends. The window is an ordinary Focus window — it still only ever surfaces
// the one-tap acknowledgements; nothing is auto-sent.
//
// Two invariants keep this calm and predictable:
//   * A window the operator started BY HAND (source: "manual") is never
//     touched. A hand-started block always wins over the calendar.
//   * Ending an auto-window "dismisses" it for THAT event occurrence: the
//     service will not re-open it for the same occurrence (matched on
//     sourceEventKey), but a later occurrence of a recurring event still
//     triggers a fresh window.

/** What a tick should do to the stored focus window. */
export type CalendarFocusAction =
  | { type: "none" }
  | { type: "start"; window: FocusWindowState }
  | { type: "end" };

/**
 * Pure decision: given the current window, the event live right now (or null),
 * and the operator's calendar settings, what should happen? No IO, so this is
 * exhaustively unit-tested. Callers pass `activeOcc = null` whenever the
 * subscription is off or the feed is empty — that path still closes a stale
 * auto-window.
 */
export function computeCalendarFocusAction(
  current: FocusWindowState,
  activeOcc: IcsOccurrence | null,
  settings: CalendarSyncSettings,
  now: Date
): CalendarFocusAction {
  if (activeOcc) {
    const key = activeOcc.key;
    if (current.active) {
      // A hand-started window always wins; never clobber it.
      if (current.source === "manual") return { type: "none" };
      // Already running this exact occurrence — leave it be.
      if (current.sourceEventKey === key) return { type: "none" };
      // A different calendar occurrence is live now (the previous one ended,
      // or events overlap) — switch to it.
      return { type: "start", window: buildCalendarWindow(activeOcc, settings, now) };
    }
    // No window open. If the current (inactive) window is the auto-window the
    // operator just dismissed for THIS occurrence, respect that and stay off.
    if (current.source === "calendar" && current.sourceEventKey === key) {
      return { type: "none" };
    }
    return { type: "start", window: buildCalendarWindow(activeOcc, settings, now) };
  }

  // Nothing live now. Close our own auto-window; never end a manual one.
  if (current.active && current.source === "calendar") return { type: "end" };
  return { type: "none" };
}

function buildCalendarWindow(
  occ: IcsOccurrence,
  settings: CalendarSyncSettings,
  now: Date
): FocusWindowState {
  // startedAt is the event's start (not `now`): the block genuinely began when
  // the meeting did, so messages that arrived since count as "during focus".
  // It is bounded by the event's own length, so this can't reach far back.
  const startedAt = new Date(Math.min(occ.startMs, now.getTime())).toISOString();
  return {
    active: true,
    startedAt,
    endsAt: new Date(occ.endMs).toISOString(),
    reason: occ.title,
    note: "",
    professionalNote: "",
    audience: settings.audience,
    windowId: occ.key,
    ackedPersonIds: [],
    source: "calendar",
    sourceEventKey: occ.key
  };
}

export interface CalendarFocusService {
  start(): void;
  stop(): void;
  /** Run one tick now; exposed for tests, the settings-save hook and admin. */
  tick(): Promise<CalendarFocusAction>;
  /** Drop the cached feed and run a tick immediately (after a settings save). */
  refresh(): Promise<void>;
}

interface CalendarFocusDeps {
  settingsStore: Pick<SettingsStore, "getOperatorProfile" | "updateOperatorProfile">;
  /** Polling cadence. Defaults to 60s; tests override to make ticks cheap. */
  intervalMs?: number;
  /** Clock injection for tests. */
  now?: () => Date;
  /** Fetch the ICS text for a URL. Defaults to the SSRF-guarded fetcher. */
  fetchIcs?: (url: string) => Promise<string>;
  /** How long to reuse fetched feed text before hitting the network again. */
  cacheTtlMs?: number;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export function createCalendarFocusService(deps: CalendarFocusDeps): CalendarFocusService {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = deps.now ?? (() => new Date());
  const fetchIcs = deps.fetchIcs ?? (async (url: string) => (await fetchIcsText(url)).text);

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let cache: { url: string; text: string; at: number } | null = null;

  async function getIcsCached(url: string): Promise<string> {
    const stamp = Date.now();
    if (cache && cache.url === url && stamp - cache.at < cacheTtlMs) return cache.text;
    const text = await fetchIcs(url);
    cache = { url, text, at: stamp };
    return text;
  }

  async function tick(): Promise<CalendarFocusAction> {
    if (running) return { type: "none" };
    running = true;
    try {
      const settings = (await deps.settingsStore.getOperatorProfile()).calendarSync;
      const currentNow = now();

      let activeOcc: IcsOccurrence | null = null;
      const fetching = settings.enabled && !!settings.url.trim();
      if (fetching) {
        try {
          const ics = await getIcsCached(settings.url);
          activeOcc = summarizeCalendar(ics, { now: currentNow, keyword: settings.keyword }).active;
        } catch (error) {
          // A transient fetch/parse failure must not tear down a running
          // auto-window (its endsAt still expires it client-side as a
          // backstop). Skip this tick without deciding.
          console.warn(
            `[calendar-focus] feed check failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          return { type: "none" };
        }
      }

      // Re-read the freshest profile AFTER the (possibly slow) fetch. A manual
      // window the operator started during the await must not be clobbered by
      // a decision built from the pre-fetch snapshot, and a subscription the
      // operator changed mid-fetch makes this tick's activeOcc stale.
      const fresh = await deps.settingsStore.getOperatorProfile();
      const freshSettings = fresh.calendarSync;
      if (
        fetching &&
        (!freshSettings.enabled ||
          freshSettings.url.trim() !== settings.url.trim() ||
          freshSettings.keyword !== settings.keyword)
      ) {
        // The URL/keyword/enabled changed while we were fetching, so the
        // occurrence we resolved no longer reflects the operator's intent.
        // Let the next tick (or the settings-save refresh) redo it cleanly.
        return { type: "none" };
      }

      const current = fresh.focusWindow;
      const action = computeCalendarFocusAction(current, activeOcc, freshSettings, currentNow);
      if (action.type === "start") {
        await deps.settingsStore.updateOperatorProfile({ focusWindow: action.window });
      } else if (action.type === "end") {
        await deps.settingsStore.updateOperatorProfile({
          focusWindow: { ...current, active: false }
        });
      }
      return action;
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    void tick().catch((error) => {
      console.warn(
        `[calendar-focus] initial tick failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    timer = setInterval(() => {
      void tick().catch((error) => {
        console.warn(
          `[calendar-focus] tick failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }, intervalMs);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function refresh(): Promise<void> {
    cache = null;
    await tick();
  }

  return { start, stop, tick, refresh };
}
