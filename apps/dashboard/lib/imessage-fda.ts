import type { PlatformCard } from "@/lib/types";

// Shared detection for the iMessage "Full Disk Access is denied" state.
//
// The iMessage adapter reads ~/Library/Messages/chat.db directly. When macOS
// TCC blocks that open (better-sqlite3 surfaces SQLITE_CANTOPEN / "unable to
// open database file"), the adapter reports AUTH_REQUIRED and the runner
// persists that string on the platform row's lastError. This predicate is the
// single source of truth for "iMessage can't read Messages because of a
// permission block" — used by Settings (the buried per-platform card) and by
// the app-wide recovery banner (the unmissable surface).
//
// Guard: a NODE_MODULE_VERSION / better_sqlite3 ABI mismatch produces a
// different "unable to open" that Full Disk Access can't fix, so it's excluded
// here — that's an install problem, not a permission one.
export function isIMessageFullDiskAccessProblem(row?: PlatformCard | null): boolean {
  if (!row || row.platform !== "IMESSAGE") return false;
  if (row.status === "CONNECTED") return false;
  const text = `${row.lastError ?? ""} ${row.lastScanFailure?.errorSummary ?? ""}`;
  if (/NODE_MODULE_VERSION|better_sqlite3|different Node\.js version/i.test(text)) return false;
  return /Full Disk Access|chat\.db|Cannot read iMessage|unable to open database file/i.test(text);
}

// The app-wide banner only fires for the "an update reset Full Disk Access"
// case: iMessage is FDA-blocked AND it was connected at some point before
// (connectedAt is set). A never-connected iMessage is first-run setup — that
// belongs in Settings, not a scary "you lost access" banner. This mirrors the
// existing isDegradedAndInUse philosophy: only surface a platform problem to
// the whole app once the operator was actually relying on it.
export function selectImessageFdaRecovery(
  platforms: PlatformCard[] | null | undefined
): PlatformCard | null {
  if (!platforms) return null;
  const row = platforms.find((p) => p.platform === "IMESSAGE");
  if (!row) return null;
  if (!isIMessageFullDiskAccessProblem(row)) return null;
  if (!row.connectedAt) return null;
  return row;
}
