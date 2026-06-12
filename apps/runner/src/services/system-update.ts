import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Backs the dashboard's "App updates" card and the start wrapper's relaunch.
// The running app never replaces its own code: the POST /system/update route
// only STAGES a pending-update intent, which scripts/start-student.mjs applies
// before booting on the next launch. /system/update-check delegates to the
// updater CLI's own --check-only logic, so version comparison + latest.json
// validation live in exactly one place (scripts/lib/release-manifest.mjs).

export interface AppVersion {
  version: string;
  build?: string;
  commit?: string;
  channel?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes: string[];
  error?: string;
}

export interface PendingUpdateIntent {
  requestedAt: string;
  fromVersion: string;
  toVersion: string;
  feedUrl: string;
}

/**
 * The installed app's version. Prefers the release.json baked into a built
 * release zip (which also carries build + commit), falling back to
 * package.json for a dev checkout.
 */
export function readAppVersion(projectRoot: string): AppVersion {
  for (const file of ["release.json", "package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(projectRoot, file), "utf8"));
      if (parsed?.version) {
        return {
          version: String(parsed.version),
          build: typeof parsed.build === "string" ? parsed.build : undefined,
          commit: typeof parsed.commit === "string" ? parsed.commit : undefined,
          channel: typeof parsed.channel === "string" ? parsed.channel : undefined
        };
      }
    } catch {
      // try the next source
    }
  }
  return { version: "0.0.0" };
}

/**
 * Run the updater in check-only mode and parse its JSON. Never applies; this
 * only reports whether a newer build exists. Any failure (bad feed, timeout,
 * malformed JSON) resolves to "no update available" plus an `error` string so
 * callers can fail safe rather than throw.
 */
export function runUpdateCheck(opts: {
  projectRoot: string;
  feedUrl: string;
  updaterPath?: string;
  nodeBin?: string;
  timeoutMs?: number;
}): Promise<UpdateCheckResult> {
  const { projectRoot, feedUrl } = opts;
  const updaterPath = opts.updaterPath ?? resolve(projectRoot, "scripts/update-student.mjs");
  const nodeBin = opts.nodeBin ?? process.execPath;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const current = readAppVersion(projectRoot).version;
  const base: UpdateCheckResult = {
    currentVersion: current,
    latestVersion: current,
    updateAvailable: false,
    releaseNotes: []
  };
  return new Promise((done) => {
    const child = spawn(
      nodeBin,
      [updaterPath, "--check-only", "--json", "--url", feedUrl, "--dir", projectRoot],
      { cwd: projectRoot }
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      done({ ...base, error: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => {
      clearTimeout(timer);
      done({ ...base, error: "spawn_failed" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try {
          const parsed = JSON.parse(out);
          done({
            currentVersion: String(parsed.currentVersion ?? current),
            latestVersion: String(parsed.latestVersion ?? current),
            updateAvailable: Boolean(parsed.updateAvailable),
            releaseNotes: Array.isArray(parsed.releaseNotes)
              ? parsed.releaseNotes.filter((n: unknown): n is string => typeof n === "string")
              : []
          });
          return;
        } catch {
          // fall through to the error branch
        }
      }
      done({ ...base, error: (err || `exit ${code}`).trim().slice(0, 300) });
    });
  });
}

export function pendingUpdatePath(dataDir: string): string {
  return resolve(dataDir, "pending-update.json");
}

/** Write the pending-update intent the start wrapper consumes on next launch. */
export function stagePendingUpdate(dataDir: string, intent: PendingUpdateIntent): string {
  mkdirSync(dataDir, { recursive: true });
  const path = pendingUpdatePath(dataDir);
  writeFileSync(path, JSON.stringify(intent, null, 2));
  return path;
}
