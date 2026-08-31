import assert from "node:assert/strict";
import test from "node:test";

import { classifyBrowserFixture } from "../scripts/testing/browser-fixture-policy.mjs";

test("platform-scoped browser fixtures are required only where they apply", () => {
  const source = `// @tovi-browser\n// @tovi-browser-platform darwin\n`;

  assert.deepEqual(classifyBrowserFixture(source, "darwin"), {
    browser: true,
    applicable: true
  });
  assert.deepEqual(classifyBrowserFixture(source, "linux"), {
    browser: true,
    applicable: false
  });
});
