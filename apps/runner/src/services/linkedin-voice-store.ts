import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir } from "../config";

const VOICE_DIR = resolve(dataDir, "linkedin-voice-messages");

/**
 * On-disk store for LinkedIn voice-message audio bytes. LinkedIn's voice
 * messages live behind signed URLs that expire, so the adapter fetches
 * them during scan (while the page's auth cookies are still in play) and
 * persists the bytes here under a URN-derived filename. The transcription
 * service's `AttachmentResolver` then reads back from the same path by
 * hashing the URN it gets from the attachment's `guid`.
 *
 * Format is always m4a (LinkedIn serves AAC-in-MP4 with an
 * `application/octet-stream` content-type), so consumers can treat the
 * file as `audio/mp4` without sniffing.
 */
export const LINKEDIN_VOICE_MIME = "audio/mp4";

function ensureDir(): void {
  if (!existsSync(VOICE_DIR)) {
    mkdirSync(VOICE_DIR, { recursive: true });
  }
}

function urnHash(urn: string): string {
  return createHash("sha256").update(urn).digest("hex").slice(0, 32);
}

export function linkedInVoicePath(urn: string): string {
  return join(VOICE_DIR, `${urnHash(urn)}.m4a`);
}

export function hasLinkedInVoice(urn: string): boolean {
  return existsSync(linkedInVoicePath(urn));
}

/**
 * True when an attachment guid belongs to the LinkedIn voice store rather
 * than iMessage. The guid is the message key the adapter persisted the
 * voice file under, which is one of three shapes:
 *   - a real LinkedIn event URN: `urn:li:msg_message:...`
 *   - a content fingerprint for an id-less bubble: `li-msg-fp:...`
 *   - the raw positional fallback (legacy rows): `li-msg-<index>`
 * The composite attachment resolver dispatches on this so a LinkedIn voice
 * guid is never mistaken for a UUID-shaped iMessage attachment guid.
 */
export function isLinkedInVoiceGuid(guid: string): boolean {
  return guid.startsWith("urn:li:") || guid.startsWith("li-msg-");
}

export function writeLinkedInVoice(urn: string, bytes: Buffer): string {
  ensureDir();
  const path = linkedInVoicePath(urn);
  writeFileSync(path, bytes);
  return path;
}
