import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { dataDir } from "../config";

const VOICE_DIR = resolve(dataDir, "imessage-voice-snapshots");

/**
 * On-disk snapshot store for iMessage voice-note audio bytes.
 *
 * iMessage's "Audio Messages -> Expire: After 2 Minutes" setting makes
 * Messages.app delete a voice note (the chat.db row AND the attachment file)
 * two minutes after it is played. The runner reads chat.db, so once Apple
 * deletes the file the audio is gone for good: transcription that runs after
 * the file vanished records a `missing_file` skip, and playback 404s.
 *
 * To preserve the substance, the scan-time audio hook copies the bytes here
 * the moment a voice note is first seen (while the file still exists). The
 * transcription `AttachmentResolver` and the playback endpoint then prefer
 * this snapshot over Apple's live path, so both the transcript and replay
 * survive the expiry window.
 *
 * This mirrors the LinkedIn voice store (services/linkedin-voice-store.ts),
 * whose signed audio URLs expire the same way. The filename is derived from
 * the attachment guid so the resolver can rebuild the path without a schema
 * column.
 */

// Snapshot mime types are derived from the stored file extension (safeName
// keeps the source extension). Cover every audio kind the scan hook's
// isVoiceNoteAttachment accepts — not just Apple's .caf — so a snapshot of a
// regular audio clip (.wav, .mp3, ...) keeps the mime type the transcription
// SUPPORTED_MIME_TYPES gate and inline playback expect. An unmapped
// extension degrades to application/octet-stream, which downstream treats
// as unsupported — the same outcome as pre-snapshot expiry, never worse.
const EXT_MIME_TYPES: Record<string, string> = {
  ".caf": "audio/x-caf",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
  ".amr": "audio/amr"
};

// iMessage attachment guids are UUID-shaped, but sanitise defensively so a
// hostile/odd guid can never escape the snapshot directory.
function safeName(guid: string, ext: string): string {
  const cleanGuid = guid.replace(/[^A-Za-z0-9._-]/g, "_");
  const cleanExt = /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : ".caf";
  return `${cleanGuid}${cleanExt}`;
}

function ensureDir(): void {
  if (!existsSync(VOICE_DIR)) {
    mkdirSync(VOICE_DIR, { recursive: true });
  }
}

/**
 * Resolve an existing snapshot path for a guid, or null when none is stored.
 * The extension is unknown at read time (Apple uses .caf, but older rows may
 * differ), so we match on the guid prefix.
 */
export function imessageVoiceSnapshotPath(guid: string): string | null {
  if (!existsSync(VOICE_DIR)) return null;
  const cleanGuid = guid.replace(/[^A-Za-z0-9._-]/g, "_");
  try {
    const match = readdirSync(VOICE_DIR).find(
      (name) => name === cleanGuid || name.startsWith(`${cleanGuid}.`)
    );
    return match ? join(VOICE_DIR, match) : null;
  } catch {
    return null;
  }
}

export function hasImessageVoiceSnapshot(guid: string): boolean {
  return imessageVoiceSnapshotPath(guid) !== null;
}

/**
 * Snapshot path plus the attachment metadata the resolver / playback endpoint
 * need, with a mime type derived from the stored extension (Apple voice notes
 * are `.caf`, which the caf->m4a converter handles). Null when no snapshot
 * exists for the guid.
 */
export function imessageVoiceSnapshotMeta(guid: string): {
  absolutePath: string;
  mimeType: string;
  filename: string;
  transferName: string;
} | null {
  const path = imessageVoiceSnapshotPath(guid);
  if (!path) return null;
  const ext = extname(path).toLowerCase();
  const mimeType = EXT_MIME_TYPES[ext] ?? "application/octet-stream";
  return {
    absolutePath: path,
    mimeType,
    filename: `Audio Message${ext || ".caf"}`,
    transferName: "Voice message"
  };
}

/**
 * Copy a voice note's bytes into the snapshot store. Idempotent and
 * best-effort: returns the snapshot path on success (or when one already
 * exists), and null when the source is missing (Apple already expired it) or
 * the copy fails. Never throws — a snapshot failure must not break a scan.
 */
export function snapshotImessageVoice(guid: string, sourceAbsolutePath: string): string | null {
  const existing = imessageVoiceSnapshotPath(guid);
  if (existing) return existing;
  if (!sourceAbsolutePath || !existsSync(sourceAbsolutePath)) return null;
  try {
    ensureDir();
    const dest = join(VOICE_DIR, safeName(guid, extname(sourceAbsolutePath)));
    copyFileSync(sourceAbsolutePath, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Delete a guid's snapshot. Called when a voice note is genuinely retracted
 * (unsent) so we honour the deletion rather than preserving something the
 * operator deliberately took back. Best-effort; never throws.
 */
export function deleteImessageVoiceSnapshot(guid: string): void {
  const path = imessageVoiceSnapshotPath(guid);
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort
  }
}
