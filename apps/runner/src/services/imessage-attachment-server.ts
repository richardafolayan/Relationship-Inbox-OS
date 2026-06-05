import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync, createReadStream, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { Response } from "express";

const execFileAsync = promisify(execFile);

const CACHE_DIR = join(tmpdir(), "inbox-os-imessage-converted");
mkdirSync(CACHE_DIR, { recursive: true });

const MAX_BYTES = 200 * 1024 * 1024; // 200MB

/**
 * Serve a Messages.app attachment file to the dashboard. The runner is
 * localhost-only, so this acts as a local file proxy gated on chat.db
 * lookup — the operator can only see attachments that already belong to
 * threads they're authorized to view.
 *
 * Browser compat:
 *   - JPEG/PNG/GIF/MP4/M4V → served as-is.
 *   - HEIC → transcoded to JPEG via macOS `sips` (zero-dep, pre-installed).
 *   - CAF (voice notes) → transcoded to AAC/M4A via macOS `afconvert`.
 * Failed conversions fall through to "send the original" so Safari users
 * (which natively play heic/caf) still work.
 *
 * The conversion cache lives in the OS tmp dir keyed by source path mtime
 * so a file Apple replaces in-place re-runs the conversion.
 */
export async function streamIMessageAttachment(input: {
  absolutePath: string;
  mimeType: string | null;
  transferName: string | null;
  filename: string | null;
  res: Response;
}): Promise<void> {
  const { absolutePath, mimeType, transferName, res } = input;
  if (!existsSync(absolutePath)) {
    res.status(404).json({ error: "attachment file not found on disk" });
    return;
  }
  const stat = statSync(absolutePath);
  if (stat.size > MAX_BYTES) {
    res.status(413).json({ error: `attachment too large (${stat.size} bytes)` });
    return;
  }

  const ext = extname(absolutePath).toLowerCase();
  const lowerMime = (mimeType ?? "").toLowerCase();
  const lowerName = (transferName ?? input.filename ?? absolutePath).toLowerCase();
  const isHeic = ext === ".heic" || ext === ".heif" || lowerMime === "image/heic" || lowerMime === "image/heif";
  const isCaf = ext === ".caf" || lowerName.includes("audio message");

  // Conversion path
  if (isHeic) {
    const converted = await convertOnce(absolutePath, "jpg", async (src, dst) => {
      await execFileAsync("sips", ["-s", "format", "jpeg", src, "--out", dst], { timeout: 15_000 });
    });
    if (converted) {
      pipeFile(converted, "image/jpeg", res, transferName ?? "photo.jpg");
      return;
    }
    // sips failed — fall through and send raw heic.
  }
  if (isCaf) {
    const converted = await convertCafToM4a(absolutePath);
    if (converted) {
      pipeFile(converted, "audio/mp4", res, transferName ?? "voice-note.m4a");
      return;
    }
  }

  pipeFile(absolutePath, mimeType ?? "application/octet-stream", res, transferName ?? "attachment");
}

