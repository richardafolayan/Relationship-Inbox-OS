import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
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
/**
 * Send a file attachment by remembering whatever app the operator was
 * using, briefly activating Messages to paste + send the file, then
 * yielding focus straight back. The Q13 "silent send" ideal isn't
 * achievable on macOS for attachments - the documented
 * `tell application "Messages" to send POSIX file ...` path silently
 * fails with chat.db error=25 / "Not Delivered" because Messages drops
 * the bubble during its iCloud upload phase. UI scripting is the
 * workaround, but the focus-restore minimises the disruption: Messages
 * still flashes forward (a few hundred ms), but the operator's cursor
 * lands back where they were instead of leaving them staring at the
 * Messages window. The runner ALSO logs a [imessage-send] warn line
 * the dashboard can surface as a toast so the operator knows what
 * happened.
 */
async function sendFileViaUiScripting(input: {
  filePath: string;
  handle: string;
  timeoutMs: number;
}): Promise<{ foregroundUsed: true }> {
  const filePath = escapeAppleScript(input.filePath);
  const handle = escapeAppleScript(input.handle);
  const script = `
on run
  set theFile to POSIX file "${filePath}"
  -- Capture the currently-frontmost app BEFORE we steal focus so we can
  -- hand it back when the paste completes. Falls back to Finder when
  -- the previous app can't be resolved (e.g. only menu bar agents
  -- running), which at least lets Messages drop out of the foreground.
  set previousApp to "Finder"
  try
    tell application "System Events"
      set previousApp to name of first application process whose frontmost is true
    end tell
  end try
  -- Stage the file on the clipboard so Messages' window can paste it.
  set the clipboard to theFile
  -- Open the chat with this buddy. The imessage: URL scheme selects
  -- (or creates) the conversation and brings Messages forward.
  -- Build the imessage: URL inside AppleScript and wrap with
  -- "quoted form of" so a handle containing single quotes / $ / ;
  -- can't escape the inner shell command. escapeAppleScript only
  -- covers AppleScript string-literal escaping, not POSIX shell.
  set imessageURL to "imessage:${handle}"
  do shell script "open " & quoted form of imessageURL
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
  -- Hand focus back to whatever the operator was doing. A short delay
  -- lets Messages finish its post-send animation before we yield, so
  -- the bubble actually lands before the window drops out of view.
  delay 0.2
  try
    tell application previousApp to activate
  end try
end run
`;
  await execFileAsync("osascript", ["-e", script], { timeout: input.timeoutMs });
  // Visible from the runner's stdout; the dashboard's audit-log handler
  // can grep for this token if it ever wants to surface the warning to
  // the operator as a one-time "we had to bring Messages forward" toast.
  console.warn(
    "[imessage-send] file-send used foreground UI scripting (Messages.app momentarily activated); focus restored to previous app"
  );
  return { foregroundUsed: true };
}

/**
 * Copy `src` into a UUID-namespaced subdir under `inbox-os-imessage-outgoing`
 * so Messages.app can read it. Returns `{ path, cleanup }` — callers MUST
 * await `cleanup()` once the bubble has been delivered so we don't leak
 * staging directories into `/tmp` indefinitely (previously every send left
 * its UUID dir behind forever).
 */
function stageInReadableTmp(src: string): { path: string; cleanup: () => Promise<void> } {
  if (!existsSync(src)) return { path: src, cleanup: async () => undefined };
  const stagingRoot = join(tmpdir(), "inbox-os-imessage-outgoing");
  const dir = join(stagingRoot, randomUUID());
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, basename(src));
  try {
    copyFileSync(src, dst);
    return {
      path: dst,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    };
  } catch {
    return { path: src, cleanup: async () => undefined };
  }
}

