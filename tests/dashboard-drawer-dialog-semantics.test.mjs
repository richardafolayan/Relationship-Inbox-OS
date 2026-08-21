import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const receipts = readFileSync(
  new URL("../apps/dashboard/components/common/receipts-drawer.tsx", import.meta.url),
  "utf8"
);
const profile = readFileSync(
  new URL("../apps/dashboard/components/common/profile-drawer.tsx", import.meta.url),
  "utf8"
);
const focus = readFileSync(
  new URL("../apps/dashboard/lib/use-dialog-focus.ts", import.meta.url),
  "utf8"
);

test("drawers expose named modal semantics and a deterministic initial focus", () => {
  for (const source of [receipts, profile]) {
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.match(source, /aria-labelledby=\{titleId\}/);
    assert.match(source, /data-dialog-initial-focus/);
  }
});

test("drawer focus is trapped, Escape closes, and the opener is restored", () => {
  assert.match(focus, /event\.key === "Escape"/);
  assert.match(focus, /event\.key !== "Tab"/);
  assert.match(focus, /previous\?\.isConnected/);
  assert.match(focus, /previous\.focus\(\)/);
});
