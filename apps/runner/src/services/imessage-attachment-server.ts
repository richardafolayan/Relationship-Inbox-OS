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
    const converted = await convertOnce(absolutePath, "m4a", async (src, dst) => {
      await execFileAsync("afconvert", [src, dst, "-d", "aac", "-f", "m4af"], { timeout: 30_000 });
    });
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
  // attachment cleanup, OS upgrade) the unhandled `error` event crashes the
  // Express process. Best-effort cleanup: end the response if it hasn't been
  // sent yet, otherwise just destroy the stream and let the client retry.
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
  // If the client disconnects (closed browser tab, dashboard navigation),
  // destroy the read stream so we don't keep reading the file into a
  // socket that will never accept data.
  res.on("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}

/**
 * Convert `src` once and cache the result keyed by source path + mtime.
 * Returns the converted file path on success, or null when conversion fails.
 *
 * In-flight de-duplication: two concurrent requests for the same uncached
 * key both used to spawn `afconvert` / `sips` against the same destination
 * path, racing on the final write. The first to `existsSync(dst)` won, but
 * the second's transcode could overlap and corrupt the file mid-pipe to
 * the dashboard. The shared `inflight` map below ensures only one conversion
 * runs per (src, mtime, outExt) tuple; subsequent callers await the same
 * promise and pick up the cached output once it lands.
 */
const inflight = new Map<string, Promise<string | null>>();

async function convertOnce(
  src: string,
  outExt: string,
  run: (src: string, dst: string) => Promise<void>
): Promise<string | null> {
  const stat = statSync(src);
  const key = createHash("sha1").update(`${src}|${stat.mtimeMs}|${outExt}`).digest("hex");
  const dst = join(CACHE_DIR, `${key}.${outExt}`);
  if (existsSync(dst)) return dst;
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      // Re-check the cache after taking the slot — a previous promise may
      // have completed between the cache check and this point.
      if (existsSync(dst)) return dst;
      await run(src, dst);
      if (existsSync(dst)) return dst;
      return null;
    } catch (error) {
      console.warn(
        `[imessage-attachment] convert failed (${outExt}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}
