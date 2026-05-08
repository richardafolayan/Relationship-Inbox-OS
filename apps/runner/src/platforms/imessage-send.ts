import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
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

/**
 * Copy `src` to a fresh /tmp/<uuid>/<basename> path so Messages.app can
 * actually read it. Files staged under our data/ dir live outside the
 * Messages sandbox's read scope — the AppleScript send "succeeds"
 * (osascript exits 0) but Messages later fails to upload the bubble,
 * which surfaces in chat.db as message.error=25 and "Not Delivered" on
 * the recipient side. /tmp is universally readable.
 */
/**
 * Send a file via Messages.app using UI scripting (open chat, set
 * clipboard to file, ⌘V, Return). Required because the documented
 * AppleScript path (`send POSIX file "..." to buddy`) reliably fails
 * with chat.db error=25 / "Not Delivered" — Messages accepts the
 * AppleScript, queues the bubble, then drops it during the iCloud
 * upload phase. The clipboard-paste path mirrors what a human does
 * via the Messages UI and goes through the normal delivery code.
 *
 * Requires:
 *   - Automation permission to control Messages (already granted; this
 *     is the same plumbing the text-send path uses).
 *   - Accessibility permission to drive System Events (UI keystrokes).
 *     Granted in System Settings → Privacy & Security → Accessibility
 *     for the runner's terminal app.
 */
async function sendFileViaUiScripting(input: { filePath: string; handle: string; timeoutMs: number }): Promise<void> {
  const filePath = escapeAppleScript(input.filePath);
  const handle = escapeAppleScript(input.handle);
  const script = `
on run
  set theFile to POSIX file "${filePath}"
  -- Stage the file on the clipboard so Messages' window can paste it.
  set the clipboard to theFile
  -- Open the chat with this buddy. The imessage: URL scheme selects
  -- (or creates) the conversation and brings Messages forward.
  do shell script "open 'imessage:${handle}'"
  delay 0.9
  tell application "Messages" to activate
  delay 0.4
  tell application "System Events"
    tell process "Messages"
      set frontmost to true
      delay 0.15
      -- Focus the message input by clicking it explicitly. The composer
      -- text area is the last text element in the front window (Apple's
      -- a11y tree puts it after the conversation list). Falls back to
      -- a tab-key dance if direct focus fails so paste still lands in
      -- the right place across macOS versions.
      try
        set theTextArea to text area 1 of scroll area 1 of group 1 of window 1
        set focused of theTextArea to true
      end try
      delay 0.1
      keystroke "v" using {command down}
      delay 0.6
      keystroke return
    end tell
  end tell
end run
`;
  await execFileAsync("osascript", ["-e", script], { timeout: input.timeoutMs });
}

function stageInReadableTmp(src: string): string {
  if (!existsSync(src)) return src;
  const stagingRoot = join(tmpdir(), "inbox-os-imessage-outgoing");
  const dir = join(stagingRoot, randomUUID());
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, basename(src));
  try {
    copyFileSync(src, dst);
    return dst;
  } catch {
    return src;
  }
}

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
    const transcoded = await maybeTranscodeAudioToCaf(rawPath);
    const path = stageInReadableTmp(transcoded);
    await sendFileViaUiScripting({
      filePath: path,
      handle: opts.handle,
      timeoutMs: timeout
    });
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
