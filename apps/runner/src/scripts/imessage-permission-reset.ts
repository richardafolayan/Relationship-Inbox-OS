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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PermissionResetGuard {
  /** True only when the operator passed --confirm. */
  confirmed: boolean;
  /** Lines to print to stderr when the reset is refused. */
  warning: string[];
  /** Non-zero exit code to use when refused (fail-closed). */
  exitCode: number;
}

/**
 * Fail-closed gate for the destructive `tccutil reset AppleEvents` call.
 * That command clears EVERY Apple-Events / Automation grant on the Mac —
 * system-wide and irreversible — so it must never run without an explicit
 * --confirm. Pure (no I/O) so it can be unit-tested; main() does the
 * printing and process.exit.
 */
export function evaluatePermissionResetGuard(argv: readonly string[]): PermissionResetGuard {
  if (argv.includes("--confirm")) {
    return { confirmed: true, warning: [], exitCode: 0 };
  }
  return {
    confirmed: false,
    warning: [
      "[permissions] REFUSED: this resets ALL Apple-Events automation permissions on this Mac — system-wide and irreversible.",
      "[permissions] Every app you previously allowed to control another app (Messages, Finder, System Events, your terminal, …) will have to be re-approved.",
      "[permissions] It would run:  tccutil reset AppleEvents",
      "[permissions] Re-run with --confirm to proceed:  npm run imessage:reset-permissions",
    ],
    exitCode: 2,
  };
}

async function main(): Promise<void> {
  const guard = evaluatePermissionResetGuard(process.argv.slice(2));
  if (!guard.confirmed) {
    for (const line of guard.warning) console.error(line);
    process.exit(guard.exitCode);
    return;
  }
  console.log("[permissions] resetting AppleEvents permissions…");
  await execFileAsync("tccutil", ["reset", "AppleEvents"]);
  console.log("[permissions] done.");
  console.log("[permissions] now retry your send from the dashboard — macOS will re-prompt to Allow Messages automation. Click Allow.");
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void main().catch((error) => {
    console.error("[permissions] failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
