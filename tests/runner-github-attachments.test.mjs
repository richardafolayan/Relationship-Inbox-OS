import test from "node:test";
import assert from "node:assert/strict";
import {
  attachScreenshotsToIssue,
  findIssueByReportId,
  postIssueComment,
  uploadScreenshotToRepo
} from "../apps/runner/dist/services/github-attachments.js";

// Issue #394 follow-up. Pilot screenshots live in column W of the
// feedback Google Sheet (auth-walled) and aren't visible from the
// GitHub issue an agent picks up to triage. This service uploads each
// screenshot into the repo under pilot-feedback-attachments/ and
// posts an issue comment with inline image refs. These tests use
// injected fetch stubs — no live HTTP.

function makeFetchStub(handlers) {
  // handlers: array of (url, init) → { ok, status, json | text } in order called.
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

// ── findIssueByReportId ───────────────────────────────────────────────

test("findIssueByReportId: returns issue number on first hit", async () => {
  const fetchImpl = makeFetchStub([
    (url) => {
      assert.match(url, /search\/issues/);
      assert.match(url, /R-0045/);
      return {
        ok: true,
        json: { items: [{ number: 416, title: "[Pilot feedback] Wrong gender (R-0045)" }] }
      };
    }
  ]);
  const n = await findIssueByReportId({
    reportId: "R-0045",
    repo: "owner/name",
    token: "t",
    fetchImpl,
    attempts: 1
  });
  assert.equal(n, 416);
});

test("findIssueByReportId: retries when first search misses", async () => {
  const fetchImpl = makeFetchStub([
    () => ({ ok: true, json: { items: [] } }),
    () => ({ ok: true, json: { items: [{ number: 7, title: "Foo (R-0099)" }] } })
  ]);
  const n = await findIssueByReportId({
    reportId: "R-0099",
    repo: "owner/name",
    token: "t",
    fetchImpl,
    attempts: 2,
    delayMs: 1
  });
  assert.equal(n, 7);
  assert.equal(fetchImpl.calls.length, 2);
});

test("findIssueByReportId: returns null when no match after retries", async () => {
  const fetchImpl = makeFetchStub([
    () => ({ ok: true, json: { items: [] } }),
    () => ({ ok: true, json: { items: [] } })
  ]);
  const n = await findIssueByReportId({
    reportId: "R-XXXX",
    repo: "owner/name",
    token: "t",
    fetchImpl,
    attempts: 2,
    delayMs: 1
  });
  assert.equal(n, null);
});

// ── uploadScreenshotToRepo ────────────────────────────────────────────

test("uploadScreenshotToRepo: PUT contents API + returns raw URL on success", async () => {
  const fetchImpl = makeFetchStub([
    // GET existing-file probe — 404 means a fresh create (no sha).
    (url, init) => {
      assert.equal(init.method, "GET");
      assert.match(url, /ref=main/);
      return { ok: false, status: 404 };
    },
    (url, init) => {
      assert.match(url, /\/repos\/owner\/name\/contents\/pilot-feedback-attachments\/R-1-1\.png/);
      assert.equal(init.method, "PUT");
      const body = JSON.parse(init.body);
      assert.equal(body.branch, "main");
      assert.equal(body.content, "aGVsbG8=");
      assert.match(body.message, /R-1/);
      return { ok: true, json: { content: { path: "pilot-feedback-attachments/R-1-1.png" } } };
    }
  ]);
  const url = await uploadScreenshotToRepo({
    repo: "owner/name",
    branch: "main",
    token: "t",
    path: "pilot-feedback-attachments/R-1-1.png",
    base64: "aGVsbG8=",
    commitMessage: "chore(pilot-feedback): attach screenshot for R-1",
    fetchImpl
  });
  assert.equal(url, "https://raw.githubusercontent.com/owner/name/main/pilot-feedback-attachments/R-1-1.png");
});

test("uploadScreenshotToRepo: returns null on upload failure", async () => {
  const fetchImpl = makeFetchStub([
    // GET probe — file doesn't exist (404), so this is a create.
    () => ({ ok: false, status: 404 }),
    // PUT create still fails with a genuine 422.
    () => ({ ok: false, status: 422 })
  ]);
  const url = await uploadScreenshotToRepo({
    repo: "owner/name",
    branch: "main",
    token: "t",
    path: "x.png",
    base64: "aGVsbG8=",
    commitMessage: "x",
    fetchImpl
  });
  assert.equal(url, null);
});

// ── postIssueComment ──────────────────────────────────────────────────

test("postIssueComment: posts + returns html_url on success", async () => {
  const fetchImpl = makeFetchStub([
    (url, init) => {
      assert.match(url, /\/repos\/owner\/name\/issues\/42\/comments/);
      assert.equal(init.method, "POST");
      const body = JSON.parse(init.body);
      assert.equal(body.body, "hi");
      return { ok: true, json: { html_url: "https://github.com/owner/name/issues/42#comment-1" } };
    }
  ]);
  const url = await postIssueComment({
    repo: "owner/name",
    issueNumber: 42,
    body: "hi",
    token: "t",
    fetchImpl
  });
  assert.equal(url, "https://github.com/owner/name/issues/42#comment-1");
});

// ── attachScreenshotsToIssue (orchestrator) ───────────────────────────

test("attachScreenshotsToIssue: skips when token absent", async () => {
  const result = await attachScreenshotsToIssue({
    reportId: "R-1",
    screenshots: [{ name: "x.png", mimeType: "image/png", base64: "aGk=" }],
    repo: "owner/name",
    token: ""
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no GITHUB_TOKEN/);
});

test("attachScreenshotsToIssue: skips when screenshots empty", async () => {
  const result = await attachScreenshotsToIssue({
    reportId: "R-1",
    screenshots: [],
    repo: "owner/name",
    token: "t"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no screenshots");
});

test("attachScreenshotsToIssue: end-to-end happy path posts comment with inline images", async () => {
  const fetchImpl = makeFetchStub([
    // search
    () => ({ ok: true, json: { items: [{ number: 99, title: "(R-2050)" }] } }),
    // GET probe for screenshot 1 — fresh create (404)
    () => ({ ok: false, status: 404 }),
    // upload screenshot 1
    (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.branch, "v1/strip-back-pr1");
      assert.equal(body.sha, undefined);
      return { ok: true, json: { content: {} } };
    },
    // GET probe for screenshot 2 — fresh create (404)
    () => ({ ok: false, status: 404 }),
    // upload screenshot 2
    (_url, init) => {
      const body = JSON.parse(init.body);
      assert.match(body.message, /R-2050/);
      return { ok: true, json: { content: {} } };
    },
    // post comment
    (url, init) => {
      assert.match(url, /\/issues\/99\/comments/);
      const body = JSON.parse(init.body);
      // Inline image markdown for both uploads
      assert.match(body.body, /Screenshot 1.*raw\.githubusercontent\.com.*R-2050-1\.png/s);
      assert.match(body.body, /Screenshot 2.*R-2050-2\.jpg/s);
      return { ok: true, json: { html_url: "https://github.com/owner/name/issues/99#c-1" } };
    }
  ]);
  const result = await attachScreenshotsToIssue({
    reportId: "R-2050",
    screenshots: [
      { name: "first.png", mimeType: "image/png", base64: "AAAA" },
      { name: "second.jpg", mimeType: "image/jpeg", base64: "BBBB" }
    ],
    repo: "owner/name",
    token: "t",
    fetchImpl
  });
  assert.equal(result.ok, true);
  assert.equal(result.issueNumber, 99);
  assert.equal(result.uploadedUrls?.length, 2);
  assert.match(result.commentUrl ?? "", /#c-1/);
});

test("attachScreenshotsToIssue: reports a clean failure when issue not found", async () => {
  // findIssueByReportId retries up to 5 times by default; stub returns
  // empty results for each so the search exhausts and the orchestrator
  // returns its "could not find issue" outcome.
  const emptySearch = () => ({ ok: true, json: { items: [] } });
  const fetchImpl = makeFetchStub([
    emptySearch,
    emptySearch,
    emptySearch,
    emptySearch,
    emptySearch
  ]);
  const result = await attachScreenshotsToIssue({
    reportId: "R-NEVER",
    screenshots: [{ name: "x.png", mimeType: "image/png", base64: "AAAA" }],
    repo: "owner/name",
    token: "t",
    fetchImpl
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /could not find issue/);
});

test("attachScreenshotsToIssue: returns false when all uploads fail", async () => {
  const fetchImpl = makeFetchStub([
    () => ({ ok: true, json: { items: [{ number: 5, title: "(R-X)" }] } }),
    // GET probe — fresh create (404)
    () => ({ ok: false, status: 404 }),
    // PUT create still fails (genuine 422)
    () => ({ ok: false, status: 422 })
  ]);
  const result = await attachScreenshotsToIssue({
    reportId: "R-X",
    screenshots: [{ name: "x.png", mimeType: "image/png", base64: "AAAA" }],
    repo: "owner/name",
    token: "t",
    fetchImpl
  });
  assert.equal(result.ok, false);
  assert.equal(result.issueNumber, 5);
  assert.match(result.reason ?? "", /all screenshot uploads failed/);
});
