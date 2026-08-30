import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runnerSource = readFileSync(
  new URL("../apps/runner/src/index.ts", import.meta.url),
  "utf8"
);

test("pilot feedback intake discards legacy automatic client-error text", () => {
  const start = runnerSource.indexOf('app.post("/control/pilot-feedback"');
  const end = runnerSource.indexOf('app.get("/control/pilot-feedback/status"', start);
  assert.ok(start >= 0 && end > start, "pilot feedback route must be present");
  assert.doesNotMatch(runnerSource.slice(start, end), /lastError/);
});
