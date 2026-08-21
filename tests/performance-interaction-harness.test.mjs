import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("the documented interaction harness can load and print its CLI contract", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/performance/measure-interaction-latency.mjs", "--help"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: npm run perf:interactions/);
  assert.match(result.stdout, /--samples COUNT/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
});
