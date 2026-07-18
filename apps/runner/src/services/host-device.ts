import { execFileSync } from "node:child_process";
import { hostname, platform as osPlatform } from "node:os";

export type HostDeviceKind = "mac" | "pc" | "computer";

export interface HostDeviceInfo {
  /** User-facing name, e.g. "Richard's MacBook". */
  label: string;
  /** Coarse device kind for copy ("your Mac", "this PC"). */
  kind: HostDeviceKind;
  platform: NodeJS.Platform;
  /** Raw OS hostname (may include .local). */
  hostname: string;
}

export type ExecFileSyncFn = (
  file: string,
  args?: readonly string[],
  options?: { encoding?: BufferEncoding; stdio?: unknown; timeout?: number }
) => string;

/**
 * macOS ComputerName ("Richard's MacBook"). Returns null off-mac or on failure.
 */
export function readMacComputerName(exec: ExecFileSyncFn = execFileSync as ExecFileSyncFn): string | null {
  try {
    const name = String(
      exec("/usr/sbin/scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000
      })
    ).trim();
    return name || null;
  } catch {
    return null;
  }
}

export function hostDeviceKind(platform: NodeJS.Platform = osPlatform()): HostDeviceKind {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "pc";
  return "computer";
}

export function fallbackHostLabel(kind: HostDeviceKind): string {
  if (kind === "mac") return "your Mac";
  if (kind === "pc") return "this PC";
  return "this computer";
}

function isGenericHostName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (!lower) return true;
  if (lower === "localhost" || lower === "mac" || lower === "macbook") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) return true;
  return false;
}

/**
 * Prefer the friendly ComputerName on macOS, then a non-generic hostname,
 * then a calm platform fallback ("your Mac").
 *
 * Shared by /runner/health and App updates (version / update-check) host metadata.
 */
export function resolveHostDeviceInfo(opts?: {
  platform?: NodeJS.Platform;
  computerName?: string | null;
  hostName?: string;
}): HostDeviceInfo {
  const platform = opts?.platform ?? osPlatform();
  const kind = hostDeviceKind(platform);
  const rawHost = (opts?.hostName ?? hostname()).trim();
  const computerName =
    opts && "computerName" in opts
      ? opts.computerName
      : platform === "darwin"
        ? readMacComputerName()
        : null;
  if (computerName && computerName.trim()) {
    return { label: computerName.trim(), kind, platform, hostname: rawHost };
  }
  if (rawHost) {
    const short = rawHost.replace(/\.local$/i, "").split(".")[0] || rawHost;
    if (!isGenericHostName(short)) {
      return { label: short, kind, platform, hostname: rawHost };
    }
  }
  return { label: fallbackHostLabel(kind), kind, platform, hostname: rawHost };
}
