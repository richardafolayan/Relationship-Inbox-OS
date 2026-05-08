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
  const text = escapeAppleScript(opts.text);
  const handle = escapeAppleScript(opts.handle);
  const script = [
    `tell application "Messages"`,
    `  set targetService to 1st service whose service type = ${service}`,
    `  set targetBuddy to buddy "${handle}" of targetService`,
    `  send "${text}" to targetBuddy`,
    `end tell`
  ].join("\n");

  const timeout = opts.timeoutMs ?? 15_000;
  await execFileAsync("osascript", ["-e", script], { timeout });
}
