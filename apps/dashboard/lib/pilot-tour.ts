// Pilot guided tour — a small first-run walkthrough that runs once for
// each pilot tester. Lives in one editable file so copy tweaks don't
// require touching the tour component. Everything here is framework-free
// (no React imports) so the runner-side and node test runners can pick
// it up without a JSX loader.
//
// The tour itself never talks to a real platform — it operates entirely
// against the deterministic Serena/Timi seed produced by the runner's
// /control/pilot-tour/start endpoint. See apps/runner/src/services/demo.ts.

// ── localStorage keys ──────────────────────────────────────────────────
// `seen`   — set once the user has Skipped or Completed the walkthrough.
// `active` — set while the tour is actually running. AppShell uses this
//            as a one-shot "abandoned tour" signal on cold start so
//            seeded data never lingers between sessions.
export const PILOT_TOUR_SEEN_KEY = "relationship-inbox-os:pilot-guided-demo-seen:v1";
export const PILOT_TOUR_ACTIVE_KEY = "relationship-inbox-os:pilot-guided-demo-active:v1";

// Window event the welcome card / Settings button dispatch to start the
// tour. The mounted PilotTour component listens for it. Replaying from
// Settings dispatches with `{ replay: true }` so the tour state resets
// regardless of `seen`.
export const PILOT_TOUR_START_EVENT = "pilot-tour-start";

// ── Demo thread ids ────────────────────────────────────────────────────
// Mirror the constants in apps/runner/src/services/demo.ts. Kept here in
// the dashboard because runner imports cross a workspace boundary and a
// one-line constant is cheaper than a shared package re-export.
export const PILOT_TOUR_SERENA_THREAD_KEY = "demo-pilot-serena-imessage";
export const PILOT_TOUR_TIMI_THREAD_KEY = "demo-pilot-timi-linkedin";

// ── Step list ──────────────────────────────────────────────────────────

/**
 * One step in the guided walkthrough. The tour component looks up the
 * first `data-tour` selector that resolves; if none resolve, the step is
 * skipped gracefully (it does not crash the tour).
 */
export interface PilotTourStep {
  /** Stable id for the step — used in tests and in localStorage progress. */
  key: string;
  /** Short title at the top of the popover. */
  title: string;
  /** One- or two-sentence body. British English, calm, direct. */
  body: string;
  /**
   * `data-tour` selectors to try in order. The first match wins. The list
   * is in priority order: the preferred selector first, fallbacks after.
   * Reply Brief steps list `reply-brief-where-it-stands` (the future
   * label) before `reply-brief` (today's right rail) so the same tour
   * works before and after the Reply Brief branch lands.
   *
   * Empty array = a route-level step with no anchor — render the popover
   * centred on screen (used for the "subtle scanning" beat).
   */
  targets: string[];
  /** Where the popover sits relative to the anchor. Ignored when no anchor. */
  placement?: "top" | "bottom" | "left" | "right" | "center";
  /**
   * Route to navigate to before the step runs. When the step needs a
   * demo thread the function receives the live thread-id map from the
   * /control/pilot-tour/start response.
   *
   * Returning null means "stay on the current route".
   */
  navigateTo?: (demoIds: PilotTourDemoIds) => string | null;
  /**
   * Soft pre-step beat — the popover shows this caption briefly before
   * the main body when present. Used for the "Scanning demo inbox…"
   * theatre on step 3 so the tour mirrors the real scan experience
   * without ever triggering a real scan.
   */
  beat?: string;
  /**
   * How the tour advances from this step.
   *   "next"         — operator clicks "Next" in the popover (default).
   *   "click-target" — operator clicks the highlighted UI; the tour
   *                    listens for a click that lands inside the
   *                    resolved target and advances. Use this for
   *                    safe navigation steps (opening a demo thread)
   *                    so the tour mirrors the real interaction.
   *                    Never used for destructive actions (Send /
   *                    Archive / Mark handled / Snooze) — those
   *                    stay narrated with a Next button.
   */
  continueMode?: "next" | "click-target";
}

export interface PilotTourDemoIds {
  /** Thread row id (cuid) for the Serena iMessage demo thread. */
  serena: string | null;
  /** Thread row id (cuid) for the Timi LinkedIn demo thread. */
  timi: string | null;
}

export function emptyDemoIds(): PilotTourDemoIds {
  return { serena: null, timi: null };
}

/**
 * The full pilot walkthrough. Eight steps — sits inside the brief's
 * 7-10 cap. Each step is skippable; missing targets skip gracefully.
 */
