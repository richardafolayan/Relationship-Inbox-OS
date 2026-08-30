import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveSelectedScanPlatforms } from "../apps/runner/dist/services/scan-queue.js";

const adapters = {
  LINKEDIN: {},
  INSTAGRAM: {},
  WHATSAPP: {}
};

test("scheduled and all-platform scans include only persisted selected platforms", () => {
  assert.deepEqual(
    resolveSelectedScanPlatforms({
      enabledPlatforms: ["LINKEDIN"],
      adapters,
      isPlatformScannable: () => true
    }),
    ["LINKEDIN"]
  );
});

test("a queued event scan becomes a no-op after its platform is deselected", () => {
  assert.deepEqual(
    resolveSelectedScanPlatforms({
      requestedPlatform: "WHATSAPP",
      enabledPlatforms: ["LINKEDIN"],
      adapters,
      isPlatformScannable: () => true
    }),
    []
  );
});

test("selected platforms still respect capability and platform scannability", () => {
  assert.deepEqual(
    resolveSelectedScanPlatforms({
      enabledPlatforms: ["LINKEDIN", "INSTAGRAM", "WHATSAPP"],
      adapters,
      isPlatformScannable: (platform) => platform !== "WHATSAPP"
    }),
    ["LINKEDIN", "INSTAGRAM"]
  );
});

test("an in-flight deselection fences persistence events and exposes the active all-scan platform", () => {
  const source = readFileSync(
    new URL("../apps/runner/src/services/scan-queue.ts", import.meta.url),
    "utf8"
  );
  assert.match(source, /currentScanPlatform = platform/);
  assert.match(source, /getCurrentScanPlatform: \(\) => currentScanPlatform \?\? currentJob\?\.platform/);
  assert.match(source, /job\.trigger,\s*\(\) => !shouldAbort\(\)/);
  const finalFence = source.lastIndexOf("if (shouldContinue && !shouldContinue())");
  const persistedEvent = source.lastIndexOf('type: "MESSAGES_PERSISTED"');
  assert.ok(finalFence > 0 && finalFence < persistedEvent);
});
