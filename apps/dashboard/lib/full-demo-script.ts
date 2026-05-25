/**
 * Full-presenter-demo script.
 *
 * Steps are declarative records consumed by FullDemoProvider — they
 * carry no functions so the array can be inspected by tests and serialised
 * across reloads if needed. `beforeStep` / `simulatedAction` reference
 * keys in `demoActionRegistry` (also exported here) which is where any
 * actual side-effects live.
 *
 * Tone: calm, practical, British English. No hype.
 */

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
  title: string;
  body: string;
  /** Registry key called once before the step renders. */
  beforeStep?: string;
  /** Registry key called when the user presses "Try it" on the step. */
  simulatedAction?: string;
  /** When provided, autoplay advances after this many ms. */
  waitMs?: number;
  /** Default true. */
  skippable?: boolean;
  /** What to do if `target` cannot be resolved. Default "show-centred". */
  fallback?: "skip" | "show-centred" | "stop";
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
    title: "Relationship Inbox OS",
    body:
      "A calm place to reply properly. It helps you understand what needs a reply, catch up quickly, and respond in your own words. Use Next to step through; you can pause or exit at any time."
  },
  {
    id: "today",
    route: "/today",
    target: "today-hero",
    title: "Today",
    body:
      "The daily reply queue. The hero card is the most overdue thread; everything else sits underneath. Nothing scrolls past you: you handle one thing, the next comes forward.",
    waitMs: 6000
  },
  {
    id: "today-queue",
    route: "/today",
    target: "today-queue",
    title: "What is waiting",
    body:
      "A short peek at the next few, never the full firehose. The goal is to finish, not to scroll."
  },
  {
    id: "inbox",
    route: "/inbox",
    target: "nav-inbox",
    title: "Full inbox",
    body:
      "When you do want to scan everything, the inbox shows conversations across every connected platform (LinkedIn, iMessage, and the rest) in one list, with light filtering on the side."
  },
  {
    id: "open-serena",
    mode: "sandbox",
    route: "/inbox",
    target: `thread-row-${SHOWCASE_THREAD_IDS.serena}`,
    title: "An iMessage thread",
    body:
      "Serena. She's confirmed she's free Saturday and is asking where to meet. Open it to see what catching up looks like."
  },
  {
    id: "serena-reply-brief",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "reply-brief",
    title: "Reply brief",
    body:
      "Before you write anything, the app summarises where the conversation stands and what is on you. No need to scroll back through five days of messages.",
    waitMs: 7000
  },
  {
    id: "serena-action-items",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "action-items",
    title: "Things to address",
    body:
      "Two open items: pick a spot, lock a time. As you type a reply, the AI ticks the ones your draft already covers, quietly, not in your face."
  },
  {
    id: "serena-composer",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "composer",
    title: "Reply in your own words",
    body:
      "The composer stays the focus. AI help is optional: you can ask for a draft if you want one, but most of the time you'll just write."
  },
  {
    id: "open-timi",
    mode: "sandbox",
    route: "/inbox",
    target: `thread-row-${SHOWCASE_THREAD_IDS.timi}`,
    title: "A LinkedIn thread",
    body:
      "Timi is sharing a quick career update. There is no direct question, no real ask, and the app reads that and tells you so."
  },
  {
    id: "timi-respond-lightly",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.timi,
    target: "reply-brief",
    title: "Respond lightly",
    body:
      "When nothing is really on you, the brief says so. Reply briefly and move on; no need to manufacture an essay.",
    waitMs: 7000
  },
  {
    id: "multi-loop",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.multiLoop,
    target: "action-items",
    title: "Several open items",
    body:
      "Sometimes a thread has more in it. Four open points here, the checklist shows them all so nothing slips through, and the AI ticks them off as you address them in the draft."
  },
  {
    id: "suggested-replies",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "suggested-replies",
    title: "Suggested replies",
    body:
      "If you'd rather start from something, three short options are there. Always a draft, never an auto-send; you stay in control of every message."
  },
  {
    id: "snooze-archive",
    mode: "sandbox",
    threadPlatformId: SHOWCASE_THREAD_IDS.serena,
    target: "thread-actions",
    title: "Snooze, archive, mark handled",
    body:
      "Three quick actions for when you don't need to reply right now. In this sandbox demo they only affect demo data, so your real inbox is not touched."
  },
  {
    id: "reconnect",
    mode: "sandbox",
    route: "/reconnect",
    target: `thread-row-${SHOWCASE_THREAD_IDS.reconnect}`,
    title: "Reconnect",
    body:
      "Old threads worth returning to surface here. Not a relationship score, not a dashboard, just a quiet prompt that you haven't heard from someone in a while and the conversation was a good one."
  },
  {
    id: "user-voice",
    route: "/settings",
    target: "settings-user-voice",
    title: "Writing in your voice",
    body:
      "Settings holds your voice profile: how you usually write, words you favour, words you avoid. The AI uses it to support your wording rather than replace it."
  },
  {
    id: "feedback",
    target: "feedback",
    title: "Tell me what's wrong",
    body:
      "Anything confusing or broken: the feedback button captures what you saw without including private message content. Quick to send, no friction."
  },
  {
    id: "settings",
    route: "/settings",
    target: "settings-full-demo",
    title: "Run the demo again",
    body:
      "Settings is also where you start this demo. Sandbox is safe; the live read-only mode lets you walk someone through your own real threads without any risk of sending or archiving anything."
  },
  {
    id: "closing",
    title: "That is the loop",
    body:
      "Find what needs a reply, catch up quickly, write in your own words, and clear it. Press End demo when you are ready to leave."
  }
];

/**
 * Registry of side-effect functions referenced by step ids
 * (`beforeStep` / `simulatedAction`). Pure functions, never serialised.
 * Empty for now — the v1 demo controller relies on route navigation +
 * DOM-bounds highlight only.
 */
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
