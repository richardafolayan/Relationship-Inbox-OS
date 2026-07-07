// Inbound media handling for the WhatsApp adapter. wweb.js exposes
// `msg.downloadMedia()` which returns a `MessageMedia` with base64 data
// and mimetype. We persist that to disk under runnerConfig.whatsappMediaDir
// so the dashboard can stream it via a stable URL (see the
// `/data/whatsapp-attachment/:guid` route in apps/runner/src/index.ts).
//
// Module is intentionally pure on the disk layer — no whatsapp-web.js
// imports, takes the small `MessageMedia` subset it needs. That keeps the
// helper unit-testable without spinning up Puppeteer.

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import type { AttachmentPlaceholder } from "@inbox-os/core";

/** Narrow slice of the wweb.js MessageMedia returned by downloadMedia(). */
export interface WhatsAppMessageMedia {
  /** MIME type, e.g. "image/jpeg" / "video/mp4" / "audio/ogg; codecs=opus". */
  mimetype: string;
  /** Base64-encoded payload. */
  data: string;
  /** Filename, only set for documents — null otherwise. */
  filename?: string | null;
  /** Byte size when known. Optional. */
  filesize?: number | null;
}

/**
 * Map a wweb.js message `type` (plus the `isGif` flag) to the coarse
 * AttachmentPlaceholder.kind the dashboard uses to pick a renderer.
 * Everything we don't recognise becomes "unknown" so the UI shows a
 * neutral download chip instead of choking.
 */
export function mapWhatsAppKind(
  type: string | undefined,
  flags: { isGif?: boolean } = {}
): AttachmentPlaceholder["kind"] {
  switch (type) {
    case "image":
      return "photo";
    case "sticker":
      return "sticker";
    case "video":
      // wweb.js represents GIFs as videos with isGif=true. We mark them
      // explicitly now that the dashboard has a GIF renderer path.
      return flags.isGif ? "gif" : "video";
    case "ptt":
      return "voice_note";
    case "audio":
      return "audio";
    case "document":
      return "pdf";
    default:
      return "unknown";
  }
}

/** Default extension for a mimetype when wweb.js doesn't give a filename. */
function extensionForMime(mimetype: string): string {
  // Strip any "; codecs=…" suffix wweb.js sometimes appends on audio.
  const base = mimetype.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "audio/mpeg":
      return ".mp3";
    case "audio/ogg":
      return ".ogg";
    case "audio/mp4":
      return ".m4a";
    case "audio/webm":
      return ".webm";
    case "audio/wav":
      return ".wav";
    case "application/pdf":
      return ".pdf";
    default: {
      // Fall back to whatever sits after the "/" — e.g. "application/zip" -> ".zip".
      const after = base.split("/")[1] ?? "";
      return after.length > 0 && /^[a-z0-9.+-]+$/.test(after) ? `.${after}` : ".bin";
    }
  }
}

/**
 * Sanitise a wweb.js message id into something safe for a filename. The
 * raw `_serialized` form looks like `false_123@c.us_ABCDEF123456_447xxx@c.us`
 * — colons, slashes, etc. would all be filesystem-hostile.
 */
export function safeIdForFilename(rawId: string): string {
  return rawId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 180);
}

export interface WhatsAppMediaMeta {
  /** Absolute path the file was written to. Stable across runs. */
  absolutePath: string;
  /** Stable identifier the dashboard quotes in URLs — derived from msg.id._serialized. */
  guid: string;
  /** Filename component (no directory). */
  filename: string;
  /** MIME type as wweb.js reported it. */
  mimetype: string;
  /** Byte size on disk. */
  byteSize: number;
}

export interface DownloadMediaDeps {
  /** Filesystem root for downloaded media. runnerConfig.whatsappMediaDir. */
  mediaDir: string;
  /** Override for the file writer, used by tests. Defaults to fs/promises. */
  writer?: {
    mkdir: typeof mkdir;
    writeFile: typeof writeFile;
    stat: typeof stat;
    exists: (path: string) => boolean;
  };
}

/**
 * Persist the media payload to disk under `mediaDir`, idempotent on the
 * derived guid. Returns the meta the adapter writes onto the message's
 * attachments array. Throws on filesystem errors so the caller can log
 * + carry on (the message itself still gets a "[media]" placeholder).
 */
export async function persistWhatsAppMedia(
  rawMessageId: string,
  media: WhatsAppMessageMedia,
  deps: DownloadMediaDeps
): Promise<WhatsAppMediaMeta> {
  const writer = deps.writer ?? {
    mkdir,
    writeFile,
    stat,
    exists: (p: string) => existsSync(p)
  };

  const guid = safeIdForFilename(rawMessageId);
  const extFromFilename = media.filename ? extname(media.filename).toLowerCase() : "";
  const ext = extFromFilename || extensionForMime(media.mimetype);
  const filename = `${guid}${ext}`;
  const absolutePath = resolve(join(deps.mediaDir, filename));

  if (!writer.exists(absolutePath)) {
    await writer.mkdir(deps.mediaDir, { recursive: true });
    const buf = Buffer.from(media.data, "base64");
    await writer.writeFile(absolutePath, buf);
  }
  const info = await writer.stat(absolutePath);

  return {
    absolutePath,
    guid,
    filename,
    mimetype: media.mimetype,
    byteSize: info.size
  };
}

/**
 * Look up a persisted media file by guid for the streaming endpoint.
 * Returns null when the file isn't on disk (the operator hasn't scanned
 * the relevant thread yet, or media was rotated out of the working set).
 */
export async function findWhatsAppMediaByGuid(
  guid: string,
  mediaDir: string
): Promise<{ absolutePath: string; mimetype: string; byteSize: number } | null> {
  // Filenames are `<guid><ext>`; we don't know the extension up front but
  // there's at most one file per guid. Glob is overkill — readdir + prefix
  // match keeps the lookup O(n) where n is the media count and avoids a
  // dep. Future-proof: when n grows we can shard into per-guid subdirs.
  const safeGuid = safeIdForFilename(guid);
  const { readdir } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(mediaDir);
  } catch {
    return null;
  }
  const match = entries.find((name) => name.startsWith(safeGuid) && (name === safeGuid || name.startsWith(`${safeGuid}.`)));
  if (!match) return null;
  const absolutePath = resolve(join(mediaDir, match));
  const info = await stat(absolutePath);
  // Re-derive mimetype from extension. wweb.js is the authority at
  // download time but at serve time we only have the file on disk;
  // mapping back via extension is good enough for the dashboard's
  // <img>/<video> tags. Unknown extensions get application/octet-stream
  // and the browser falls back to a download.
  const ext = extname(match).toLowerCase();
  const mimetype = mimeForExtension(ext);
  return { absolutePath, mimetype, byteSize: info.size };
}

function mimeForExtension(ext: string): string {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".m4a":
      return "audio/mp4";
    case ".wav":
      return "audio/wav";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

/**
 * Stream a previously-persisted file out via the Express response. Sets
 * Content-Type and Content-Length so the browser can decide between
 * inline render and download. Caller is responsible for the URL lookup
 * via findWhatsAppMediaByGuid first.
 */
export async function streamWhatsAppMedia(args: {
  absolutePath: string;
  mimetype: string;
  byteSize: number;
  res: { setHeader: (name: string, value: string) => void; end: (chunk?: Buffer) => void };
}): Promise<void> {
  const data = await readFile(args.absolutePath);
  args.res.setHeader("Content-Type", args.mimetype);
  args.res.setHeader("Content-Length", String(args.byteSize));
  args.res.setHeader("Cache-Control", "private, max-age=3600");
  args.res.end(data);
}
