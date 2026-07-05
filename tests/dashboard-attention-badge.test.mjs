import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// attention-badge.ts is framework-free, so the tsx loader resolves this .ts
// import directly (same pattern as dashboard-clean-ask-summary.test.mjs).
const { formatAttentionBadge, ATTENTION_BADGE_CAP } = await import(
  "../apps/dashboard/lib/attention-badge.ts"
);

// Pilot R-0089 (#756): the sidebar/dock Today marker shows the needs-reply
// count, capped at 99+.

test("zero and negative counts render nothing", () => {
  assert.equal(formatAttentionBadge(0), "");
  assert.equal(formatAttentionBadge(-3), "");
  assert.equal(formatAttentionBadge(NaN), "");
  assert.equal(formatAttentionBadge(Infinity), "");
});

test("counts within the cap render as-is", () => {
  assert.equal(formatAttentionBadge(1), "1");
  assert.equal(formatAttentionBadge(42), "42");
  assert.equal(formatAttentionBadge(99), "99");
});

test("counts beyond the cap clamp to 99+", () => {
  assert.equal(ATTENTION_BADGE_CAP, 99);
  assert.equal(formatAttentionBadge(100), "99+");
  assert.equal(formatAttentionBadge(4200), "99+");
});

test("fractional counts floor before formatting", () => {
  assert.equal(formatAttentionBadge(2.9), "2");
  assert.equal(formatAttentionBadge(0.4), "");
});

// Both surfaces must render the count via the shared formatter — a dot-only
// regression (the pre-#756 state) would silently drop the number again.
test("sidebar and mobile dock render the count badge, not a bare dot", () => {
  const sidebar = readFileSync(
    fileURLToPath(new URL("../apps/dashboard/components/layout/sidebar.tsx", import.meta.url)),
    "utf8"
  );
  const dock = readFileSync(
    fileURLToPath(new URL("../apps/dashboard/components/layout/mobile-dock.tsx", import.meta.url)),
    "utf8"
  );
  for (const [name, src] of [["sidebar", sidebar], ["mobile-dock", dock]]) {
    assert.match(src, /formatAttentionBadge/, `${name} must use formatAttentionBadge`);
    assert.doesNotMatch(
      src,
      /h-\[6px\] w-\[6px\][^\n]*rounded-full bg-accent/,
      `${name} must not render the old 6px attention dot`
    );
  }
});
