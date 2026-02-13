import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export function safeFileName(name: string): string {
  return basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
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
