/**
 * Reset macOS Automation permission for AppleEvents and re-trigger the
 * "Allow Terminal to control Messages" dialog. Run when a previous send
 * failed with -1743 (osascript denied) and the operator dismissed the
 * dialog without granting.
 *
 *   tccutil reset AppleEvents
 *
 * resets ALL Apple-Events permissions on the machine — broad but the
 * single-bundle form requires knowing the requester's bundle id, which
 * varies per terminal app (Terminal.app, iTerm, Warp, VS Code, etc.).
 * After the reset, sending any iMessage (e.g. via the dashboard) will
 * re-pop the macOS dialog. Click Allow.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  console.log("[permissions] resetting AppleEvents permissions…");
  await execFileAsync("tccutil", ["reset", "AppleEvents"]);
  console.log("[permissions] done.");
  console.log("[permissions] now retry your send from the dashboard — macOS will re-prompt to Allow Messages automation. Click Allow.");
}

void main().catch((error) => {
  console.error("[permissions] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
