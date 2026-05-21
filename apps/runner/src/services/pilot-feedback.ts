// Pilot feedback intake. The dashboard posts a report to the local runner
// (POST /control/pilot-feedback). The runner enriches it with server-side
// metadata, optionally adds an AI triage summary, and forwards it to a
// Google Apps Script webhook (PILOT_FEEDBACK_WEBHOOK_URL) that appends a
// Google Sheets row and stores any screenshot in Google Drive.
//
// The shared secret lives only in the runner env — it is never sent to the
// browser. Message content is never part of a report.

export const PILOT_REPORT_TYPES = ["bug", "feedback", "confusing", "feature_idea"] as const;
export type PilotReportType = (typeof PILOT_REPORT_TYPES)[number];

export const ALLOWED_SCREENSHOT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
] as const;

// 5 MB decoded. base64 inflates by ~33%, so the JSON body stays well under
// the /control/pilot-feedback route's 12 MB parser limit.
export const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

export interface PilotScreenshot {
  name: string;
  mimeType: string;
  /** Raw base64 (no data: prefix) — the Apps Script decodes this to a Drive file. */
  base64: string;
}

export type ScreenshotParseResult =
  | { ok: true; screenshot: PilotScreenshot }
  | { ok: false; error: string };

// Decoded byte length of a base64 string, without allocating a Buffer.
function base64ByteLength(base64: string): number {
  const clean = base64.replace(/=+$/, "");
  return Math.floor((clean.length * 3) / 4);
}

function safeFileName(name: string): string {
  const trimmed = (name || "screenshot").trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return trimmed.slice(0, 80) || "screenshot";
}

/**
 * Validate a screenshot supplied as a `data:image/...;base64,...` URL.
 * Rejects non-images and anything over MAX_SCREENSHOT_BYTES. Pure and
 * framework-free so it can be unit-tested and reused by the route handler.
 */
export function parseScreenshotDataUrl(name: string, dataUrl: string): ScreenshotParseResult {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    (dataUrl ?? "").trim()
  );
  if (!match) {
    return { ok: false, error: "Screenshot must be an image file." };
  }
  const mimeType = match[1]!.toLowerCase();
  if (!(ALLOWED_SCREENSHOT_TYPES as readonly string[]).includes(mimeType)) {
    return { ok: false, error: `Unsupported image type: ${mimeType}.` };
  }
  const base64 = match[2]!.replace(/\s+/g, "");
  if (base64.length === 0) {
    return { ok: false, error: "Screenshot is empty." };
  }
  if (base64ByteLength(base64) > MAX_SCREENSHOT_BYTES) {
    return { ok: false, error: "Screenshot is too large (max 5 MB)." };
  }
  return { ok: true, screenshot: { name: safeFileName(name), mimeType, base64 } };
}

/**
 * The report object the runner forwards to the webhook. The dashboard never
 * sees the secret; it is added here, in the request body, because Google
 * Apps Script `doPost` cannot read request headers.
 */
export interface ForwardablePilotReport {
  type: PilotReportType;
  title: string;
  description: string;
  expected: string;
  meta: Record<string, unknown>;
  ai: Record<string, unknown> | null;
  screenshot: PilotScreenshot | null;
}

export type ForwardResult =
  | { ok: true; reportId: string }
  | { ok: false; error: string };

/** POST a report to the Apps Script webhook and return the report id. */
export async function forwardPilotReport(input: {
  webhookUrl: string;
  secret?: string;
  report: ForwardablePilotReport;
}): Promise<ForwardResult> {
  let response: Response;
  try {
    response = await fetch(input.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The secret is also a body field because Apps Script doPost handlers
      // cannot inspect headers; the header is sent for any future proxy.
      body: JSON.stringify({ secret: input.secret ?? "", report: input.report })
    });
  } catch (error) {
    return { ok: false, error: `Could not reach the feedback webhook: ${describeError(error)}` };
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, error: `Feedback webhook returned ${response.status}.` };
  }
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; reportId?: string; error?: string };
    if (parsed.ok && typeof parsed.reportId === "string" && parsed.reportId.length > 0) {
      return { ok: true, reportId: parsed.reportId };
    }
    return { ok: false, error: parsed.error || "Feedback webhook did not return a report id." };
  } catch {
    return { ok: false, error: "Feedback webhook returned an unexpected response." };
  }
}

export interface PilotReportStatusRow {
  reportId: string;
  title: string;
  type: string;
  status: string;
  createdAt: string;
  note: string;
}

/**
 * Fetch the recent-reports list from PILOT_FEEDBACK_STATUS_URL. The status
 * endpoint returns only safe columns — no screenshots, no message content.
 */
export async function fetchPilotReportStatus(input: {
  statusUrl: string;
  secret?: string;
}): Promise<{ ok: true; reports: PilotReportStatusRow[] } | { ok: false; error: string }> {
  let response: Response;
  try {
    const url = new URL(input.statusUrl);
    if (input.secret) url.searchParams.set("secret", input.secret);
    response = await fetch(url, { method: "GET" });
  } catch (error) {
    return { ok: false, error: `Could not reach the status endpoint: ${describeError(error)}` };
  }
  if (!response.ok) {
    return { ok: false, error: `Status endpoint returned ${response.status}.` };
  }
  try {
    const parsed = JSON.parse(await response.text()) as {
      ok?: boolean;
      reports?: PilotReportStatusRow[];
    };
    if (parsed.ok && Array.isArray(parsed.reports)) {
      return { ok: true, reports: parsed.reports };
    }
    return { ok: false, error: "Status endpoint returned an unexpected response." };
  } catch {
    return { ok: false, error: "Status endpoint returned an unexpected response." };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
