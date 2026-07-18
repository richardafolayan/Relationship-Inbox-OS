/**
 * Host-device presentation helpers for phone Settings and App updates.
 *
 * Phone UI talks to the Mac (or Windows PC) that runs the local runner.
 * These pure helpers keep labels honest about where actions run, where
 * storage is used, and why remote actions are unavailable when the host
 * is offline.
 *
 * Client presentation lives here. Runner hostname / ComputerName resolution
 * lives in apps/runner/src/services/host-device.ts.
 */

export type HostPlatformId = "darwin" | "win32" | "linux" | string;

export interface HostDevicePayload {
  hostname?: string | null;
  platform?: HostPlatformId | null;
  /** Friendly label from runner host-device service when available. */
  label?: string | null;
  kind?: "mac" | "pc" | "computer" | null;
}

export type HostOnlineState = boolean | undefined;

export function hostKindNoun(platform?: HostPlatformId | null): "Mac" | "PC" | "computer" {
  if (platform === "darwin") return "Mac";
  if (platform === "win32") return "PC";
  return "computer";
}

export function humanizeHostname(hostname?: string | null): string {
  if (!hostname) return "";
  let value = hostname.trim();
  if (!value) return "";
  // Drop common mDNS / domain suffixes without exposing the full FQDN.
  value = value.replace(/\.local$/i, "").replace(/\.lan$/i, "");
  // Keep only the first label if a longer domain slipped through.
  value = value.split(".")[0] ?? value;
  value = value.replace(/[_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!value) return "";
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => {
      // Keep short acronyms and already-shaped product tokens (MacBook, iPhone).
      if (/^[A-Z0-9]+$/.test(part) && part.length <= 4) return part;
      if (/^[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(part)) return part;
      if (/^[A-Z][a-z0-9]+$/.test(part)) return part;
      if (/^[a-z][A-Z][A-Za-z0-9]*$/.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      }
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

export function hostDeviceLabel(
  hostname?: string | null,
  platform?: HostPlatformId | null,
  resolvedLabel?: string | null
): string {
  const fromRunner = typeof resolvedLabel === "string" ? resolvedLabel.trim() : "";
  if (fromRunner) return fromRunner;
  const cleaned = humanizeHostname(hostname);
  if (cleaned) return cleaned;
  return `your ${hostKindNoun(platform)}`;
}

export function runsOnLine(
  hostname?: string | null,
  platform?: HostPlatformId | null,
  resolvedLabel?: string | null
): string {
  return `Runs on ${hostDeviceLabel(hostname, platform, resolvedLabel)}`;
}

export function formatHostLastSeen(
  lastSeenAt: number | null | undefined,
  now = Date.now()
): string {
  if (lastSeenAt == null || !Number.isFinite(lastSeenAt)) return "";
  const diffMs = Math.max(0, now - lastSeenAt);
  const minutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "now";
}

export function hostStatusLine(input: {
  online: HostOnlineState;
  lastSeenAt?: number | null;
  platform?: HostPlatformId | null;
  now?: number;
}): string {
  const { online, lastSeenAt = null, platform, now = Date.now() } = input;
  if (online === undefined) return "Checking connection…";
  if (online) return "Online · Last seen now";
  const seen = formatHostLastSeen(lastSeenAt, now);
  if (seen) return `Offline · Last seen ${seen}`;
  return `Offline · ${hostKindNoun(platform)} unavailable`;
}

export type RemoteActionKind =
  | "scan"
  | "openBrowser"
  | "connect"
  | "fullDiskAccess"
  | "voiceModel"
  | "updates"
  | "setupMac"
  | "reassess"
  | "headless"
  | "autoScan";

export function remoteActionLabel(
  kind: RemoteActionKind,
  platform?: HostPlatformId | null
): string {
  const kindNoun = hostKindNoun(platform);
  switch (kind) {
    case "scan":
    case "connect":
    case "reassess":
    case "headless":
    case "autoScan":
      return `Runs on your ${kindNoun}`;
    case "openBrowser":
      return `Opens on your ${kindNoun}`;
    case "fullDiskAccess":
    case "setupMac":
      return `Complete this on your ${kindNoun}`;
    case "voiceModel":
      return `Installed on your ${kindNoun}`;
    case "updates":
      return `Updates install on your ${kindNoun}`;
    default:
      return `Runs on your ${kindNoun}`;
  }
}

export function hostOfflineExplanation(
  platform?: HostPlatformId | null,
  appName = "Tovi"
): string {
  const kindNoun = hostKindNoun(platform);
  return `Unavailable while your ${kindNoun} is offline. Open ${appName} on your ${kindNoun} and stay on the same Wi-Fi.`;
}

export function voiceModelSizeLabel(
  size: string,
  platform?: HostPlatformId | null
): string {
  const base = size.trim();
  if (!base || /^no download$/i.test(base)) return base || "No download";
  return `${remoteActionLabel("voiceModel", platform)} · ${base}`;
}

export function updatesInstallLabel(platform?: HostPlatformId | null): string {
  return remoteActionLabel("updates", platform);
}

export function isRemoteActionAvailable(online: HostOnlineState): boolean {
  // While the first health check is in flight, keep actions enabled so a
  // slow host does not flash every control as disabled.
  return online !== false;
}
