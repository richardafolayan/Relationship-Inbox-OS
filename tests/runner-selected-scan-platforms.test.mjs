import test from "node:test";
import assert from "node:assert/strict";

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
