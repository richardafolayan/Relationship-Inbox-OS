import type { PlatformCard } from "@/lib/types";

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
