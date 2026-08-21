import { readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
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

export interface CleanupRoots {
  runs: string;
  screenshots: string;
  dom_dumps: string;
  repair: string;
}

export function resolveCleanupRepoRoot(scriptRoot: string): string {
  return resolve(scriptRoot, "../../../..");
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

export function resolveDefaultCleanupRoots(input: {
  repoRoot: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): CleanupRoots {
  const cwd = resolve(input.cwd ?? process.cwd());
  const env = input.env ?? process.env;
  const dataSetting = env.RIOS_DATA_DIR?.trim();
  const runsSetting = env.RUN_TRACE_DIR?.trim();
  const dataRoot = dataSetting
    ? resolve(cwd, dataSetting)
    : resolve(input.repoRoot, "data");
  const runsRoot = runsSetting
    ? resolve(cwd, runsSetting)
    : resolve(input.repoRoot, "apps/runner/logs/runs");
  return {
    runs: runsRoot,
    screenshots: resolve(dataRoot, "screenshots"),
    dom_dumps: resolve(dataRoot, "dom_dumps"),
    repair: resolve(dataRoot, "repair")
  };
}

export async function collectDefaultCleanupCandidates(roots: CleanupRoots): Promise<CleanupCandidate[]> {

  const [runs, screenshots, domDumps, repair] = await Promise.all([
    collectRunCandidates(roots.runs),
    collectFlatFileCandidates(roots.screenshots, "screenshots"),
    collectFlatFileCandidates(roots.dom_dumps, "dom_dumps"),
    collectFlatFileCandidates(roots.repair, "repair")
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

function assertRelativeConfinement(path: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const offset = relative(resolvedRoot, resolvedPath);
  if (!offset || offset.startsWith("..") || isAbsolute(offset)) {
    throw new Error(`Refusing artifact cleanup outside configured root: ${resolvedPath}`);
  }
}

async function assertConfined(path: string, root: string): Promise<void> {
  assertRelativeConfinement(path, root);
  try {
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    assertRelativeConfinement(realPath, realRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function applyArtifactCleanup(
  plan: CleanupPlan,
  roots: CleanupRoots
): Promise<{ removedCount: number }> {
  for (const entry of plan.remove) {
    await assertConfined(entry.path, roots[entry.source]);
  }
  for (const entry of plan.remove) {
    await rm(entry.path, {
      recursive: true,
      force: true
    });

    // Remove empty date bucket directories left by run-folder deletion.
    const maybeDateDir = dirname(entry.path);
    if (/^\d{4}-\d{2}-\d{2}$/.test(basename(maybeDateDir))) {
      try {
        await assertConfined(maybeDateDir, roots.runs);
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
  const repoRoot = resolveCleanupRepoRoot(scriptRoot);
  const roots = resolveDefaultCleanupRoots({ repoRoot });
  const candidates = await collectDefaultCleanupCandidates(roots);
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

  const result = await applyArtifactCleanup(plan, roots);
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
