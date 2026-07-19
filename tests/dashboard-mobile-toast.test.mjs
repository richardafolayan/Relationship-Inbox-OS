import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../apps/dashboard/components/common/toast-host.tsx", import.meta.url)),
  "utf8"
);

test("phone notifications use a safe-area banner and desktop width returns at sm", () => {
  assert.match(source, /left-3 right-3 top-\[calc\(env\(safe-area-inset-top\)\+8px\)\]/);
  assert.match(source, /sm:left-auto sm:right-4 sm:top-\[56px\] sm:w-\[320px\]/);
  assert.match(source, /line-clamp-2/);
});

test("notification stacking stays calm on a phone", () => {
  assert.match(source, /slice\(-3\)/);
});
