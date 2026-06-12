import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { Response } from "express";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function safeFileName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

// Sanitize a client-supplied multipart upload filename for safe on-disk use.
// Strips any path component (basename) and replaces unsafe chars, then guards
// against names that collapse to nothing or to "."/".." (which would escape the
// per-request upload dir via path.join). Falls back to a caller-provided name.
export function safeUploadFilename(name: string | undefined, fallback: string): string {
  const s = safeFileName(name ?? "");
  return (!s || s === "." || s === "..") ? fallback : s;
}

export function ensurePathInside(baseDir: string, fileName: string): string {
  const sanitized = safeFileName(fileName);
  const resolved = resolve(baseDir, sanitized);
  const allowedBase = resolve(baseDir);
  if (!resolved.startsWith(allowedBase)) {
    throw new Error("Invalid artifact path");
  }
  return resolved;
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf-8");
}


// Stream a file to an HTTP response WITH the error/close guards a bare
// `createReadStream(path).pipe(res)` lacks. If the file is unlinked between an
// existsSync check and the open (a concurrent cleanup job, EACCES, an OS/iCloud
// sweep), the read stream emits an async `error` event; left unhandled, Node
// turns it into an uncaughtException and the process-level handler exits the
// whole runner. Callers set their own Content-Type/Cache-Control first; this
// only adds crash-safety (sends `notFoundStatus` before headers, else destroys
// the socket) and tears the stream down if the client disconnects.
export function streamFileToResponse(filePath: string, res: Response, notFoundStatus = 404): void {
  const stream = createReadStream(filePath);
  stream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(notFoundStatus).json({ error: "file unavailable" });
    } else {
      res.destroy(err);
    }
    stream.destroy();
  });
  res.on("close", () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(res);
}
