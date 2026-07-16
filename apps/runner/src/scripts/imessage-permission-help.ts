import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { accessibilityGuidance, automationGuidance, fullDiskAccessGuidance } from "../platforms/macos-permission-guidance";

const execFileAsync = promisify(execFile);

export function permissionHelpText(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    fullDiskAccessGuidance(env),
    automationGuidance(env),
    accessibilityGuidance(env),
    "macOS permissions are never reset by this command. No SIP changes are required."
  ];
}

async function main(): Promise<void> {
  for (const line of permissionHelpText()) console.log(`[permissions] ${line}`);
  if (process.platform !== "darwin") return;
  await execFileAsync(
    "open",
    ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"],
    { timeout: 5000 }
  );
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  void main().catch((error) => {
    console.error("[permissions] failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
