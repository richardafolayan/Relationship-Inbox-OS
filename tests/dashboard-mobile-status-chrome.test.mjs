import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const {
  resolveMobileStatusChrome,
  shouldSurfaceHiddenStatus
} = await import("../apps/dashboard/lib/mobile-status-chrome.ts");

const shellSrc = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "app-shell.tsx"),
  "utf8"
);
const topStatusSrc = readFileSync(
  join(__dirname, "..", "apps", "dashboard", "components", "layout", "top-status.tsx"),
  "utf8"
);

test("Today uses compact mobile status chrome", () => {
  assert.equal(resolveMobileStatusChrome("/today"), "compact");
  assert.equal(resolveMobileStatusChrome("/today/"), "compact");
});

test("Inbox uses compact mobile status chrome", () => {
  assert.equal(resolveMobileStatusChrome("/inbox"), "compact");
  assert.equal(resolveMobileStatusChrome("/inbox/"), "compact");
});

test("secondary screens hide the full status row by default", () => {
  for (const path of [
    "/thread/abc",
    "/thread/person%3A1",
    "/archived",
    "/archived/",
    "/reconnect",
    "/reconnect/",
    "/settings",
    "/settings#platforms",
    "/search",
    "/search/"
  ]) {
    assert.equal(
      resolveMobileStatusChrome(path.split("#")[0]),
      "hidden",
      `${path} should hide full mobile chrome`
    );
  }
});

test("/search is a hidden secondary route, not compact chrome", () => {
  assert.equal(resolveMobileStatusChrome("/search"), "hidden");
  assert.equal(resolveMobileStatusChrome("/search/"), "hidden");
  assert.notEqual(resolveMobileStatusChrome("/search"), "compact");
});

test("other list routes stay compact rather than full", () => {
  assert.equal(resolveMobileStatusChrome("/people"), "compact");
  assert.equal(resolveMobileStatusChrome("/at-risk"), "compact");
  assert.equal(resolveMobileStatusChrome("/platforms"), "compact");
  assert.equal(resolveMobileStatusChrome("/logs"), "compact");
});

test("null or empty path defaults to full", () => {
  assert.equal(resolveMobileStatusChrome(null), "full");
  assert.equal(resolveMobileStatusChrome(undefined), "full");
  assert.equal(resolveMobileStatusChrome(""), "full");
});

test("hidden chrome stays suppressed when healthy and idle", () => {
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: false,
      hasDegraded: false,
      tickerKind: "idle"
    }),
    false
  );
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: false,
      hasDegraded: false,
      tickerKind: "send_succeeded"
    }),
    false
  );
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: false,
      hasDegraded: false,
      tickerKind: "thread_checked"
    }),
    false
  );
});

test("hidden chrome does not flash Connecting before ready", () => {
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: false,
      runnerOffline: false,
      hasDegraded: false,
      tickerKind: "idle"
    }),
    false
  );
});

test("hidden chrome surfaces degraded platforms", () => {
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: false,
      hasDegraded: true,
      tickerKind: "idle"
    }),
    true
  );
});

test("hidden chrome surfaces runner offline", () => {
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: true,
      hasDegraded: false,
      tickerKind: "idle"
    }),
    true
  );
});

test("hidden chrome surfaces in-flight and failed work", () => {
  for (const tickerKind of [
    "scanning",
    "sending",
    "enriching",
    "reassessing",
    "sending_report",
    "checking_thread",
    "send_failed"
  ]) {
    assert.equal(
      shouldSurfaceHiddenStatus({
        ready: true,
        runnerOffline: false,
        hasDegraded: false,
        tickerKind
      }),
      true,
      `${tickerKind} should re-surface the status row`
    );
  }
});

test("Search hidden chrome still re-surfaces offline, degraded, and in-flight", () => {
  assert.equal(resolveMobileStatusChrome("/search"), "hidden");
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: true,
      hasDegraded: false,
      tickerKind: "idle"
    }),
    true,
    "offline on Search should re-surface the attention strip"
  );
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: false,
      hasDegraded: true,
      tickerKind: "idle"
    }),
    true,
    "degraded platforms on Search should re-surface the attention strip"
  );
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: false,
      hasDegraded: false,
      tickerKind: "scanning"
    }),
    true,
    "in-flight scan on Search should re-surface the attention strip"
  );
  assert.equal(
    shouldSurfaceHiddenStatus({
      ready: true,
      runnerOffline: false,
      hasDegraded: false,
      tickerKind: "idle"
    }),
    false,
    "healthy idle Search stays chrome-free"
  );
});

