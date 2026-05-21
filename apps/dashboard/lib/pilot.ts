// Pilot-readiness helpers: a small layer for testing Inbox OS with a
// handful of students. Pure template/route helpers live here so they can
// be unit-tested without a browser; the window-event helpers below let
// any page open the feedback modal without prop-drilling.

export type PilotFeedbackMode = "feedback" | "bug";

// localStorage flag: once the first-run welcome card on Today is
// dismissed, it stays dismissed. Settings can clear this to bring it back.
export const PILOT_WELCOME_DISMISSED_KEY = "pilot_welcome_dismissed";

// The questions a pilot tester is asked. Plain language on purpose — this
// is a calm product note, not a survey.
export const FEEDBACK_QUESTIONS: readonly string[] = [
  "Did this help you reply?",
  "What felt wrong or annoying?",
  "Did the action items miss anything important?",
  "Did anything feel too AI?",
  "Would you use this again tomorrow?",
  "What would make this genuinely useful?"
];

// Copy-to-clipboard feedback template. Useful when feedback is collected
// over iMessage / WhatsApp / DMs rather than a form.
export function buildFeedbackTemplate(): string {
  return [
    "Quick feedback — Relationship Inbox OS pilot",
    "",
    ...FEEDBACK_QUESTIONS.map((question, index) => `${index + 1}. ${question}`),
    "",
    "Only share what you're comfortable sharing. No need to be polite."
  ].join("\n");
}

export interface BugReportContext {
  // Human-readable page name, e.g. "Thread".
  route: string;
  // The thread id, only when the bug happened on a thread page.
  threadId: string | null;
  // App version, if exposed via NEXT_PUBLIC_APP_VERSION.
  appVersion: string;
  // ISO timestamp of when the report was opened.
  timestamp: string;
}

// Copy-to-clipboard bug report template. Prompts for the four things that
// make a bug actionable, then appends auto-filled context. It deliberately
// never includes message content — only the route, thread id, version and
// time.
export function buildBugReportTemplate(context: BugReportContext): string {
  const lines = [
    "Bug report — Relationship Inbox OS pilot",
    "",
    "What were you trying to do?",
    "",
    "",
    "What went wrong?",
    "",
    "",
    "What did you expect to happen?",
    "",
    "",
    "— Context (auto-filled, no message content) —",
    `Page: ${context.route}`
  ];
  if (context.threadId) lines.push(`Thread: ${context.threadId}`);
  lines.push(`Version: ${context.appVersion}`);
  lines.push(`Time: ${context.timestamp}`);
  return lines.join("\n");
}

// Maps a Next.js pathname to the page name a tester would recognise.
export function describeRoute(pathname: string): string {
  if (!pathname || pathname === "/") return "Today";
  if (pathname.startsWith("/today")) return "Today";
  if (pathname.startsWith("/inbox")) return "Inbox";
  if (pathname.startsWith("/thread/")) return "Thread";
  if (pathname.startsWith("/archived")) return "Archived";
  if (pathname.startsWith("/settings")) return "Settings";
  return pathname;
}

// Pulls the thread id out of a /thread/:id path. Returns null on any other
// route so a bug report off a thread page carries no thread id.
export function extractThreadId(pathname: string): string | null {
  const match = /^\/thread\/([^/?#]+)/.exec(pathname ?? "");
  return match?.[1] ?? null;
}

// --- Window-event bridge -------------------------------------------------
// The feedback modal is mounted once in the app shell. Any page (sidebar,
// command palette, settings) opens it by dispatching this event, so there
// is no prop-drilling and no global store.

const PILOT_FEEDBACK_EVENT = "pilot-feedback-open";

export function openPilotFeedback(mode: PilotFeedbackMode = "feedback"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ mode: PilotFeedbackMode }>(PILOT_FEEDBACK_EVENT, { detail: { mode } }));
}

export function onPilotFeedback(handler: (mode: PilotFeedbackMode) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<{ mode?: PilotFeedbackMode }>).detail;
    handler(detail?.mode === "bug" ? "bug" : "feedback");
  };
  window.addEventListener(PILOT_FEEDBACK_EVENT, wrapped);
  return () => window.removeEventListener(PILOT_FEEDBACK_EVENT, wrapped);
}
