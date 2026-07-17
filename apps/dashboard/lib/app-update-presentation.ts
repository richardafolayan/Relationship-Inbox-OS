// Pure helpers for the Settings "App updates" card: host identity, calm
// user-facing release notes, technical metadata disclosure, and state copy.

export type HostDeviceKind = "mac" | "pc" | "computer";

export type UpdateUiState =
  | "loading"
  | "checking"
  | "up_to_date"
  | "available"
  | "updating"
  | "restart_required"
  | "host_offline"
  | "not_configured"
  | "error";

export interface TechnicalDetail {
  label: string;
  value: string;
}

export interface PresentedReleaseNotes {
  userFacing: string[];
  technicalLines: string[];
}

export interface AppUpdatesSnapshot {
  hostLabel: string;
  hostKind: HostDeviceKind;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  configured: boolean;
  automaticUpdates: boolean;
  applyMode?: "automatic" | "replace_app";
  currentReleaseNotes: string[];
  releaseNotes: string[];
  commit?: string;
  channel?: string;
  build?: string;
  status: UpdateUiState;
  statusMessage: string;
  error: string;
  started: { from: string; to: string; message?: string } | null;
  installHelp: string;
  updatedAt: number;
}

const DEV_BUILD_PREFIX = /^Dev build\s+[0-9a-f]{7,40}\s*:\s*/i;
const STUDENT_BUILD_PREFIX = /^Student pilot build\s+\S+\.?\s*$/i;
const CONVENTIONAL_PREFIX =
  /^(fix|feat|chore|refactor|docs|test|perf|style|build|ci|revert)(\([^)]*\))?:\s*/i;