async function maybeTranscodeAudioToCaf(absolutePath: string): Promise<string> {
  if (!existsSync(absolutePath)) return absolutePath;
  const ext = extname(absolutePath).toLowerCase();
  if (ext === ".caf") return absolutePath;
  if (!AUDIO_EXTS.has(ext)) return absolutePath;
  // Per-call unique filename so two concurrent sends in the same staging
  // directory don't clobber each other's `.caf` mid-transcode. Previously
  // the fixed name "Audio Message.caf" meant the second send overwrote
  // the first's transcoded file while it was still being read by the
  // AppleScript bubble loop.
  const dst = join(dirname(absolutePath), `audio-message-${randomUUID()}.caf`);
  try {
    // ima4 / caff matches Apple's voice-memo encoding most closely.
    // afconvert reads aiff/wav/m4a/aac/mp3/caf natively. webm/opus may
    // fail; in that case we fall through and ship the original — which
    // Messages will at least surface as a generic audio file rather than
    // bouncing.
    await execFileAsync("afconvert", [absolutePath, dst, "-d", "ima4", "-f", "caff"], { timeout: 30_000 });
    if (existsSync(dst) && statSync(dst).size > 0) return dst;
  } catch (error) {
    // Best-effort transcode. If it fails, fall through and ship the
    // original — Messages will at least surface a generic audio bubble
    // rather than bouncing. Surface a warn so operators see a pattern of
    // failures during a Chrome / OS update.
    console.warn(
      `[imessage-send] afconvert failed; shipping original. ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return absolutePath;
}

/**
 * Escape a string for embedding in an AppleScript double-quoted literal.
 *
 * Inside `"..."` we need to escape:
 *   - backslash (becomes `\\`)
 *   - double-quote (becomes `\"`)
 *   - **newline / CR** — AppleScript literals can't contain raw newlines,
 *     so a multi-line message terminates the string mid-script and the
 *     osascript invocation fails with a parse error. Previously this
 *     escape only handled `\` and `"`, so any send with `\n` in the
 *     body silently broke. Rebuild multi-line strings as a chained
 *     concatenation using AppleScript's `return` constant: `"foo" &
 *     return & "bar"`. That keeps the build-up valid and preserves line
 *     breaks in the delivered message.
 *
 * Returns either a single quoted literal (no newlines) or a chained
 * expression with no leading/trailing quotes — callers pass the result
 * directly into the AppleScript source without wrapping it again.
 */
function escapeAppleScript(value: string): string {
  const escapedBackslashAndQuote = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // Normalise CR/LF/CRLF to a single splitter, then rejoin with `& return &`
  // around quoted segments. A value with no newlines round-trips unchanged.
  if (!/[\r\n]/.test(escapedBackslashAndQuote)) {
    return escapedBackslashAndQuote;
  }
  return escapedBackslashAndQuote
    .split(/\r\n|\r|\n/)
    .map((segment) => `"${segment}"`)
    .join(" & return & ");
}

/**
 * Returns true when the escaped value is a multi-line chained expression
 * (already includes its own quoting). Callers that previously wrapped the
 * result in `"..."` use this to know whether to skip the wrap.
 */
function isPreQuotedAppleScript(value: string): boolean {
  return value.startsWith('"') && value.includes(" & return & ");
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
    const staged = stageInReadableTmp(transcoded);
    try {
      await sendFileViaUiScripting({
        filePath: staged.path,
        handle: opts.handle,
        timeoutMs: timeout
      });
    } finally {
      // Always tear down the per-attachment staging dir so /tmp doesn't
      // accumulate one UUID directory per send forever.
      await staged.cleanup();
    }
  }

  if (opts.text.trim().length > 0) {
    const text = escapeAppleScript(opts.text);
    // Multi-line bodies come back as a chained `"foo" & return & "bar"`
    // expression with its own quoting; single-line bodies still need
    // `"..."` wrapped around the escaped value.
    const sendArg = isPreQuotedAppleScript(text) ? text : `"${text}"`;
    const script = [
      `tell application "Messages"`,
      `  set targetService to 1st service whose service type = ${service}`,
      `  set targetBuddy to buddy "${handle}" of targetService`,
      `  send ${sendArg} to targetBuddy`,
      `end tell`
    ].join("\n");
    await execFileAsync("osascript", ["-e", script], { timeout });
  }
}
