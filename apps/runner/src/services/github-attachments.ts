// Attach pilot-feedback screenshots to the GitHub issue the Apps Script
// just created. The Apps Script writes the issue body + adds a row to
// the Sheet with the screenshot in column W (Drive link), but Drive
// links are auth-walled — agents triaging the issue from GitHub can't
// see the image. This service uploads the screenshot bytes into the
// repo at `pilot-feedback-attachments/<reportId>-<n>.<ext>`, then
// posts an issue comment with inline image references so the
// screenshot renders directly in the GitHub issue thread.
//
// Best-effort: callers fire this and don't await. If the GitHub token
// or repo isn't configured, or the issue can't be found by reportId,
// we log a warning and move on — the Apps Script's row + Drive link
// remain the source of truth either way.

const RAW_BASE = "https://raw.githubusercontent.com";

export interface PilotAttachmentScreenshot {
  /** Display name for the file (.ext is derived from mimeType). */
  name: string;
  /** "image/png", "image/jpeg", etc. */
  mimeType: string;
  /** Raw base64 (no data: prefix). */
  base64: string;
}

export interface AttachOptions {
  /** Report id assigned by the Apps Script (e.g. "R-0045"). */
  reportId: string;
  /** Screenshot blobs the operator attached when filing. */
  screenshots: PilotAttachmentScreenshot[];
  /** GitHub repo in "owner/name" form. */
  repo: string;
  /** PAT with `repo` scope. */
  token: string;
  /** Branch to commit the screenshot file to. Default: "v1/strip-back-pr1". */
  branch?: string;
  /**
   * Optional injectable fetch — lets tests stub HTTP without a real
   * GitHub round-trip. Defaults to globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
}

export interface AttachResult {
  ok: boolean;
  reason?: string;
  issueNumber?: number;
  /** Public raw-content URLs of each uploaded screenshot. */
  uploadedUrls?: string[];
  /** Comment URL on the issue, when posted. */
  commentUrl?: string;
}

function extFromMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

/**
 * Locate the GitHub issue the Apps Script just created by searching
 * for the reportId in its title. The Apps Script titles match
 * `…(<reportId>)`, e.g. `[Pilot feedback] Feedback: foo (R-0045)`.
 * Returns the issue number, or null if not found within `attempts`
 * retries (the Apps Script creates the issue near-synchronously with
 * the row, but it's a separate API call — small race possible).
 */
export async function findIssueByReportId(opts: {
  reportId: string;
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
  attempts?: number;
  delayMs?: number;
}): Promise<number | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const attempts = opts.attempts ?? 5;
  const delayMs = opts.delayMs ?? 1500;
  const query = encodeURIComponent(`repo:${opts.repo} in:title "${opts.reportId}"`);
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetchImpl(`https://api.github.com/search/issues?q=${query}&per_page=5`, {
        headers: ghHeaders(opts.token)
      });
      if (res.ok) {
        const body = (await res.json()) as {
          items?: Array<{ number: number; title: string }>;
        };
        // The Apps Script titles include the reportId at the end; pick
        // the freshest match.
        const match = body.items?.find((item) => item.title.includes(opts.reportId));
        if (match) return match.number;
      }
    } catch {
      // Transient network blip (DNS failure, reset, rejected 5xx). Fall
      // through to the delay + retry, same as a non-ok response — the
      // issue may exist and a retry could find it.
    }
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Upload a single screenshot to the repo at the given path. Returns
 * the public raw URL on success, or null on failure.
 */
