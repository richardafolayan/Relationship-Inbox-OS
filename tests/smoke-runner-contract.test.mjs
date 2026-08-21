import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repoRoot = new URL("..", import.meta.url);

test("the smoke runner default satisfies both deletion and performance-fixture guards", async () => {
  const [source, setupSeed] = await Promise.all([
    readFile(new URL("scripts/testing/start-smoke-runner.mjs", repoRoot), "utf8"),
    readFile(new URL("scripts/testing/seed-smoke-setup-state.mjs", repoRoot), "utf8")
  ]);

  assert.match(source, /tovi-smoke-performance-e2e\.sqlite/);
  assert.match(source, /startsWith\("tovi-smoke-"\)/);
  assert.match(source, /\(perf\|benchmark\)/);
  assert.match(source, /OPENAI_API_KEY: ""/);
  assert.match(source, /Z_AI_API_KEY: ""/);
  assert.match(source, /GEMINI_API_KEY: ""/);
  assert.match(setupSeed, /startsWith\("tovi-smoke-"\)/);
  assert.match(setupSeed, /\(perf\|benchmark\)/);
});

test("the smoke fixture persists a truthful completed setup before the runner starts", async () => {
  const [runnerSource, setupSeed] = await Promise.all([
    readFile(new URL("scripts/testing/start-smoke-runner.mjs", repoRoot), "utf8"),
    readFile(new URL("scripts/testing/seed-smoke-setup-state.mjs", repoRoot), "utf8")
  ]);

  const performanceSeed = runnerSource.indexOf("Smoke fixture seed");
  const setupStateSeed = runnerSource.indexOf("Smoke setup state seed");
  const runnerStart = runnerSource.indexOf("const runner = spawn");
  assert.ok(performanceSeed >= 0 && setupStateSeed > performanceSeed);
  assert.ok(runnerStart > setupStateSeed);

  assert.match(setupSeed, /key: "setup_preferences_v2"/);
  assert.match(setupSeed, /key: "operator_profile_v1"/);
  assert.match(setupSeed, /completedAt/);
  assert.match(setupSeed, /setupCompletedAt/);
  assert.match(setupSeed, /selectedPlatforms: \["LINKEDIN"\]/);
  assert.match(setupSeed, /enabledPlatforms: \["LINKEDIN"\]/);
  assert.match(setupSeed, /aiEnabled: false/);
  assert.match(setupSeed, /transcriptionMode: "off"/);
  assert.match(setupSeed, /prisma\.\$transaction/);
});

test("the production smoke build bakes in the isolated runner port", async () => {
  const [packageSource, buildSource] = await Promise.all([
    readFile(new URL("package.json", repoRoot), "utf8"),
    readFile(new URL("scripts/testing/build-smoke-dashboard.mjs", repoRoot), "utf8")
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(packageJson.scripts["pretest:smoke"], /build-smoke-dashboard\.mjs/);
  assert.match(buildSource, /TOVI_SMOKE_RUNNER_PORT \?\? "4311"/);
  assert.match(buildSource, /env: \{ \.\.\.process\.env, RUNNER_PORT: runnerPort \}/);
});
