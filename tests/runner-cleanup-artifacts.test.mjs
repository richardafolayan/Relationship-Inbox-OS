import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyArtifactCleanup,
  planArtifactCleanup
} from "../apps/runner/dist/scripts/cleanup-artifacts.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

test("artifact cleanup plan keeps last 20 by default", () => {
  const nowMs = Date.UTC(2026, 1, 19, 10, 0, 0, 0);
  const candidates = Array.from({ length: 25 }, (_, index) => ({
    path: `/tmp/run-${index}`,
    mtimeMs: nowMs - (30 + index) * DAY_MS,
    source: "runs"
  }));

  const plan = planArtifactCleanup(candidates, {
    keepRecent: 20,
    keepDays: 7,
    nowMs
  });

  assert.equal(plan.keep.length, 20);
  assert.equal(plan.remove.length, 5);
});

test("artifact cleanup plan keeps recent-by-age items even if outside keepRecent cap", () => {
  const nowMs = Date.UTC(2026, 1, 19, 10, 0, 0, 0);
  const candidates = [
    { path: "/tmp/newest", mtimeMs: nowMs - DAY_MS, source: "runs" },
    { path: "/tmp/recent-not-in-top-1", mtimeMs: nowMs - 2 * DAY_MS, source: "runs" },
    { path: "/tmp/old", mtimeMs: nowMs - 30 * DAY_MS, source: "runs" }
  ];

  const plan = planArtifactCleanup(candidates, {
    keepRecent: 1,
    keepDays: 7,
    nowMs
  });

  assert.equal(plan.keep.some((entry) => entry.path === "/tmp/newest"), true);
  assert.equal(plan.keep.some((entry) => entry.path === "/tmp/recent-not-in-top-1"), true);
  assert.equal(plan.remove.some((entry) => entry.path === "/tmp/old"), true);
});

test("artifact cleanup stays non-destructive until apply and then removes planned artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-cleanup-"));
  const runsDateDir = join(root, "runs", "2026-02-01");
  const runDir = join(runsDateDir, "run-old");
  await mkdir(runDir, { recursive: true });
  const markerFile = join(runDir, "trace.log");
  await writeFile(markerFile, "trace", "utf8");

  const stats = await stat(runDir);
  const plan = planArtifactCleanup(
    [
      {
        path: runDir,
        mtimeMs: stats.mtimeMs - 60 * DAY_MS,
        source: "runs"
      }
    ],
    {
      keepRecent: 0,
      keepDays: 0,
      nowMs: Date.now()
    }
  );

  const before = await stat(markerFile);
  assert.equal(before.isFile(), true);
  assert.equal(plan.remove.length, 1);

  const result = await applyArtifactCleanup(plan);
  assert.equal(result.removedCount, 1);
  await assert.rejects(() => stat(runDir));
});
