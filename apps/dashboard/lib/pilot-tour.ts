// Pilot guided tour — the first-run walkthrough offered on Today.
//
// Lives apart from the React component so the runner-side and node test
// runners can pick the step list up without a JSX loader. The component
// in `components/common/PilotTour.tsx` is a thin shell that drives the
// shared GuidedTour primitive with these steps.
//
// The pilot tour runs against the FullDemo sandbox (same seed as the
// full presenter demo) so we don't have to maintain a second seed.
// `lib/full-demo-script.ts` owns the canonical platformThreadIds and
// the pilot steps reference them directly.

import { SHOWCASE_THREAD_IDS } from "./full-demo-script";
import type { GuidedTourStep } from "./guided-tour";

// ── localStorage keys ──────────────────────────────────────────────────
// `seen`   — set once the operator has skipped or completed the walkthrough.
// `active` — set while the tour is actually running. AppShell uses this
//            as a one-shot "abandoned tour" signal on cold start so
//            seeded data never lingers between sessions.
export const PILOT_TOUR_SEEN_KEY = "relationship-inbox-os:pilot-guided-demo-seen:v1";
export const PILOT_TOUR_ACTIVE_KEY = "relationship-inbox-os:pilot-guided-demo-active:v1";

/** Window event the welcome card / Settings replay button dispatch to start the tour. */
export const PILOT_TOUR_START_EVENT = "pilot-tour-start";

// ── Step list ──────────────────────────────────────────────────────────

/**
 * The pilot first-run walkthrough. Eight steps, calm and direct. State
 * what each thing is and what the operator does with it. No "not X, not Y"
 * framing. No em dashes.
 *
 * Anchor names match the same `data-demo-target` attributes the full
 * presenter demo uses, so the shared primitive resolves both without
 * caring which flow is running.
 */
export function getPilotTourSteps(): GuidedTourStep[] {
  return [
    {
      key: "today",
      title: "Today",
      body: "Today shows who is waiting. Start with the top thread, then move down the queue.",
      targets: ["today-hero"],
      placement: "left",
      navigateTo: () => "/today"
    },
    {
      key: "demo-loaded",
      title: "Demo conversations loaded",
      body: "Two demo threads have been added: Serena on iMessage and Timi on LinkedIn. All actions stay inside sandbox data.",
      targets: [],
      placement: "center",
      beat: "Sandbox ready",
      navigateTo: () => "/today"
    },
    {
      key: "open-serena",
      title: "Open Serena",
      body: "She has been waiting since yesterday. Click her row to open the thread.",
      targets: [`thread-row-${SHOWCASE_THREAD_IDS.serena}`, "today-hero"],
      placement: "left",
      navigateTo: () => "/today",
      continueMode: "click-target"
    },
    {
      key: "reply-brief",
      title: "Reply brief",
      body: "Where the conversation stands and what is on you. Read this before writing the reply.",
      targets: ["reply-brief-where-it-stands", "reply-brief-on-you", "reply-brief"],
      placement: "left"
    },
    {
      key: "composer",
      title: "Write the reply",
      body: "Compose in your own words. AI can help shape the reply. You stay in control of what gets sent.",
      targets: ["composer-input"],
      placement: "top"
    },
    {
      key: "clear-thread",
      title: "Clear the thread",
      body: "Mark as handled, snooze, or archive when you are finished.",
      targets: ["thread-actions"],
      placement: "bottom"
    },
    {
      key: "feedback",
      title: "Send feedback",
      body: "Anything confusing or broken. The feedback button captures what you saw without including private message content.",
      targets: ["feedback"],
      placement: "right"
    },
    {
      key: "done",
      title: "That is the loop",
      body: "Find what needs a reply. Catch up quickly. Write in your own words. Clear the thread. Press Done when you are ready.",
      targets: []
    }
  ];
}

// ── localStorage helpers ───────────────────────────────────────────────

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

// ── Skip lifecycle ─────────────────────────────────────────────────────
// Skipping the tour while the sandbox is still bootstrapping is the
// dangerous moment: the `startPilotSandbox` POST has already flipped the
// runner into demo mode (flow="pilot", sandboxActive=true), so closing the
// card alone leaves the real inbox hidden with no recovery affordance
// (recoveryNeeded is gated on flow===null). The skip must instead defer
// teardown until the in-flight bootstrap settles, then tear the sandbox
// down so the real inbox is restored without a page reload.

export type PilotSkipPlan =
  /** Sandbox already seeded → tear it down now via the normal end path. */
  | { kind: "end-tour" }
  /**
   * Sandbox is mid-bootstrap → close the card now, but remember that a skip
   * was requested so the bootstrap-resolve path tears the sandbox down.
   */
  | { kind: "defer-teardown" };

/** What `skipTour` should do, given whether the sandbox is still bootstrapping. */
export function planPilotSkip(bootstrapping: boolean): PilotSkipPlan {
  return bootstrapping ? { kind: "defer-teardown" } : { kind: "end-tour" };
}

/**
 * Whether the resolved-bootstrap path must tear the sandbox down. True only
 * when a skip was requested while the sandbox was still bootstrapping — the
 * fix that stops the real inbox from staying hidden after a mid-bootstrap skip.
 */
export function shouldTearDownDeferredSkip(skipRequestedDuringBootstrap: boolean): boolean {
  return skipRequestedDuringBootstrap;
}

// ── Window-event bridge ────────────────────────────────────────────────

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
