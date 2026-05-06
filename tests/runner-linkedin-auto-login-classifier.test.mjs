import test from "node:test";
import assert from "node:assert/strict";
import { classifyPostLoginUrl } from "../apps/runner/dist/platforms/linkedin-adapter.js";

// LinkedIn's login flow has three terminal states from the runner's
// perspective: success (URL moved off /login surfaces), still-on-login (form
// rejected, error rendered), and verification (CAPTCHA / 2FA / checkpoint).
// `classifyPostLoginUrl` pins the URL regex set so a LinkedIn URL rotation
// surfaces in tests rather than at runtime against a real session.

test("classifyPostLoginUrl flags checkpoint URLs as verification", () => {
  assert.equal(
    classifyPostLoginUrl("https://www.linkedin.com/checkpoint/lg/login-submit"),
    "verification"
  );
  assert.equal(
    classifyPostLoginUrl("https://www.linkedin.com/checkpoint/challenge/AgEAA..."),
    "verification"
  );
});

test("classifyPostLoginUrl flags authwall as verification", () => {
  assert.equal(classifyPostLoginUrl("https://www.linkedin.com/authwall"), "verification");
});

test("classifyPostLoginUrl flags captcha URLs as verification", () => {
  assert.equal(
    classifyPostLoginUrl("https://www.linkedin.com/captcha/challenge"),
    "verification"
  );
});

test("classifyPostLoginUrl prefers verification over still_on_login when both match", () => {
  // /uas/login-submit literally contains /uas/ which still_on_login would
  // also match — but it's a verification URL, not a re-render of the form.
  // The classifier must run verification first so this URL gets the
  // conservative verdict.
  const url = "https://www.linkedin.com/uas/login-submit?session_redirect=...";
  assert.equal(classifyPostLoginUrl(url), "verification");
});

test("classifyPostLoginUrl flags re-rendered login form as still_on_login", () => {
  assert.equal(
    classifyPostLoginUrl("https://www.linkedin.com/login?error=invalid_credentials"),
    "still_on_login"
  );
  assert.equal(
    classifyPostLoginUrl("https://www.linkedin.com/uas/login?session_redirect=..."),
    "still_on_login"
  );
});

test("classifyPostLoginUrl returns ok when URL moved to feed or messaging", () => {
  assert.equal(classifyPostLoginUrl("https://www.linkedin.com/feed/"), "ok");
  assert.equal(
    classifyPostLoginUrl("https://www.linkedin.com/messaging/thread/2-foo=="),
    "ok"
  );
});

test("classifyPostLoginUrl handles empty and non-string input gracefully", () => {
  assert.equal(classifyPostLoginUrl(""), "ok");
  // @ts-expect-error — runtime safety: undefined URL must not throw.
  assert.equal(classifyPostLoginUrl(undefined), "ok");
  // @ts-expect-error — same for null.
  assert.equal(classifyPostLoginUrl(null), "ok");
});