function pipeFile(path: string, contentType: string, res: Response, downloadName: string): void {
  const stat = statSync(path);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Cache-Control", "private, max-age=86400");
  // Strip both quotes (would terminate the header value) and CR/LF (would
  // allow header injection if `transferName` ever came from an untrusted
  // source — chat.db is trusted today, but defence in depth).
  const safeDownloadName = downloadName.replace(/["\r\n]/g, "");
  res.setHeader("Content-Disposition", `inline; filename="${safeDownloadName}"`);
  const stream = createReadStream(path);
  // Without these handlers, if the file is unlinked mid-stream (Messages.app
  // attachment cleanup, OS upgrade) the unhandled `error` event propagates as
  // an uncaught exception and the process-level handler exits the runner.
  // Best-effort cleanup: send a 500 if headers haven't gone out yet, otherwise
  // destroy the stream/socket and let the client retry.
  stream.on("error", (err) => {
    console.warn(`[imessage-attachment] stream error for ${path}: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: "stream read failed" });
    } else {
      try {
        res.destroy(err);
      } catch {
        // Already torn down — nothing to do.
      }
    }
  });
  // If the client disconnects (closed tab, dashboard navigation), destroy the
  // read stream so we don't keep reading the file into a dead socket.
  res.on("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}

/**
 * Convert `src` once and cache the result keyed by source path + mtime.
 * Returns the converted file path on success, or null when conversion fails.
 */
async function convertOnce(
  src: string,
  outExt: string,
  run: (src: string, dst: string) => Promise<void>
): Promise<string | null> {
  if (!existsSync(src)) return null;
  const stat = statSync(src);
  const key = createHash("sha1").update(`${src}|${stat.mtimeMs}|${outExt}`).digest("hex");
  const dst = join(CACHE_DIR, `${key}.${outExt}`);
  if (existsSync(dst)) return dst;
  try {
    await run(src, dst);
    if (existsSync(dst)) return dst;
    return null;
  } catch {
    return null;
  }
}

/**
 * Convert an Apple CAF voice note to AAC-in-MPEG4 (`.m4a`) using macOS
 * `afconvert`. Cached on disk by source path + mtime, so repeat calls
 * are free. Returns the converted file path or `null` when the source
 * is missing or `afconvert` fails.
 *
 * Single source of truth for the conversion: the dashboard's inline
 * audio playback path streams the same `.m4a`, and the transcription
 * service uploads the same file to OpenAI. Keeping the helper exported
 * here (rather than duplicated) means the cache is shared and the
 * conversion command stays in lockstep.
 */
export async function convertCafToM4a(absolutePath: string): Promise<string | null> {
  return convertOnce(absolutePath, "m4a", async (src, dst) => {
    await execFileAsync("afconvert", [src, dst, "-d", "aac", "-f", "m4af"], {
      timeout: 30_000
    });
  });
}

/**
 * Extract the audio track from an iMessage video (`.mov` / `.mp4`) into
 * AAC-in-MPEG4 (`.m4a`) using macOS `afconvert`. `afconvert` accepts
 * QuickTime / MP4 containers and pulls the audio stream out at the
 * Core Audio layer — no extra dependency (ffmpeg etc.) required.
 *
 * Used by the transcription service to feed video bubbles into the
 * same OpenAI audio endpoint as voice notes. A 8 MiB iMessage video
 * typically lands as ~500 KiB of audio, comfortably under the
 * `/v1/audio/transcriptions` 25 MiB request cap even on long clips.
 *
 * Returns the converted file path or `null` when the source is missing
 * or `afconvert` cannot read the container (e.g. a video with no audio
 * track, or a codec macOS can't decode).
 */
export async function convertVideoToAudioM4a(absolutePath: string): Promise<string | null> {
  // Different cache extension (`mov.m4a`) so video extractions never
  // collide with CAF extractions in the shared cache directory even
  // if their input paths happened to hash to the same key under a
  // future rename. Belt-and-braces given both writers append .m4a.
  return convertOnce(absolutePath, "mov.m4a", async (src, dst) => {
    await execFileAsync("afconvert", [src, dst, "-d", "aac", "-f", "m4af"], {
      timeout: 60_000
    });
  });
}

/**
 * Convert any macOS-decodable audio/video file to a 16 kHz mono signed
 * 16-bit PCM WAV. whisper.cpp's CLI expects exactly this shape — feeding
 * it an m4a or .mov leads to silent "empty output" runs because the
 * decoder can't read AAC-in-MP4 directly. afconvert handles the
 * resampling, channel-mixing, and container change in one pass.
 *
 * Cached on disk by source path + mtime so a re-run never repeats the
 * conversion. Returns the converted file path or `null` when the source
 * is missing or `afconvert` cannot read the container.
 *
 * Lives next to the existing converters so the cache is shared and the
 * afconvert command stays in lockstep with the other shapes.
 */
export async function convertAudioToWhisperWav(absolutePath: string): Promise<string | null> {
  // Cache extension (`whisper.wav`) is distinct from any other shape we
  // emit so concurrent CAF / video / WAV conversions on the same source
  // each get their own cache slot.
  return convertOnce(absolutePath, "whisper.wav", async (src, dst) => {
    await execFileAsync(
      "afconvert",
      [src, dst, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"],
      { timeout: 60_000 }
    );
  });
}