export async function uploadScreenshotToRepo(opts: {
  repo: string;
  branch: string;
  token: string;
  path: string;
  base64: string;
  commitMessage: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const contentsUrl = `https://api.github.com/repos/${opts.repo}/contents/${opts.path}`;
  // The path is deterministic per reportId, so a retry or a duplicate
  // webhook re-attaches the same path. GitHub's Contents API rejects a
  // PUT to an existing path (HTTP 422) unless the current blob `sha` is
  // supplied to update in place. GET it first; a non-ok response (404)
  // means a fresh create and we send no sha.
  let existingSha: string | undefined;
  const head = await fetchImpl(
    `${contentsUrl}?ref=${encodeURIComponent(opts.branch)}`,
    { method: "GET", headers: ghHeaders(opts.token) }
  );
  if (head.ok) {
    const meta = (await head.json()) as { sha?: string };
    if (meta && typeof meta.sha === "string") existingSha = meta.sha;
  }
  const res = await fetchImpl(contentsUrl, {
    method: "PUT",
    headers: ghHeaders(opts.token),
    body: JSON.stringify({
      message: opts.commitMessage,
      content: opts.base64,
      branch: opts.branch,
      ...(existingSha ? { sha: existingSha } : {})
    })
  });
  if (!res.ok) {
    return null;
  }
  return `${RAW_BASE}/${opts.repo}/${opts.branch}/${opts.path}`;
}

/**
 * Post a comment on the issue. Returns the comment URL on success.
 */
export async function postIssueComment(opts: {
  repo: string;
  issueNumber: number;
  body: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(
    `https://api.github.com/repos/${opts.repo}/issues/${opts.issueNumber}/comments`,
    {
      method: "POST",
      headers: ghHeaders(opts.token),
      body: JSON.stringify({ body: opts.body })
    }
  );
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as { html_url?: string };
  return json.html_url ?? null;
}

/**
 * End-to-end attach: find the issue, upload each screenshot, post one
 * comment with the inline images. Returns a structured result so the
 * caller (the pilot-feedback route) can log the outcome.
 */
export async function attachScreenshotsToIssue(opts: AttachOptions): Promise<AttachResult> {
  if (!opts.reportId) return { ok: false, reason: "no reportId" };
  if (opts.screenshots.length === 0) return { ok: false, reason: "no screenshots" };
  if (!opts.token) return { ok: false, reason: "no GITHUB_TOKEN configured" };
  if (!opts.repo) return { ok: false, reason: "no GITHUB_REPO configured" };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const branch = opts.branch ?? "v1/strip-back-pr1";

  const issueNumber = await findIssueByReportId({
    reportId: opts.reportId,
    repo: opts.repo,
    token: opts.token,
    fetchImpl
  });
  if (issueNumber === null) {
    return { ok: false, reason: `could not find issue for ${opts.reportId}` };
  }

  const uploadedUrls: string[] = [];
  for (let i = 0; i < opts.screenshots.length; i += 1) {
    const s = opts.screenshots[i]!;
    const ext = extFromMime(s.mimeType);
    const path = `pilot-feedback-attachments/${opts.reportId}-${i + 1}.${ext}`;
    const url = await uploadScreenshotToRepo({
      repo: opts.repo,
      branch,
      token: opts.token,
      path,
      base64: s.base64,
      commitMessage: `chore(pilot-feedback): attach screenshot for ${opts.reportId}`,
      fetchImpl
    });
    if (url) uploadedUrls.push(url);
  }

  if (uploadedUrls.length === 0) {
    return { ok: false, reason: "all screenshot uploads failed", issueNumber };
  }

  const commentBody = uploadedUrls
    .map((url, i) => `**Screenshot ${i + 1}** (auto-attached from pilot-feedback report ${opts.reportId})\n\n![Screenshot ${i + 1}](${url})`)
    .join("\n\n");

  const commentUrl = await postIssueComment({
    repo: opts.repo,
    issueNumber,
    body: commentBody,
    token: opts.token,
    fetchImpl
  });

  return {
    ok: Boolean(commentUrl),
    issueNumber,
    uploadedUrls,
    commentUrl: commentUrl ?? undefined,
    reason: commentUrl ? undefined : "comment post failed (screenshots uploaded but not linked)"
  };
}
