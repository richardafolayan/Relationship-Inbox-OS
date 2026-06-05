import { readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CleanupCandidate {
  path: string;
  mtimeMs: number;
  source: "runs" | "screenshots" | "dom_dumps" | "repair";
}

export interface CleanupPlan {
  keep: CleanupCandidate[];
  remove: CleanupCandidate[];
}

export interface CleanupOptions {
  keepRecent: number;
  keepDays: number;
  nowMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectRunCandidates(runsRoot: string): Promise<CleanupCandidate[]> {
  if (!(await pathExists(runsRoot))) {
    return [];
  }
  const candidates: CleanupCandidate[] = [];
  const firstLevel = await readdir(runsRoot, { withFileTypes: true });
  for (const entry of firstLevel) {
    if (!entry.isDirectory()) {
      continue;
    }
    const firstPath = resolve(runsRoot, entry.name);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
      const firstStats = await stat(firstPath);
      candidates.push({
        path: firstPath,
        mtimeMs: firstStats.mtimeMs,
        source: "runs"
      });
      continue;
    }

    const secondLevel = await readdir(firstPath, { withFileTypes: true });
    for (const child of secondLevel) {
      if (!child.isDirectory()) {
        continue;
      }
      const runPath = resolve(firstPath, child.name);
      const runStats = await stat(runPath);
      candidates.push({
        path: runPath,
        mtimeMs: runStats.mtimeMs,
        source: "runs"
      });
    }
  }
  return candidates;
}

async function collectFlatFileCandidates(root: string, source: CleanupCandidate["source"]): Promise<CleanupCandidate[]> {
  if (!(await pathExists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const candidates: CleanupCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const filePath = resolve(root, entry.name);
    const fileStats = await stat(filePath);
    candidates.push({
      path: filePath,
      mtimeMs: fileStats.mtimeMs,
      source
    });
  }
  return candidates;
}

export async function collectDefaultCleanupCandidates(repoRoot: string): Promise<CleanupCandidate[]> {
  const runsRoot = resolve(repoRoot, "apps/runner/logs/runs");
  const screenshotsRoot = resolve(repoRoot, "data/screenshots");
  const domDumpsRoot = resolve(repoRoot, "data/dom_dumps");
  const repairRoot = resolve(repoRoot, "data/repair");

  const [runs, screenshots, domDumps, repair] = await Promise.all([
    collectRunCandidates(runsRoot),
    collectFlatFileCandidates(screenshotsRoot, "screenshots"),
    collectFlatFileCandidates(domDumpsRoot, "dom_dumps"),
    collectFlatFileCandidates(repairRoot, "repair")
  ]);

  return [...runs, ...screenshots, ...domDumps, ...repair];
}

export function planArtifactCleanup(candidates: CleanupCandidate[], options: CleanupOptions): CleanupPlan {
  const sorted = [...candidates].sort((left, right) => right.mtimeMs - left.mtimeMs);
  const keepCutoff = options.nowMs - options.keepDays * DAY_MS;
  const keepPaths = new Set<string>();

  const keepRecentLimit = Math.max(0, options.keepRecent);
  const keptPerSource = new Map<CleanupCandidate["source"], number>();
  for (const entry of sorted) {
    const kept = keptPerSource.get(entry.source) ?? 0;
    if (kept < keepRecentLimit) {
      keepPaths.add(entry.path);
      keptPerSource.set(entry.source, kept + 1);
    }
  }
  for (const entry of sorted) {
    if (entry.mtimeMs >= keepCutoff) {
      keepPaths.add(entry.path);
    }
  }

  const keep: CleanupCandidate[] = [];
  const remove: CleanupCandidate[] = [];
  for (const entry of sorted) {
    if (keepPaths.has(entry.path)) {
      keep.push(entry);
    } else {
      remove.push(entry);
    }
  }

  return {
    keep,
    remove
  };
}

export async function applyArtifactCleanup(plan: CleanupPlan): Promise<{ removedCount: number }> {
  for (const entry of plan.remove) {
    await rm(entry.path, {
      recursive: true,
      force: true
    });

    // Remove empty date bucket directories left by run-folder deletion.
    const maybeDateDir = dirname(entry.path);
    if (/\/\d{4}-\d{2}-\d{2}$/.test(maybeDateDir)) {
      try {
        const leftovers = await readdir(maybeDateDir);
        if (leftovers.length === 0) {
          await rm(maybeDateDir, { recursive: true, force: true });
        }
      } catch {
        // best-effort cleanup only
      }
    }
  }

  return {
    removedCount: plan.remove.length
  };
}

interface CliOptions {
  apply: boolean;
  keepRecent: number;
  keepDays: number;
}

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    keepRecent: 20,
    keepDays: 7
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--keep-runs") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(value) && value >= 0) {
        options.keepRecent = value;
      }
      index += 1;
      continue;
    }
    if (arg === "--keep-days") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(value) && value >= 0) {
        options.keepDays = value;
      }
      index += 1;
      continue;
    }
  }

  return options;
}

async function runFromCli(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const scriptRoot = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptRoot, "../../..");
  const candidates = await collectDefaultCleanupCandidates(repoRoot);
  const plan = planArtifactCleanup(candidates, {
    keepRecent: cliOptions.keepRecent,
    keepDays: cliOptions.keepDays,
    nowMs: Date.now()
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: cliOptions.apply ? "apply" : "dry-run",
        keepRecent: cliOptions.keepRecent,
        keepDays: cliOptions.keepDays,
        candidates: candidates.length,
        keep: plan.keep.length,
        remove: plan.remove.length
      },
      null,
      2
    )
  );

  if (!cliOptions.apply) {
    return;
  }

  const result = await applyArtifactCleanup(plan);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: "apply",
        removed: result.removedCount
      },
      null,
      2
    )
  );
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  runFromCli().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}