const TRAILING_PR = /\s*\(#\d+\)\s*$/;
const MERGE_PR = /^Merge (?:pull request|PR) #\d+\b/i;
const BRANCH_PATH = /\b[\w.-]+\/(?:fix|feat|chore|refactor|docs|test|perf)\/[\w./-]+/i;
const SHORT_HASH = /\b[0-9a-f]{7,40}\b/i;
const ONLY_METADATA =
  /^(dev build|student pilot build|build|commit|branch|pr|pull request)\b/i;

function capitalizeSentence(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** True when a release note is mostly commit/PR/branch metadata. */
export function isTechnicalReleaseNote(note: string): boolean {
  const text = note.trim();
  if (!text) return true;
  if (MERGE_PR.test(text)) return true;
  if (STUDENT_BUILD_PREFIX.test(text)) return true;
  if (DEV_BUILD_PREFIX.test(text) && !text.replace(DEV_BUILD_PREFIX, "").trim()) return true;
  if (ONLY_METADATA.test(text) && !CONVENTIONAL_PREFIX.test(text.replace(DEV_BUILD_PREFIX, ""))) {
    // "Dev build abc1234: fix: something" still has user content after strip.
    const stripped = text.replace(DEV_BUILD_PREFIX, "").replace(CONVENTIONAL_PREFIX, "").trim();
    if (!stripped || SHORT_HASH.test(stripped) && stripped.replace(SHORT_HASH, "").trim().length < 3) {
      return true;
    }
  }
  // A bare branch path or hash-only line.
  if (BRANCH_PATH.test(text) && text.replace(BRANCH_PATH, "").trim().length < 3) return true;
  if (/^[0-9a-f]{7,40}$/i.test(text)) return true;
  return false;
}

/**
 * Turn a raw release note into calm user-facing copy, or null when the note
 * has nothing useful left after stripping commit/PR/branch metadata.
 */
export function toUserFacingReleaseNote(note: string): string | null {
  let text = note.trim();
  if (!text) return null;
  if (MERGE_PR.test(text)) return null;
  if (STUDENT_BUILD_PREFIX.test(text)) return null;

  text = text.replace(DEV_BUILD_PREFIX, "");
  text = text.replace(CONVENTIONAL_PREFIX, "");
  text = text.replace(TRAILING_PR, "");
  // Drop explicit branch path fragments left from merge subjects.
  text = text.replace(BRANCH_PATH, "").replace(/\s{2,}/g, " ").trim();
  // Drop leftover "from org/repo" tails.
  text = text.replace(/\s+from\s+[\w.-]+\/[\w.-]+\s*$/i, "").trim();
  text = text.replace(/[.:;,\s]+$/g, "").trim();

  if (!text) return null;
  if (/^[0-9a-f]{7,40}$/i.test(text)) return null;
  if (isTechnicalReleaseNote(text) && !CONVENTIONAL_PREFIX.test(note)) {
    // After stripping, still technical.
    if (MERGE_PR.test(text) || ONLY_METADATA.test(text)) return null;
  }

  return capitalizeSentence(text);
}

export function presentReleaseNotes(notes: string[]): PresentedReleaseNotes {
  const userFacing: string[] = [];
  const technicalLines: string[] = [];
  const seenUser = new Set<string>();

  for (const raw of notes) {
    const note = String(raw ?? "").trim();
    if (!note) continue;
    const user = toUserFacingReleaseNote(note);
    if (user && !seenUser.has(user.toLowerCase())) {
      seenUser.add(user.toLowerCase());
      userFacing.push(user);
    }
    if (isTechnicalReleaseNote(note) || user === null || note !== user) {
      // Keep the original when it carries metadata the user stripped view hid.
      if (
        DEV_BUILD_PREFIX.test(note) ||
        MERGE_PR.test(note) ||
        TRAILING_PR.test(note) ||
        BRANCH_PATH.test(note) ||
        SHORT_HASH.test(note) ||
        STUDENT_BUILD_PREFIX.test(note)
      ) {
        technicalLines.push(note);
      }
    }
  }

  return { userFacing, technicalLines };
}

export function hostAppTitle(appName: string, hostLabel: string): string {
  const label = hostLabel.trim() || "your Mac";
  return `${appName} on ${label}`;
}

export function installLocationCopy(kind: HostDeviceKind = "mac"): string {
  if (kind === "pc") return "Updates install on this PC";
  if (kind === "computer") return "Updates install on this computer";
  return "Updates install on your Mac";
}

export function hostOfflineCheckMessage(kind: HostDeviceKind = "mac"): string {
  if (kind === "pc") {
    return "Check for updates is unavailable while this PC is offline. Open the app on the PC, then try again.";
  }
  if (kind === "computer") {
    return "Check for updates is unavailable while the host is offline. Open the app on that computer, then try again.";
  }
  return "Check for updates is unavailable while your Mac is offline. Open the app on your Mac, then try again.";
}

export function updateRestartNotice(appName: string, kind: HostDeviceKind = "mac"): string {
  const where =
    kind === "pc" ? "this PC" : kind === "computer" ? "this computer" : "your Mac";
  return (
    `Phone access may disconnect briefly while ${appName} restarts on ${where}. ` +
    "Your messages and settings are kept."
  );
}

export function describeUpdateState(input: {
  state: UpdateUiState;
  latestVersion?: string;
  errorMessage?: string;
}): string {
  switch (input.state) {
    case "loading":
      return "Checking version…";
    case "checking":
      return "Checking…";
    case "up_to_date":
      return "Up to date";
    case "available":
      return input.latestVersion ? `Update available: v${input.latestVersion}` : "Update available";
    case "updating":
      return "Downloading and installing…";
    case "restart_required":
      return "Restart required. The app is reopening.";
    case "host_offline":
      return "Host offline";
    case "not_configured":
      return "Updates are not set up yet";
    case "error":
      return input.errorMessage?.trim() || "Could not check for updates";
    default:
      return "";
  }
}

export function buildTechnicalDetails(input: {
  commit?: string;
  channel?: string;
  build?: string;
  branch?: string;
  pullRequest?: string;
  technicalLines?: string[];
}): TechnicalDetail[] {
  const details: TechnicalDetail[] = [];
  if (input.channel) details.push({ label: "Channel", value: input.channel });
  if (input.commit) details.push({ label: "Commit", value: input.commit.slice(0, 12) });
  if (input.branch) details.push({ label: "Branch", value: input.branch });
  if (input.pullRequest) details.push({ label: "Pull request", value: input.pullRequest });
  if (input.build) details.push({ label: "Build", value: input.build });
  for (const line of input.technicalLines ?? []) {
    details.push({ label: "Note", value: line });
  }
  return details;
}

/** Extract a PR number like "#879" from raw notes, if present. */
export function extractPullRequestRef(notes: string[]): string | undefined {
  for (const note of notes) {
    const merge = note.match(/#(\d+)/);
    if (merge) return `#${merge[1]}`;
  }
  return undefined;
}

/** Extract a branch path like "org/fix/name" from raw notes, if present. */
export function extractBranchRef(notes: string[]): string | undefined {
  for (const note of notes) {
    const fromBranch = note.match(/\bfrom\s+([\w.-]+\/[\w./-]+)/i);
    if (fromBranch) return fromBranch[1];
    const path = note.match(BRANCH_PATH);
    if (path) return path[0];
  }
  return undefined;
}

/** Open Technical details by default only in explicit developer mode (dev channel). */
export function technicalDetailsOpenByDefault(channel?: string): boolean {
  return channel === "dev";
}

// ---------------------------------------------------------------------------
// Snapshot cache so version / update state survives Settings navigation.
// ---------------------------------------------------------------------------

let appUpdatesSnapshot: AppUpdatesSnapshot | null = null;

export function readAppUpdatesSnapshot(): AppUpdatesSnapshot | null {
  return appUpdatesSnapshot;
}

export function writeAppUpdatesSnapshot(snapshot: AppUpdatesSnapshot): void {
  appUpdatesSnapshot = snapshot;
}

export function clearAppUpdatesSnapshot(): void {
  appUpdatesSnapshot = null;
}
