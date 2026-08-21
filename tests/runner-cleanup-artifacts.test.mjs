import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  applyArtifactCleanup,
  planArtifactCleanup,
  resolveCleanupRepoRoot,
  resolveDefaultCleanupRoots
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

  const result = await applyArtifactCleanup(plan, {
    runs: join(root, "runs"),
    screenshots: join(root, "screenshots"),
    dom_dumps: join(root, "dom_dumps"),
    repair: join(root, "repair")
  });
  assert.equal(result.removedCount, 1);
  await assert.rejects(() => stat(runDir));
});

test("cleanup roots honour configured data and trace directories", () => {
  assert.equal(
    resolveCleanupRepoRoot("/repo/apps/runner/dist/scripts"),
    resolve("/repo")
  );
  assert.equal(
    resolveCleanupRepoRoot("/repo/apps/runner/src/scripts"),
    resolve("/repo")
  );
  const roots = resolveDefaultCleanupRoots({
    repoRoot: "/repo",
    cwd: "/work",
    env: {
      RIOS_DATA_DIR: "private-data",
      RUN_TRACE_DIR: "private-traces"
    }
  });
  assert.deepEqual(roots, {
    runs: resolve("/work/private-traces"),
    screenshots: resolve("/work/private-data/screenshots"),
    dom_dumps: resolve("/work/private-data/dom_dumps"),
    repair: resolve("/work/private-data/repair")
  });
  assert.deepEqual(
    resolveDefaultCleanupRoots({ repoRoot: "/repo", cwd: "/repo/apps/runner", env: {} }),
    {
      runs: resolve("/repo/apps/runner/logs/runs"),
      screenshots: resolve("/repo/data/screenshots"),
      dom_dumps: resolve("/repo/data/dom_dumps"),
      repair: resolve("/repo/data/repair")
    }
  );
});

test("cleanup apply rejects a candidate outside its configured source root", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-cleanup-confined-"));
  const outside = join(root, "outside.log");
  const inside = join(root, "screenshots", "inside.log");
  await mkdir(join(root, "screenshots"), { recursive: true });
  await writeFile(outside, "keep", "utf8");
  await writeFile(inside, "keep", "utf8");
  const roots = {
    runs: join(root, "runs"),
    screenshots: join(root, "screenshots"),
    dom_dumps: join(root, "dom_dumps"),
    repair: join(root, "repair")
  };
  await assert.rejects(
    () =>
      applyArtifactCleanup(
        {
          keep: [],
          remove: [
            { path: inside, mtimeMs: 0, source: "screenshots" },
            { path: outside, mtimeMs: 0, source: "screenshots" }
          ]
        },
        roots
      ),
    /outside configured root/
  );
  assert.equal((await stat(outside)).isFile(), true);
  assert.equal((await stat(inside)).isFile(), true, "validation completes before deletion begins");
});

test("cleanup apply rejects a nested symlink that escapes its configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-cleanup-symlink-"));
  const outsideRoot = join(root, "outside");
  const configuredRoot = join(root, "data", "screenshots");
  await mkdir(configuredRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const escapeLink = join(configuredRoot, "escape");
  await symlink(outsideRoot, escapeLink);
  const outsideFile = join(outsideRoot, "private.png");
  await writeFile(outsideFile, "keep", "utf8");
  await assert.rejects(() =>
    applyArtifactCleanup(
      {
        keep: [],
        remove: [
          {
            path: join(escapeLink, "private.png"),
            mtimeMs: 0,
            source: "screenshots"
          }
        ]
      },
      {
        runs: join(root, "runs"),
        screenshots: configuredRoot,
        dom_dumps: join(root, "data", "dom_dumps"),
        repair: join(root, "data", "repair")
      }
    )
  );
  assert.equal((await stat(outsideFile)).isFile(), true);
});
