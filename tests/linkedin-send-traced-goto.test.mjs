import test from "node:test";
import assert from "node:assert/strict";
import { LinkedInAdapter } from "../apps/runner/dist/platforms/linkedin-adapter.js";

// Regression for: sendMessage navigated to the thread with a raw page.goto
// instead of the tracedGoto wrapper. LinkedIn's SPA frequently aborts the
// full navigation (net::ERR_ABORTED / "frame was detached") when its in-page
// router intercepts the same URL — the destination is usually already
// committed under us. tracedGoto tolerates that with a single retry; a raw
// page.goto throws and fails the send. These tests pin tracedGoto's
// abort-tolerance contract so the send path (now routed through it) stays
// resilient and a future change can't silently drop the tolerance.
//
// tracedGoto only touches the supplied page + an internal trace wrapper that
// short-circuits when no RunLogger is attached (the default), so a
// dependency-less adapter instance with a fake Page fully exercises it.

function makeFakePage({ failFirstWith = null, failAlwaysWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async goto(url, opts) {
      calls.push({ url, opts });
      if (failAlwaysWith) {
        throw new Error(failAlwaysWith);
      }
      if (failFirstWith && calls.length === 1) {
        throw new Error(failFirstWith);
      }
      return null;
    },
    async waitForTimeout() {},
    url() {
      return "https://www.linkedin.com/messaging/thread/abc/";
    }
  };
}

test("tracedGoto tolerates a LinkedIn SPA ERR_ABORTED with a single retry", async () => {
  const adapter = new LinkedInAdapter({});
  const page = makeFakePage({
    failFirstWith: "page.goto: net::ERR_ABORTED at https://www.linkedin.com/messaging/thread/abc/"
  });

  // Must NOT throw — the abort is swallowed and the navigation is retried.
  await adapter.tracedGoto(page, "https://www.linkedin.com/messaging/thread/abc/", {
    stage: "send_message",
    note: "send_open_by_thread_url"
  });

  assert.equal(page.calls.length, 2, "expected exactly one retry after the abort");
});

test("tracedGoto tolerates a detached-frame navigation abort", async () => {
  const adapter = new LinkedInAdapter({});
  const page = makeFakePage({ failFirstWith: "Navigation failed because frame was detached" });

  await adapter.tracedGoto(page, "https://www.linkedin.com/messaging/", {});

  assert.equal(page.calls.length, 2, "expected exactly one retry after the detached-frame abort");
});

test("tracedGoto re-throws a genuine navigation error (no false tolerance)", async () => {
  const adapter = new LinkedInAdapter({});
  const page = makeFakePage({ failAlwaysWith: "page.goto: net::ERR_NAME_NOT_RESOLVED" });

  await assert.rejects(
    adapter.tracedGoto(page, "https://www.linkedin.com/messaging/", {}),
    /ERR_NAME_NOT_RESOLVED/,
    "non-abort errors must surface, not be swallowed as an abort"
  );
  assert.equal(page.calls.length, 1, "a real error should not trigger the abort retry");
});
