import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  for (const path of opts.attachmentPaths ?? []) {
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
