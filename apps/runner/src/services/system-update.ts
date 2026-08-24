import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Backs the dashboard's "App updates" card, the start wrapper's fallback, and
// the detached apply-and-restart helper. /system/update-check delegates to the
// updater CLI's own --check-only logic, so version comparison + latest.json
// validation live in exactly one place (scripts/lib/release-manifest.mjs).

export interface AppVersion {
  version: string;
  build?: string;
  commit?: string;
  channel?: string;
  releaseNotes?: string[];
  /** Signed rolling-channel builds bake their own feed into release.json. */
  updateFeedUrl?: string;
  updateMode?: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  currentReleaseNotes: string[];
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
          channel: typeof parsed.channel === "string" ? parsed.channel : undefined,
          releaseNotes: Array.isArray(parsed.releaseNotes)
            ? parsed.releaseNotes.filter((note: unknown): note is string => typeof note === "string")
            : undefined,
          updateFeedUrl: typeof parsed.updateFeedUrl === "string" ? parsed.updateFeedUrl : undefined,
          updateMode: typeof parsed.updateMode === "string" ? parsed.updateMode : undefined
        };
      }
    } catch {
      // try the next source
    }
  }
  return { version: "0.0.0" };
}

/**
 * The feed this install self-updates from. Signed packaged builds carry the
 * exact feed for their release track in release.json and use only that feed.
 * This keeps a dev install on develop and a pilot install on main even though
 * both are the same Tovi.app with the same signing identity.
 *
 * Legacy dev builds are also pinned to their baked feed even if they predate
 * updateMode=squirrel-mac. If a pinned install has no baked feed, return
 * undefined rather than silently crossing to RIOS_UPDATE_FEED_URL. Older
 * source/student installs without the signed updater keep using the configured
 * Dropbox feed as before.
 */
export function resolveUpdateFeedUrl(projectRoot: string, configuredUrl?: string): string | undefined {
  const app = readAppVersion(projectRoot);
  if (app.updateMode === "squirrel-mac" || app.channel === "dev") {
    return app.updateFeedUrl;
  }
  return configuredUrl;
}

/**
 * Whether this install may swap its own code in place. Zip installs always
 * could; a PACKAGED app (code inside Tovi.app) may do so only when it carries
 * the native signed updater mode. The helper quits the app, replaces the full
 * signed bundle, and relaunches it without changing the app identity.
 */
export function canSelfUpdateInPlace(projectRoot: string, packaged: boolean): boolean {
  if (!packaged) return true;
  return readAppVersion(projectRoot).updateMode === "squirrel-mac";
}

/**
 * For a project root inside a mac app bundle (…/Tovi.app/Contents/Resources/app),
 * the bundle path; empty string otherwise.
 */
export function containingAppBundle(projectRoot: string): string {
  const normalized = resolve(projectRoot);
  const match = normalized.match(/^(.*\.app)\/Contents\/Resources\/[^/]+$/);
  return match?.[1] ?? "";
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
  const installed = readAppVersion(projectRoot);
  const current = installed.version;
  const base: UpdateCheckResult = {
    currentVersion: current,
    currentReleaseNotes: installed.releaseNotes ?? [],
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
            currentReleaseNotes: installed.releaseNotes ?? [],
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

export function requestNativeUpdate(
  path: string,
  intent: PendingUpdateIntent,
  hooks: { beforePublish?: (temporaryPath: string) => void } = {}
): string {
  const directory = dirname(path);
  const temporary = resolve(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(directory, { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(intent, null, 2));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hooks.beforePublish?.(temporary);
    renameSync(temporary, path);
    if (process.platform !== "win32") {
      const directoryDescriptor = openSync(directory, "r");
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return path;
}

export function launchUpdateApplyAndRestart(opts: {
  projectRoot: string;
  feedUrl: string;
  nodeBin?: string;
}): { pid?: number; logPath: string } {
  const helperPath = resolve(opts.projectRoot, "scripts/apply-update-and-restart.mjs");
  const logsDir = resolve(opts.projectRoot, "logs");
  mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = resolve(logsDir, `update-restart-${stamp}.log`);
  const fd = openSync(logPath, "a");
  const helperArgs = [helperPath, "--url", opts.feedUrl, "--dir", opts.projectRoot];
  try {
    const child = spawn(
      opts.nodeBin ?? process.execPath,
      helperArgs,
      {
        cwd: opts.projectRoot,
        detached: true,
        stdio: ["ignore", fd, fd]
      }
    );
    child.on("error", (error) => {
      console.warn("[system-update] apply-and-restart helper failed to start", error);
    });
    child.unref();
    return { pid: child.pid, logPath };
  } finally {
    closeSync(fd);
  }
}

export interface AutomaticUpdateScheduler {
  start(): void;
  stop(): void;
  runNow(): Promise<"busy" | "disabled" | "checked">;
}

export function createAutomaticUpdateScheduler(opts: {
  isEnabled(): Promise<boolean>;
  installIfAvailable(): Promise<void>;
  initialDelayMs?: number;
  intervalMs?: number;
  onError?(error: unknown): void;
}): AutomaticUpdateScheduler {
  const initialDelayMs = opts.initialDelayMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 60 * 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let running = false;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runAndReschedule();
    }, delayMs);
    timer.unref();
  };

  const runNow = async (): Promise<"busy" | "disabled" | "checked"> => {
    if (running) return "busy";
    running = true;
    try {
      if (!(await opts.isEnabled())) return "disabled";
      await opts.installIfAvailable();
      return "checked";
    } catch (error) {
      opts.onError?.(error);
      return "checked";
    } finally {
      running = false;
    }
  };

  const runAndReschedule = async (): Promise<void> => {
    await runNow();
    schedule(intervalMs);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule(initialDelayMs);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    runNow
  };
}
