import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAllowedProfileUrl,
  isAllowedProfileUrl,
  ProfileUrlPolicyError
} from "../apps/runner/dist/services/profile-url-policy.js";

// Regression for BUG PH7: /control/person/:personId/profile-url persisted any
// z.string().url() value, which was later navigated to in the runner's
// authenticated Chrome (openProfileUrl + the enrichment auto-visit). A bare URL
// string accepts file://, view-source:, data:, link-local and intranet hosts —
// a stored SSRF / local-file read. The policy pins navigable profile URLs to
// https/http on the platform's allowlisted host (linkedin.com for LinkedIn).

test("PH7: accepts https LinkedIn profile URLs and returns the normalised form", () => {
  for (const url of [
    "https://www.linkedin.com/in/some-person",
    "https://linkedin.com/in/some-person/",
    "https://uk.linkedin.com/in/some-person",
    "http://www.linkedin.com/in/some-person"
  ]) {
    assert.equal(isAllowedProfileUrl(url, "LINKEDIN"), true, `expected allowed: ${url}`);
    // parse returns a normalised absolute URL (here it round-trips to itself).
    assert.equal(parseAllowedProfileUrl(url, "LINKEDIN"), new URL(url).toString());
  }
});

test("PH7: rejects non-http(s) schemes navigated in the authenticated browser", () => {
  for (const url of [
    "file:///etc/passwd",
    "file://localhost/etc/shadow",
    "view-source:https://www.linkedin.com/in/some-person",
    "data:text/html,<script>1</script>",
    "javascript:alert(1)",
    "ftp://www.linkedin.com/in/some-person"
  ]) {
    assert.equal(isAllowedProfileUrl(url, "LINKEDIN"), false, `expected rejected: ${url}`);
    assert.throws(() => parseAllowedProfileUrl(url, "LINKEDIN"), ProfileUrlPolicyError, url);
  }
});

test("PH7: rejects off-allowlist hosts (SSRF / intranet / link-local / look-alike)", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:4001/control/scan",
    "http://127.0.0.1/admin",
    "http://intranet.internal/secret",
    "http://10.0.0.5/",
    // look-alikes that must NOT satisfy the linkedin.com suffix check
    "https://linkedin.com.evil.test/in/x",
    "https://evil-linkedin.com/in/x",
    "https://notlinkedin.com/in/x"
  ]) {
    assert.equal(isAllowedProfileUrl(url, "LINKEDIN"), false, `expected rejected: ${url}`);
    assert.throws(() => parseAllowedProfileUrl(url, "LINKEDIN"), ProfileUrlPolicyError, url);
  }
});

test("PH7: rejects empty / non-absolute / garbage values", () => {
  for (const url of ["", "   ", "not a url", "/in/relative-only", "linkedin.com/in/no-scheme"]) {
    assert.equal(isAllowedProfileUrl(url, "LINKEDIN"), false, `expected rejected: ${JSON.stringify(url)}`);
    assert.throws(() => parseAllowedProfileUrl(url, "LINKEDIN"), ProfileUrlPolicyError);
  }
});

test("PH7: platforms with no navigable-profile allowlist are denied by default", () => {
  // iMessage persons have no browser profile to open; a stored URL must never
  // be treated as navigable for them.
  assert.equal(isAllowedProfileUrl("https://www.linkedin.com/in/x", "IMESSAGE"), false);
  assert.throws(() => parseAllowedProfileUrl("https://www.linkedin.com/in/x", "IMESSAGE"), ProfileUrlPolicyError);
});
