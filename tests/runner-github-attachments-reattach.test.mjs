import test from "node:test";
import assert from "node:assert/strict";
import {
  attachScreenshotsToIssue,
  uploadScreenshotToRepo
} from "../apps/runner/dist/services/github-attachments.js";

// Regression for the re-attach bug (bug-sweep P1-L5). The attachment
// path is deterministic per reportId
// (pilot-feedback-attachments/<reportId>-<n>.<ext>), so a duplicate
// Apps Script webhook, or a retry after the first run's comment post
// failed, re-attaches the SAME path. GitHub's Contents API rejects a
// PUT to an existing path with HTTP 422 unless the current blob `sha`
// is supplied. The fix GETs the path first and includes `sha` to
// update in place, so the second run succeeds and the issue comment is
// still posted. These tests use injected fetch stubs — no live HTTP.

function makeFetchStub(handlers) {
  let callIndex = 0;
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const handler = handlers[callIndex++];
    if (!handler) throw new Error(`unexpected fetch call: ${url}`);
    const result = await handler(String(url), init);
    return {
      ok: result.ok,
      status: result.status ?? (result.ok ? 200 : 500),
      json: async () => result.json,
      text: async () => result.text ?? ""
    };
  };
  fn.calls = calls;
  return fn;
}

test("uploadScreenshotToRepo: existing path -> sends sha and updates in place", async () => {
  const fetchImpl = makeFetchStub([
    // GET probe finds the existing blob and returns its sha.
    (url, init) => {
      assert.equal(init.method, "GET");
      assert.match(url, /\/contents\/pilot-feedback-attachments\/R-7-1\.png/);
      assert.match(url, /ref=main/);
      return { ok: true, json: { sha: "deadbeefsha", path: "pilot-feedback-attachments/R-7-1.png" } };
    },
    // PUT must now carry the sha so GitHub updates rather than 422s.
    (url, init) => {
      assert.equal(init.method, "PUT");
      const body = JSON.parse(init.body);
      assert.equal(body.sha, "deadbeefsha");
      assert.equal(body.content, "aGVsbG8=");
      return { ok: true, json: { content: {} } };
    }
  ]);
  const url = await uploadScreenshotToRepo({
    repo: "owner/name",
    branch: "main",
    token: "t",
    path: "pilot-feedback-attachments/R-7-1.png",
    base64: "aGVsbG8=",
    commitMessage: "chore(pilot-feedback): attach screenshot for R-7",
    fetchImpl
  });
  // Before the fix the bare PUT (no sha) 422-failed and this returned null.
  assert.equal(url, "https://raw.githubusercontent.com/owner/name/main/pilot-feedback-attachments/R-7-1.png");
});

test("attachScreenshotsToIssue: re-attach of an existing reportId still posts the comment", async () => {
  const fetchImpl = makeFetchStub([
    // search finds the issue
    () => ({ ok: true, json: { items: [{ number: 321, title: "(R-9090)" }] } }),
    // GET probe — the screenshot already exists from the first run
    () => ({ ok: true, json: { sha: "existingsha123" } }),
    // PUT updates in place using the sha
    (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.sha, "existingsha123");
      return { ok: true, json: { content: {} } };
    },
    // comment posts with the inline image
    (url, init) => {
      assert.match(url, /\/issues\/321\/comments/);
      const body = JSON.parse(init.body);
      assert.match(body.body, /Screenshot 1.*R-9090-1\.png/s);
      return { ok: true, json: { html_url: "https://github.com/owner/name/issues/321#c-9" } };
    }
  ]);
  const result = await attachScreenshotsToIssue({
    reportId: "R-9090",
    screenshots: [{ name: "x.png", mimeType: "image/png", base64: "AAAA" }],
    repo: "owner/name",
    token: "t",
    fetchImpl
  });
  // Before the fix this returned { ok:false, reason:'all screenshot uploads failed' }
  // with no comment, because the bare PUT 422-failed on the existing path.
  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 321);
  assert.equal(result.uploadedUrls?.length, 1);
  assert.match(result.commentUrl ?? "", /#c-9/);
});
