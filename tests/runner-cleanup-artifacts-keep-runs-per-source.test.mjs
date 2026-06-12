import test from "node:test";
import assert from "node:assert/strict";
import { planArtifactCleanup } from "../apps/runner/dist/scripts/cleanup-artifacts.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

test("--keep-runs counts runs per source, not the merged global pool", () => {
  const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0, 0);

  // 5 runs we want to keep, all older than a flood of fresh screenshots.
  const runs = Array.from({ length: 5 }, (_, index) => ({
    path: `/tmp/runs/run-${index}`,
    mtimeMs: nowMs - (40 + index) * DAY_MS,
    source: "runs"
  }));

  // 50 screenshots, all newer than every run, that previously stole the
  // global keepRecent budget and pushed the runs into the remove set.
  const screenshots = Array.from({ length: 50 }, (_, index) => ({
    path: `/tmp/screenshots/shot-${index}.png`,
    mtimeMs: nowMs - (1 + index) * (DAY_MS / 100),
    source: "screenshots"
  }));

  const plan = planArtifactCleanup([...screenshots, ...runs], {
    keepRecent: 5,
    keepDays: 0,
    nowMs
  });

  // keepDays:0 means the age rule keeps nothing; only the per-source
  // keepRecent cap protects artifacts. All 5 runs must survive.
  const keptRunPaths = plan.keep.filter((entry) => entry.source === "runs").map((entry) => entry.path);
  assert.equal(keptRunPaths.length, 5, "all 5 newest runs should be kept");
  for (const run of runs) {
    assert.equal(keptRunPaths.includes(run.path), true, `run kept: ${run.path}`);
    assert.equal(plan.remove.some((entry) => entry.path === run.path), false, `run not removed: ${run.path}`);
  }

  // The per-source cap also keeps exactly 5 screenshots (the 5 newest),
  // removing the other 45 — proving keepRecent is applied per source.
  const keptScreenshots = plan.keep.filter((entry) => entry.source === "screenshots");
  assert.equal(keptScreenshots.length, 5, "exactly 5 newest screenshots kept per source");
  assert.equal(plan.remove.filter((entry) => entry.source === "screenshots").length, 45);
});
