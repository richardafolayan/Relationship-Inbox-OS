/**
 * Full-presenter-demo script.
 *
 * Steps are declarative records consumed by FullDemoProvider — they
 * carry no functions so the array can be inspected by tests and serialised
 * across reloads if needed.
 *
 * Tone: calm, practical, British English. State what each thing is and
 * what the operator does with it. No "not X, not Y" framing. No em dashes.
 */

import type { GuidedTourPlacement } from "./guided-tour";

export type FullDemoMode = "sandbox" | "live";

export interface DemoStep {
  id: string;
  /** Which mode the step runs in. Defaults to "both". */
  mode?: FullDemoMode | "both";
  /** Optional route to navigate to before the step body shows. */
  route?: string;
  /**
   * When set, the provider looks up the showcase thread by its stable
   * platformThreadId via /data/inbox and navigates to /thread/{internalId}.
   * Takes precedence over `route` so the script doesn't need to know the
   * runner's cuid for each thread up-front.
   */
  threadPlatformId?: string;
  /** `data-demo-target` value of the element to highlight. Omit for centred. */
  target?: string;
  /** Where the card sits relative to the anchor. Defaults to "bottom". */
  placement?: GuidedTourPlacement;
  title: string;
  body: string;
  /** Soft pre-body caption for loading / scanning beats. */
  beat?: string;
  /**
   * "next" (default) or "click-target". Click-target steps wait for the
   * operator to click inside the anchored element, so the tour mirrors
   * the real interaction.
   */
  continueMode?: "next" | "click-target";
  /** When provided, autoplay advances after this many ms. */
  waitMs?: number;
}

/**
 * Stable platformThreadIds the demo controller targets in sandbox mode.
 * Mirror of apps/runner/src/services/demo.ts → buildShowcaseThreads().
 */
export const SHOWCASE_THREAD_IDS = {
  serena: "demo-full-serena-imessage",
  timi: "demo-full-timi-linkedin",
  brandon: "demo-full-brandon-linkedin",
  multiLoop: "demo-full-multi-open-loop",
  reconnect: "demo-full-reconnect",
  snoozed: "demo-full-snoozed",
  archived: "demo-full-archived"
} as const;

export const FULL_DEMO_SCRIPT: DemoStep[] = [
  {
    id: "opening",
    title: "A guided tour",
    body:
      "This is the full walkthrough. Demo conversations have been loaded. All actions stay inside sandbox data."
  },
  {
    id: "today",
    route: "/today",
    target: "today-hero",
    placement: "left",
    title: "Today",
    body: "Today shows who is waiting. Start with the top thread, then move down the queue."
  },
  {
    id: "inbox",
    route: "/inbox",
    target: "nav-inbox",
    placement: "right",
    title: "Inbox",
    body: "The inbox lists every conversation across connected platforms in one place."
  },
  {
    id: "open-serena",
    mode: "sandbox",
    route: "/inbox",
    target: `thread-row-${SHOWCASE_THREAD_IDS.serena}`,
    placement: "left",
    title: "Open Serena",
    body: "She is asking where to meet on Saturday. Click her row to open the thread.",
    continueMode: "click-target"
  },
  {
    id: "serena-reply-brief",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "reply-brief",
    placement: "left",
    title: "Reply brief",
    body:
      "The brief sums up where the conversation stands and what is on you. Read this before writing the reply."
  },
  {
    id: "serena-composer",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "composer-input",
    placement: "top",
    title: "Write the reply",
    body: "Compose in your own words. AI can help shape the reply. You stay in control of what gets sent."
  },
  {
    id: "serena-clear",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "thread-actions",
    placement: "bottom",
    title: "Clear the thread",
    body: "Mark as handled, snooze, or archive when you are finished."
  },
  {
    id: "open-timi",
    mode: "sandbox",
    route: "/inbox",
    target: `thread-row-${SHOWCASE_THREAD_IDS.timi}`,
    placement: "left",
    title: "Open Timi",
    body: "Timi shared a quick career update on LinkedIn. Click the row to open it.",
    continueMode: "click-target"
  },
  {
    id: "timi-light-reply",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.timi,
    target: "reply-brief",
    placement: "left",
    title: "When nothing is on you",
    body: "The brief calls out when nothing in particular is on you. Reply briefly and move on."
  },
  {
    id: "reconnect",
    mode: "sandbox",
    route: "/reconnect",
    target: "nav-reconnect",
    placement: "right",
    title: "Reconnect",
    body: "Reconnect brings back older conversations worth revisiting."
  },
  {
    id: "user-voice",
    route: "/settings",
    target: "settings-user-voice",
    placement: "right",
    title: "Writing in your voice",
    body: "Settings holds your voice profile. The AI uses it to match how you usually write."
  },
  {
    id: "feedback",
    target: "feedback",
    placement: "right",
    title: "Send feedback",
    body:
      "Anything confusing or broken. The feedback button captures what you saw without including private message content."
  },
  {
    id: "settings",
    route: "/settings",
    target: "settings-full-demo",
    placement: "right",
    title: "Run it again",
    body: "Settings starts this demo. Sample mode uses practice conversations. Real mode is read-only against threads you choose. Nothing is sent automatically."
  },
  {
    id: "closing",
    title: "That is the loop",
    body:
      "Find what needs a reply. Catch up quickly. Write in your own words. Clear the thread. Press Done when you are ready."
  }
];

export interface DemoActionContext {
  navigate: (route: string) => void;
}

export const demoActionRegistry: Record<string, (ctx: DemoActionContext) => Promise<void>> = {};

export function getStepIndex(stepId: string | null): number {
  if (!stepId) return 0;
  const idx = FULL_DEMO_SCRIPT.findIndex((s) => s.id === stepId);
  return idx >= 0 ? idx : 0;
}

export function isStepInMode(step: DemoStep, mode: FullDemoMode): boolean {
  const m = step.mode ?? "both";
  return m === "both" || m === mode;
}
