import type { PlatformName } from "@inbox-os/core";

interface ScanJobLike {
  platform?: PlatformName;
}

export function jobIncludesLinkedIn(platform: PlatformName | undefined): boolean {
  return platform === undefined || platform === "LINKEDIN";
}

export function isLinkedInInFlight(input: {
  requestedPlatform: PlatformName | undefined;
  currentJob: ScanJobLike | null;
  queuedJobs: ScanJobLike[];
}): boolean {
  if (!jobIncludesLinkedIn(input.requestedPlatform)) {
    return false;
  }
  if (input.currentJob && jobIncludesLinkedIn(input.currentJob.platform)) {
    return true;
  }
  return input.queuedJobs.some((entry) => jobIncludesLinkedIn(entry.platform));
}
