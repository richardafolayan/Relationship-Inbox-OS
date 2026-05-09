/**
 * Configure macOS Messages.app to keep audio (voice) messages forever
 * instead of auto-deleting them after 2 minutes. The setting lives in
 * com.apple.MobileSMS user defaults under "KeepAudioMessages". When
 * unset, Messages defaults to expire-after-2-minutes; setting to true
 * keeps every voice note on disk under
 * ~/Library/Messages/Attachments so we can play them back later via
 * the runner's attachment-serving endpoint.
 *
 * Run once per machine. Quit & relaunch Messages.app for the change to
 * take effect, then incoming voice notes will stick around.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error("[keep-voice-notes] macOS only");
    process.exit(1);
  }
  console.log("[keep-voice-notes] setting com.apple.MobileSMS KeepAudioMessages = true");
  await execFileAsync("defaults", ["write", "com.apple.MobileSMS", "KeepAudioMessages", "-bool", "true"]);
  console.log("[keep-voice-notes] done. Quit & relaunch Messages.app for the change to take effect.");
  console.log("[keep-voice-notes] from now on, voice notes you receive (and send) will be retained on disk.");
}

void main().catch((error) => {
  console.error("[keep-voice-notes] failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
