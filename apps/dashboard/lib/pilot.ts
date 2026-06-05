// Pilot feedback helpers: a small layer for testing Inbox OS with a handful
// of students. Pure builders / validators live here so they can be unit
// tested without a browser; the window-event helpers at the end let any
// page open the feedback modal without prop-drilling.
//
// A report carries only the tester's typed words plus safe metadata. It
// never carries message content — that is enforced by construction: message
// text is simply not an input to buildPilotReportPayload.

// localStorage flag: once the first-run welcome card on Today is dismissed,
// it stays dismissed. Settings can clear this to bring it back.
export const PILOT_WELCOME_DISMISSED_KEY = "pilot_welcome_dismissed";

// --- Report types --------------------------------------------------------

export const PILOT_REPORT_TYPES = ["bug", "feedback", "confusing", "feature_idea"] as const;
export type PilotReportType = (typeof PILOT_REPORT_TYPES)[number];

export const PILOT_REPORT_TYPE_LABELS: Record<PilotReportType, string> = {
  bug: "Something's broken",
  feedback: "Feedback",
  confusing: "This was confusing",
  feature_idea: "Feature idea"
};

// --- Screenshot validation ----------------------------------------------

export const ALLOWED_SCREENSHOT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
] as const;

// 5 MB per image. base64 inflates by ~33%; the runner's /control/pilot-feedback
// body limit is sized to fit MAX_SCREENSHOTS images at this cap.
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

// A report may carry a few images. Capped so the combined base64 body stays
// within the runner's /control/pilot-feedback parser limit.
export const MAX_SCREENSHOTS = 4;

export type ScreenshotValidation = { ok: true } | { ok: false; error: string };

/**
 * Validate a chosen screenshot file by type and size. Pure — takes the
 * minimal shape so it can be unit-tested without a real File object.
 */
export function validateScreenshotFile(file: { type: string; size: number }): ScreenshotValidation {
  if (!(ALLOWED_SCREENSHOT_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "That isn't a supported image (use PNG, JPEG, WebP or GIF)." };
  }
  if (file.size > MAX_SCREENSHOT_BYTES) {
    return { ok: false, error: "That image is too large (max 5 MB)." };
  }
  if (file.size <= 0) {
    return { ok: false, error: "That image looks empty." };
  }
  return { ok: true };
}

// --- Report payload ------------------------------------------------------

/** Safe, message-content-free metadata gathered on the dashboard side. */
export interface PilotReportMeta {
  route: string;
  pathname: string;
  threadId: string | null;
  appVersion: string;
  userAgent: string;
  timestamp: string;
}

export interface PilotReportPayload {
  type: PilotReportType;
  title: string;
  description: string;
  expected: string;
  privacyAck: boolean;
  meta: PilotReportMeta;
  screenshots: Array<{ name: string; dataUrl: string }>;
}

/**
 * Assemble the report payload the dashboard posts to the local runner.
 *
 * Pure and explicit: every field is something the tester typed or safe
 * metadata. There is no parameter through which message content could
 * enter, which is what keeps reports free of private conversation text.
 */
export function buildPilotReportPayload(input: {
  type: PilotReportType;
  title: string;
  description: string;
  expected: string;
  privacyAck: boolean;
  meta: PilotReportMeta;
  screenshots?: Array<{ name: string; dataUrl: string }>;
}): PilotReportPayload {
  return {
    type: input.type,
    title: input.title.trim(),
    description: input.description.trim(),
    expected: input.expected.trim(),
    privacyAck: input.privacyAck,
    meta: input.meta,
    screenshots: input.screenshots ?? []
  };
}

/** Render a submitted report as plain text — used by the copy fallback. */
export function formatReportForCopy(payload: PilotReportPayload): string {
  const lines = [
    `Relationship Inbox OS pilot: ${PILOT_REPORT_TYPE_LABELS[payload.type]}`,
    "",
    `Title: ${payload.title}`,
    "",
    "What happened:",
    payload.description
  ];
  if (payload.expected) {
    lines.push("", "Expected:", payload.expected);
  }
  lines.push(
    "",
    "Context (no message content)",
    `Page: ${payload.meta.route}`
  );
  if (payload.meta.threadId) lines.push(`Thread: ${payload.meta.threadId}`);
  lines.push(`Version: ${payload.meta.appVersion}`, `Time: ${payload.meta.timestamp}`);
  return lines.join("\n");
}

// --- Route helpers -------------------------------------------------------

/** Maps a Next.js pathname to the page name a tester would recognise. */
export function describeRoute(pathname: string): string {
  if (!pathname || pathname === "/") return "Today";
  if (pathname.startsWith("/today")) return "Today";
  if (pathname.startsWith("/inbox")) return "Inbox";
  if (pathname.startsWith("/thread/")) return "Thread";
  if (pathname.startsWith("/archived")) return "Archived";
  if (pathname.startsWith("/settings")) return "Settings";
  return pathname;
}

/** Pulls the thread id out of a /thread/:id path; null on any other route. */
export function extractThreadId(pathname: string): string | null {
  const match = /^\/thread\/([^/?#]+)/.exec(pathname ?? "");
  return match?.[1] ?? null;
}

/**
 * Gather safe metadata for a report. Browser-only (reads navigator /
 * location). The runner adds the rest — browser mode, AI help level, the
 * thread's platform — which the dashboard cannot see.
 */
export function collectPilotMeta(pathname: string): PilotReportMeta {
  const appVersion =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_APP_VERSION?.trim()) || "0.1.0";
  return {
    route: describeRoute(pathname),
    pathname,
    threadId: extractThreadId(pathname),
    appVersion,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    timestamp: new Date().toISOString()
  };
}

// --- Window-event bridge -------------------------------------------------
// The feedback modal is mounted once in the app shell. Any page (sidebar,
// command palette, settings) opens it by dispatching this event, so there
// is no prop-drilling and no global store.

const PILOT_FEEDBACK_EVENT = "pilot-feedback-open";

export function openPilotFeedback(type: PilotReportType = "feedback"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ type: PilotReportType }>(PILOT_FEEDBACK_EVENT, { detail: { type } })
  );
}

export function onPilotFeedback(handler: (type: PilotReportType) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const wrapped = (event: Event) => {
    const detail = (event as CustomEvent<{ type?: PilotReportType }>).detail;
    const type = detail?.type;
    handler(type && (PILOT_REPORT_TYPES as readonly string[]).includes(type) ? type : "feedback");
  };
  window.addEventListener(PILOT_FEEDBACK_EVENT, wrapped);
  return () => window.removeEventListener(PILOT_FEEDBACK_EVENT, wrapped);
}
