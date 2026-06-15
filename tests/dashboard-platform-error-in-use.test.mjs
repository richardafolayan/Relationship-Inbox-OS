import test from "node:test";
import assert from "node:assert/strict";
import { hasEverConnected, isDegradedAndInUse } from "../apps/dashboard/lib/risk.ts";

// Guards issue #708: a pilot who never connected LinkedIn (it is enabled by
// default) saw a "Something looks off on LinkedIn" error banner on Today after
// a default scan failed and marked the platform DEGRADED. The error banner on
// Today / Inbox / Thread must only surface for platforms the operator actually
// uses — i.e. has connected at least once (connectedAt set). The shared
// `isDegradedAndInUse` helper keeps all three surfaces consistent.

const platform = (over = {}) => ({
  platform: "LINKEDIN",
  status: "NOT_CONNECTED",
  connectedAt: null,
  enabled: true,
  ...over
});

test("hasEverConnected keys off connectedAt, not enabled", () => {
  assert.equal(hasEverConnected(platform({ connectedAt: null })), false);
  // enabled-by-default but never connected is NOT "in use".
  assert.equal(hasEverConnected(platform({ enabled: true, connectedAt: null })), false);
  assert.equal(hasEverConnected(platform({ connectedAt: "2026-06-01T10:00:00.000Z" })), true);
});

test("DEGRADED + never connected does NOT raise an error banner", () => {
  // The exact R-0076 case: LinkedIn enabled by default, never connected, a
  // background scan failed and marked it DEGRADED.
  assert.equal(
    isDegradedAndInUse(platform({ status: "DEGRADED", enabled: true, connectedAt: null })),
    false
  );
});

test("DEGRADED + previously connected DOES raise an error banner", () => {
  assert.equal(
    isDegradedAndInUse(
      platform({ status: "DEGRADED", connectedAt: "2026-06-01T10:00:00.000Z" })
    ),
    true
  );
});

test("non-DEGRADED statuses never raise the error banner regardless of connection", () => {
  for (const status of ["CONNECTED", "NOT_CONNECTED", "ERROR"]) {
    assert.equal(
      isDegradedAndInUse(platform({ status, connectedAt: "2026-06-01T10:00:00.000Z" })),
      false,
      `${status} should not be treated as a degraded-in-use error`
    );
  }
});

test("the three surfaces all gate on isDegradedAndInUse, never raw status===DEGRADED", async () => {
  // A regression here would let a non-user see a platform error again. The
  // Today, Inbox and Thread pages must filter degraded platforms through the
  // shared helper rather than a bare status check.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { join, dirname } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const surfaces = [
    "apps/dashboard/app/today/page.tsx",
    "apps/dashboard/app/inbox/page.tsx",
    "apps/dashboard/app/thread/[id]/page.tsx"
  ];
  for (const rel of surfaces) {
    const src = readFileSync(join(root, rel), "utf8");
    // Strip line comments so an explanatory comment mentioning the old
    // pattern can't trip the guard.
    const code = src.replace(/\/\/[^\n]*/g, "");
    assert.ok(
      code.includes("isDegradedAndInUse"),
      `${rel} should gate the degraded banner through isDegradedAndInUse`
    );
    assert.ok(
      !/status\s*===\s*"DEGRADED"/.test(code),
      `${rel} should not check status === "DEGRADED" directly (use isDegradedAndInUse)`
    );
  }
});
