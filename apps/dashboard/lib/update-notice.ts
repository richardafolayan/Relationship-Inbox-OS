"use client";

// Update-available notices: when the runner's update check finds a newer
// pilot build, the operator gets the same calm treatment as a new message -
// one 30s toast plus an entry in the notification center - and clicking
// either lands on Settings > App updates (anchored), where "Update and
// relaunch" lives. Deliberately quiet:
//
//   - one notice PER VERSION (a localStorage stamp remembers the last
//     version announced, so reloads and the 6-hourly re-check never re-toast
//     the same build),
//   - quiet hours suppress the toast but still record the center entry,
//   - a single fixed center id: there is only ever one live "update
//     available" reminder, replaced when a newer version supersedes it and
//     removed automatically once the app reports up to date.

export const UPDATE_NOTICE_ID = "app-update";
export const UPDATE_NOTICE_HREF = "/settings#app-updates";
export const UPDATE_NOTICE_STAMP_KEY = "app_update_notified_v1";

// Mount + every 6 hours while the tab is visible. The check spawns a runner
// child process and fetches the feed, so it must stay far away from the 8s
// inbox cadence; the on-mount tick means a relaunch right after updating
// confirms the new state immediately.
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The runner's GET /system/update-check response shape (fail-safe server side). */
export interface UpdateCheckResponse {
  configured: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseNotes: string[];
  error?: string;
}

export interface UpdateNotice {
  title: string;
  body: string;
  href: string;
}

export function buildUpdateNotice(latestVersion: string): UpdateNotice {
  return {
    title: `Update available v${latestVersion}`,
    body: "A new build is ready. Open Settings to update.",
    href: UPDATE_NOTICE_HREF
  };
}

export type UpdateNoticePlan =
  // Nothing to do (no update, nothing recorded before).
  | "none"
  // The app is up to date: remove any lingering center entry.
  | "clear"
  // New version, quiet hours: record the center entry silently.
  | "record"
  // New version, normal hours: record the center entry and show the toast.
  | "record-and-toast";

/**
 * Decide how an update-check result surfaces. Pure - the caller supplies the
 * previously-announced version (the localStorage stamp) and quiet-hours
 * state, and performs whatever the plan says.
 */
export function planUpdateNotice(input: {
  updateAvailable: boolean;
  latestVersion: string;
  notifiedVersion: string | null;
  quietHoursActive: boolean;
}): UpdateNoticePlan {
  if (!input.updateAvailable) return "clear";
  // Already announced this exact version: leave the center alone. The entry
  // is either still there, or the operator dismissed it - re-recording would
  // resurrect a dismissed reminder on every check.
  if (input.notifiedVersion === input.latestVersion) return "none";
  return input.quietHoursActive ? "record" : "record-and-toast";
}

export function readNotifiedUpdateVersion(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(UPDATE_NOTICE_STAMP_KEY);
  } catch {
    return null;
  }
}

export function writeNotifiedUpdateVersion(version: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UPDATE_NOTICE_STAMP_KEY, version);
  } catch {
    // Privacy mode / quota: worst case the same version announces again
    // next session, which is still calm.
  }
}