export function getPilotTourSteps(): PilotTourStep[] {
  return [
    {
      key: "today-nav",
      title: "This is Today",
      body: "Today shows who needs a reply first.",
      targets: ["today-nav"],
      placement: "right",
      navigateTo: () => "/today"
    },
    {
      key: "scanning-beat",
      title: "Loading a few demo conversations",
      body:
        "Two demo threads have been added: Serena on iMessage and Timi on LinkedIn.",
      targets: [],
      placement: "center",
      beat: "Scanning demo inbox…",
      navigateTo: () => "/today"
    },
    {
      key: "today-list",
      title: "Each row is a conversation",
      body: "The top one is the oldest waiting.",
      targets: ["today-hero", "today-list"],
      placement: "left",
      navigateTo: () => "/today"
    },
    {
      key: "open-serena",
      title: "Open Serena",
      body:
        "She has been waiting since yesterday. Click her row to open the thread.",
      targets: ["demo-serena-thread", "today-hero"],
      placement: "left",
      // Keep navigateTo so the Back button from the Reply Brief step
      // routes the operator back to /today before re-anchoring.
      navigateTo: () => "/today",
      continueMode: "click-target"
    },
    {
      key: "reply-brief",
      title: "Where it stands · On you",
      body: "This catches you up before you reply.",
      targets: [
        "reply-brief-where-it-stands",
        "reply-brief-on-you",
        "reply-brief"
      ],
      placement: "left",
      // No navigateTo on forward — clicking Serena's row drives the
      // route change. On Back from later steps we are already on the
      // thread page, so no navigation needed either.
      navigateTo: (ids) => (ids.serena ? `/thread/${ids.serena}` : null)
    },
    {
      key: "composer",
      title: "Write in your own words",
      body: "Write your reply here. Nothing sends until you press Send.",
      targets: ["composer"],
      placement: "top",
      navigateTo: (ids) => (ids.serena ? `/thread/${ids.serena}` : null)
    },
    {
      key: "clear-thread",
      title: "Clear the thread when you are done",
      body: "Mark as handled, snooze, or archive when you are finished.",
      targets: ["mark-handled", "snooze", "archive"],
      placement: "bottom",
      navigateTo: (ids) => (ids.serena ? `/thread/${ids.serena}` : null)
    },
    {
      key: "feedback",
      title: "Send feedback any time",
      body: "Tell us what is confusing or wrong. Every report helps.",
      targets: ["feedback"],
      placement: "right"
    }
  ];
}

// ── localStorage helpers ───────────────────────────────────────────────

/**
 * Minimal storage shape. Tests pass an in-memory object; the runtime
 * uses `window.localStorage`. Kept as the bare three methods used so a
 * dummy `{}`-backed storage compiles without polyfilling Storage.
 */
export interface PilotTourStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isTourSeen(storage: PilotTourStorage): boolean {
  return storage.getItem(PILOT_TOUR_SEEN_KEY) === "1";
}

export function markTourSeen(storage: PilotTourStorage): void {
  storage.setItem(PILOT_TOUR_SEEN_KEY, "1");
}

export function clearTourSeen(storage: PilotTourStorage): void {
  storage.removeItem(PILOT_TOUR_SEEN_KEY);
}

export function isTourActive(storage: PilotTourStorage): boolean {
  return storage.getItem(PILOT_TOUR_ACTIVE_KEY) === "1";
}

export function markTourActive(storage: PilotTourStorage): void {
  storage.setItem(PILOT_TOUR_ACTIVE_KEY, "1");
}

export function clearTourActive(storage: PilotTourStorage): void {
  storage.removeItem(PILOT_TOUR_ACTIVE_KEY);
}

// ── Step traversal ─────────────────────────────────────────────────────

/** Returns the next valid index, or `null` when the tour is done. */
export function nextStepIndex(steps: PilotTourStep[], current: number): number | null {
  const next = current + 1;
  return next < steps.length ? next : null;
}

export function prevStepIndex(steps: PilotTourStep[], current: number): number {
  return current > 0 ? current - 1 : 0;
}

export function isLastStep(steps: PilotTourStep[], current: number): boolean {
  return current >= steps.length - 1;
}

// ── Window-event bridge ────────────────────────────────────────────────
// Same pattern as openPilotFeedback in lib/pilot.ts — any component can
// dispatch a start, without prop-drilling through the AppShell.

export function startPilotTour(options: { replay?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ replay: boolean }>(PILOT_TOUR_START_EVENT, {
      detail: { replay: options.replay ?? false }
    })
  );
}

export function onPilotTourStart(handler: (replay: boolean) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<{ replay?: boolean }>).detail;
    handler(detail?.replay ?? false);
  };
  window.addEventListener(PILOT_TOUR_START_EVENT, wrapped);
  return () => window.removeEventListener(PILOT_TOUR_START_EVENT, wrapped);
}
