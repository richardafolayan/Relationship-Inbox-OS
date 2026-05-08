import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Transcode an audio file to Apple's `.caf` (Core Audio Format) using
 * macOS's pre-installed `afconvert`. Output mirrors Apple's native voice-
 * memo container so Messages.app at least accepts the file cleanly even
 * if the recipient bubble still renders as a generic file attachment
 * (the native waveform bubble is reserved for the in-app mic flow and
 * isn't reachable via AppleScript). Returns the original path on failure
 * so the send still goes through.
 */
const AUDIO_EXTS = new Set([".m4a", ".mp4", ".aac", ".webm", ".ogg", ".opus", ".wav", ".aiff", ".aif", ".mp3"]);

async function maybeTranscodeAudioToCaf(absolutePath: string): Promise<string> {
  if (!existsSync(absolutePath)) return absolutePath;
  const ext = extname(absolutePath).toLowerCase();
  if (ext === ".caf") return absolutePath;
  if (!AUDIO_EXTS.has(ext)) return absolutePath;
  const dst = join(dirname(absolutePath), "Audio Message.caf");
  try {
    // ima4 / caff matches Apple's voice-memo encoding most closely.
    // afconvert reads aiff/wav/m4a/aac/mp3/caf natively. webm/opus may
    // fail; in that case we fall through and ship the original — which
    // Messages will at least surface as a generic audio file rather than
    // bouncing.
    await execFileAsync("afconvert", [absolutePath, dst, "-d", "ima4", "-f", "caff"], { timeout: 30_000 });
    if (existsSync(dst) && statSync(dst).size > 0) return dst;
  } catch {
    // fall through — send as-is
  }
  return absolutePath;
}

/**
 * Escape a string for embedding in an AppleScript double-quoted literal.
 * Backslash and double-quote are the only special chars inside `"..."`.
 */
function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export interface SendIMessageOptions {
  /** Phone or email handle for 1:1 chats, e.g. "+15551234567" or "alice@example.com". */
  handle: string;
  /** "iMessage" or "SMS" (rarely "iMessage" reaches non-Apple targets — the OS picks). */
  service?: string;
  text: string;
  /** Absolute paths of files to attach (sent as separate Messages.app bubbles). */
  attachmentPaths?: string[];
  timeoutMs?: number;
}

/**
 * Send a 1:1 message via Messages.app. Throws if osascript exits non-zero
 * (the user hasn't granted Automation permission, or the handle is not a
 * known buddy on this Mac). Group sends are out of scope for v1; the chat
 * GUID path requires `tell application "Messages" to send "..." to chat id "..."`
 * which has more failure modes.
 */
export async function sendIMessage(opts: SendIMessageOptions): Promise<void> {
  const service = opts.service && opts.service.toLowerCase().includes("sms") ? "SMS" : "iMessage";
  const handle = escapeAppleScript(opts.handle);
  const timeout = opts.timeoutMs ?? 30_000;

  // Send each attachment as its own Messages.app bubble (Apple's UI does
  // the same — one media per bubble). Then the text body. Order matters
  // for how the recipient reads the conversation.
  for (const rawPath of opts.attachmentPaths ?? []) {
    // Browser MediaRecorder hands us webm/opus or mp4. Apple's native
    // voice-memo container is .caf with ima4 codec — transcode to that
    // when possible so delivery doesn't bounce.
    const path = await maybeTranscodeAudioToCaf(rawPath);
    const escaped = escapeAppleScript(path);
    const script = [
      `tell application "Messages"`,
      `  set targetService to 1st service whose service type = ${service}`,
      `  set targetBuddy to buddy "${handle}" of targetService`,
      `  send POSIX file "${escaped}" to targetBuddy`,
      `end tell`
    ].join("\n");
    await execFileAsync("osascript", ["-e", script], { timeout });
  }

  if (opts.text.trim().length > 0) {
    const text = escapeAppleScript(opts.text);
    const script = [
      `tell application "Messages"`,
      `  set targetService to 1st service whose service type = ${service}`,
      `  set targetBuddy to buddy "${handle}" of targetService`,
      `  send "${text}" to targetBuddy`,
      `end tell`
    ].join("\n");
    await execFileAsync("osascript", ["-e", script], { timeout });
  }
}
