import type { PlatformCard } from "@/lib/types";
import { classifyConsumerFailure } from "./consumer-failure";

/**
 * Whether the iMessage row's failure is the macOS Full Disk Access wall
 * (vs. a node-ABI/sqlite build problem, which FDA can't fix). Shared by the
 * Settings platforms tab and the first-run setup wizard so both surfaces
 * offer "Open Full Disk Access" under exactly the same conditions.
 */
export function isIMessageFullDiskAccessProblem(row?: PlatformCard): boolean {
  if (row?.platform !== "IMESSAGE") return false;
  if (row.status === "CONNECTED") return false;
  const text = `${row.lastError ?? ""} ${row.lastScanFailure?.errorSummary ?? ""}`;
  if (/NODE_MODULE_VERSION|better_sqlite3|different Node\.js version/i.test(text)) return false;
  return /Full Disk Access|chat\.db|Cannot read iMessage|unable to open database file/i.test(text);
}

export type PlatformPrimaryAction = "setup" | "scan" | "connect" | "reconnect";

function platformFailureText(row: PlatformCard): string {
  return [
    row.lastError ?? "",
    row.lastScanFailure?.errorSummary ?? "",
    row.lastScanFailure?.reason ?? ""
  ]
    .join(" ")
    .trim();
}

/**
 * Auth and session-loss failures are not fixed by scanning. Primary recovery
 * should open Connect / Reconnect so the user can restore the account.
 */
export function isPlatformAuthOrSessionError(row?: PlatformCard | null): boolean {
  if (!row) return false;
  const text = platformFailureText(row);
  if (!text) return false;

  const classified = classifyConsumerFailure(new Error(text), {
    path: "/runner/control/platform/connect",
    method: "POST"
  });
  if (classified.code === "CREDENTIALS_REQUIRED") return true;

  return /auth[_ -]?required|login required|sign[- ]?in required|not logged in|please (log|sign) in|session[_ -]?(expired|closed|lost|invalid|missing|unavailable)|logged out|unauthori[sz]ed|credential/i.test(
    text
  );
}

/**
 * Resolve the one primary recovery action for a platform card from status and
 * stored error text. Auth/session loss is classified before the CONNECTED /
 * DEGRADED scan shortcut so a DEGRADED row with an expired session leads with
 * Reconnect rather than Scan. Selector or partial-data degradation stays
 * scan-primary. Non-auth ERROR stays scan-primary.
 */
export function resolvePlatformPrimaryAction(row: PlatformCard): PlatformPrimaryAction {
  if (row.enabled === false) return "setup";
  if (isPlatformAuthOrSessionError(row)) {
    return row.connectedAt || row.lastScanAt ? "reconnect" : "connect";
  }

  if (row.status === "CONNECTED" || row.status === "DEGRADED" || row.status === "ERROR") {
    return "scan";
  }

  return "connect";
}

export function platformScanEligible(row: PlatformCard): boolean {
  return row.enabled !== false && resolvePlatformPrimaryAction(row) === "scan";
}
