import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../apps/dashboard/components/common/SetupWizard.tsx", import.meta.url),
  "utf8"
);

test("setup completion failure stays visible and retryable", () => {
  assert.match(source, /data-testid="setup-finish-error"/);
  assert.match(source, /Your choices are still here, so you can try again/);
  assert.match(source, /persistSetupCompletion/);
  assert.match(source, /finishingRef\.current/);
  assert.doesNotMatch(source, /savePreferences\(\{ completedAt: now \}\)\.catch/);
});

test("done actions navigate only after setup persistence succeeds", () => {
  assert.match(source, /finish\(\)\.then\(\(saved\) => \{ if \(saved\) router\.push/);
  assert.match(source, /if \(saved\) \{ router\.push\("\/today"\)/);
});
