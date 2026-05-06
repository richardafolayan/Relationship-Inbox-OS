import test from "node:test";
import assert from "node:assert/strict";
import { isLinkedInAuthRequiredUrl } from "../apps/runner/dist/platforms/linkedin-adapter.js";

// `isLinkedInAuthRequiredUrl` is the gate that triggers password auto-login.
// Before this regex was broadened, only /uas/login matched — a current
// /login/?session_redirect=... redirect slipped through, detectAuthRequired
// returned authRequired:false, no auto-login fired, and the runner blamed
// a "selector mismatch" instead. These cases pin the surfaces LinkedIn
// rotates through so a future change has to update them deliberately.

test("the bare /login/ redirect that broke auto-login is detected", () => {
  assert.equal(
    isLinkedInAuthRequiredUrl("https://www.linkedin.com/login/?session_redirect=https%3A%2F%2Fwww.linkedin.com%2Fmessaging%2F"),
    true
  );
});

test("trailing-slash and query-string variants of /login", () => {
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/login"), true);
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/login/"), true);
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/login?error=invalid"), true);
});

test("legacy /uas/* surfaces still match", () => {
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/uas/login"), true);
  assert.equal(
    isLinkedInAuthRequiredUrl("https://www.linkedin.com/uas/login-submit?session_redirect=..."),
    true
  );
});

test("verification gates (checkpoint/authwall/captcha) match", () => {
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/checkpoint/lg/login-submit"), true);
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/checkpoint/challenge/AgEAA..."), true);
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/authwall"), true);
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/captcha/challenge"), true);
});

test("normal messaging / feed URLs do NOT match", () => {
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/messaging/"), false);
  assert.equal(
    isLinkedInAuthRequiredUrl("https://www.linkedin.com/messaging/thread/2-MjkxYmIz..."),
    false
  );
  assert.equal(isLinkedInAuthRequiredUrl("https://www.linkedin.com/feed/"), false);
});

test("empty / non-string input is safe", () => {
  assert.equal(isLinkedInAuthRequiredUrl(""), false);
  // @ts-expect-error — runtime safety: undefined must not throw.
  assert.equal(isLinkedInAuthRequiredUrl(undefined), false);
  // @ts-expect-error — same for null.
  assert.equal(isLinkedInAuthRequiredUrl(null), false);
});
