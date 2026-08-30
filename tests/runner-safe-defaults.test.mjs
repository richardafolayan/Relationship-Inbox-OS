import assert from "node:assert/strict";
import test from "node:test";

import { defaultSettings } from "../packages/core/src/defaults.ts";

test("a virgin install has no selected message source or AI processing", () => {
  assert.deepEqual(defaultSettings.enabledPlatforms, []);
  assert.equal(defaultSettings.aiEnabled, false);
});