test("Search forceSurface stays true; pilot-visible stacking lives with Search UI (#903)", () => {
  // Helper contract: /search is hidden and forceSurface still fires for
  // offline/degraded/in-flight. Dedicated Search is a full-viewport overlay
  // above TopStatus, so the pilot-visible strip is the in-search attention
  // banner owned by #903 (data-mobile-search-attention), not TopStatus alone.
  assert.equal(resolveMobileStatusChrome("/search"), "hidden");
  assert.equal(resolveMobileStatusChrome("/search/"), "hidden");
  const forceOffline = shouldSurfaceHiddenStatus({
    ready: true,
    runnerOffline: true,
    hasDegraded: false,
    tickerKind: "idle"
  });
  const forceDegraded = shouldSurfaceHiddenStatus({
    ready: true,
    runnerOffline: false,
    hasDegraded: true,
    tickerKind: "idle"
  });
  const forceScanning = shouldSurfaceHiddenStatus({
    ready: true,
    runnerOffline: false,
    hasDegraded: false,
    tickerKind: "scanning"
  });
  assert.equal(forceOffline, true);
  assert.equal(forceDegraded, true);
  assert.equal(forceScanning, true);
  assert.match(
    shellSrc,
    /resolveMobileStatusChrome/,
    "shell still wires chrome resolution for forceSurface on all routes including /search"
  );
  assert.match(
    topStatusSrc,
    /shouldSurfaceHiddenStatus/,
    "TopStatus still evaluates forceSurface; /search stacking fix is Search UI"
  );
  // Document the overlay z-order constraint in the chrome helper so future
  // reviewers do not assume TopStatus alone is enough on /search.
  const chromeHelperSrc = readFileSync(
    join(__dirname, "..", "apps", "dashboard", "lib", "mobile-status-chrome.ts"),
    "utf8"
  );
  assert.match(chromeHelperSrc, /in-search attention banner/);
  assert.match(chromeHelperSrc, /z-90|z-\[90\]|overlay/);
});

test("app shell wires resolveMobileStatusChrome into TopStatus", () => {
  assert.match(shellSrc, /resolveMobileStatusChrome/);
  assert.match(shellSrc, /mobileChrome=\{mobileStatusChrome\}/);
  assert.match(shellSrc, /const mobileStatusChrome = useMemo/);
});

test("TopStatus hides suppressed chrome below md and keeps desktop full", () => {
  assert.match(topStatusSrc, /mobileChrome\s*=\s*"full"/);
  assert.match(topStatusSrc, /shouldSurfaceHiddenStatus/);
  assert.match(topStatusSrc, /hideOnMobile && "hidden md:flex"/);
  assert.match(topStatusSrc, /data-mobile-chrome=\{mobileChrome\}/);
  assert.match(topStatusSrc, /data-mobile-surface=/);
  assert.match(topStatusSrc, /attentionOnlyMobile/);
  assert.match(topStatusSrc, /compactMobile/);
});

test("TopStatus still routes degraded platforms to settings", () => {
  assert.match(
    topStatusSrc,
    /\) : hasDegraded \? \(\s*<Link\s+href="\/settings#platforms"/,
    "degraded platforms should keep the stripped v1 settings link"
  );
});

test("compact mobile chrome prioritises notifications and one-tap pilot feedback", () => {
  assert.match(topStatusSrc, /openPilotFeedback\("feedback"\)/);
  assert.match(topStatusSrc, /aria-label="Send feedback"/);
  assert.match(topStatusSrc, /\(attentionOnlyMobile \|\| compactMobile\) && "hidden md:inline-flex"/);
  assert.match(topStatusSrc, /\(attentionOnlyMobile \|\| compactMobile\) && "hidden md:inline"/);
});
