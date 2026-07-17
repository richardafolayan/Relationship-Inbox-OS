import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  shouldDiscloseReconnectReason,
  RECONNECT_REASON_INLINE_MAX,
  RECONNECT_SCROLL_KEY
} = await import("../apps/dashboard/lib/reconnect.ts");

const pageSource = readFileSync(
  new URL("../apps/dashboard/app/reconnect/page.tsx", import.meta.url),
  "utf8"
);

test("short AI reasons stay inline; long ones require disclosure", () => {
  assert.equal(shouldDiscloseReconnectReason(null), false);
  assert.equal(shouldDiscloseReconnectReason(""), false);
  assert.equal(shouldDiscloseReconnectReason("   "), false);
  assert.equal(shouldDiscloseReconnectReason("You last spoke about work"), false);

  const exactlyMax = "x".repeat(RECONNECT_REASON_INLINE_MAX);
  assert.equal(shouldDiscloseReconnectReason(exactlyMax), false);

  const justOver = "x".repeat(RECONNECT_REASON_INLINE_MAX + 1);
  assert.equal(shouldDiscloseReconnectReason(justOver), true);

  const longReason =
    "You last spoke about their new role and offered to intro them to a hiring manager on your team next quarter.";
  assert.ok(longReason.length > RECONNECT_REASON_INLINE_MAX);
  assert.equal(shouldDiscloseReconnectReason(longReason), true);
});

test("Reconnect rows use compact two-level scanning layout", () => {
  // Name truncates, preview truncates, elapsed sits on the right as duration only.
  assert.match(pageSource, /data-testid="reconnect-row-name"/);
  assert.match(pageSource, /data-testid="reconnect-row-preview"/);
  assert.match(pageSource, /data-testid="reconnect-row-elapsed"/);
  assert.match(pageSource, /className="[^"]*truncate[^"]*"/);
  assert.match(pageSource, /min-h-\[56px\]/);
  // Compact elapsed, not the old "quiet for Nd" permanent label.
  assert.match(pageSource, /data-testid="reconnect-row-elapsed"/);
  assert.doesNotMatch(pageSource, /quiet for \{quietFor\}/);
});

test("long AI reasons are progressively disclosed", () => {
  assert.match(pageSource, /Why this person\?/);
  assert.match(pageSource, /Hide reason/);
  assert.match(pageSource, /shouldDiscloseReconnectReason/);
  assert.match(pageSource, /data-testid="reconnect-row-why"/);
  // Disclosure toggle must not navigate away from the list.
  assert.match(pageSource, /stopPropagation/);
});

test("Suggested reconnects are visually distinct from ordinary rows", () => {
  assert.match(pageSource, /data-testid="reconnect-row-suggested"/);
  assert.match(pageSource, /data-suggested=\{suggested \? "true" : "false"\}/);
  assert.match(pageSource, /border-l-accent/);
});

test("Refresh scores is a clear action with loading and result feedback", () => {
  // Sentence case, not developer-style mono uppercase "REFRESH AI SCORES".
  assert.match(pageSource, /return "Refresh scores"/);
  assert.match(pageSource, /return "Scoring…"/);
  assert.match(pageSource, /data-testid="reconnect-refresh-scores"/);
  assert.match(pageSource, /aria-busy=\{refresh_state\.kind === "running"\}/);
  assert.match(pageSource, /Loader2/);
  assert.match(pageSource, /min-h-\[44px\]/);
  // One control for all breakpoints (no separate mono-uppercase mobile clone).
  assert.doesNotMatch(pageSource, /reconnect-refresh-scores-mobile/);
  assert.doesNotMatch(pageSource, /uppercase tracking-\[0\.06em\].*Refresh/);
});

test("opening a thread preserves list scroll position on return", () => {
  assert.equal(RECONNECT_SCROLL_KEY, "reconnect-list-scroll");
  assert.match(pageSource, /RECONNECT_SCROLL_KEY/);
  assert.match(pageSource, /sessionStorage/);
  assert.match(pageSource, /writeScrollY/);
  assert.match(pageSource, /onNavigate/);
  // AppShell scrolls <main>, not the document. Reading document scroll would
  // always see 0 and fail the "preserves list position" acceptance criterion.
  assert.match(pageSource, /querySelector\(["']main["']\)/);
  assert.match(pageSource, /scrollTop/);
  assert.match(pageSource, /getListScroller/);
  assert.match(pageSource, /captureListScrollY/);
  assert.match(pageSource, /restoreListScrollY/);
  // Reject the previous window-only approach (must fail if someone reverts to it).
  assert.doesNotMatch(pageSource, /window\.scrollTo\s*\(/);
  assert.doesNotMatch(pageSource, /window\.scrollY\b/);
});

test("first viewport keeps explanation concise so people stay visible", () => {
  assert.match(pageSource, /LinkedIn people who went quiet/);
  assert.match(pageSource, /reconnect-about-toggle/);
  // Long exclusion copy is not the default subtitle.
  assert.doesNotMatch(
    pageSource,
    /subtitle="LinkedIn catch-ups only\. iMessage replies stay in Today and Inbox, where they are treated as active conversations/
  );
});
