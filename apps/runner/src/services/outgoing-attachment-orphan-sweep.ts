import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const OUTGOING_ATTACHMENT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

function collectAbsolutePaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePaths(item, paths);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "absolutePath") {
      if (typeof child !== "string" || child.length === 0) {
        throw new Error("invalid persisted attachment path");
      }
      paths.add(resolve(child));
      continue;
    }
    collectAbsolutePaths(child, paths);
  }
}

export async function sweepOutgoingAttachmentOrphans(input: {
  loadRows: () => Promise<Array<{ attachmentsJson: string | null }>>;
  now?: number;
  outgoingAttachmentsRoot: string;
  graceMs?: number;
}): Promise<
  | { status: "aborted"; removed: 0 }
  | { status: "completed"; removed: number }
> {
  const referencedPaths = new Set<string>();
  try {
    const rows = await input.loadRows();
    for (const row of rows) {
      if (!row.attachmentsJson) continue;
      collectAbsolutePaths(JSON.parse(row.attachmentsJson), referencedPaths);
    }
  } catch {
    return { status: "aborted", removed: 0 };
  }

  const root = resolve(input.outgoingAttachmentsRoot);
  const rootPrefix = `${root}${sep}`;
  const referencedDirectories = new Set<string>();
  for (const path of referencedPaths) {
    if (!path.startsWith(rootPrefix)) continue;
    const pathFromRoot = relative(root, path);
    if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
      continue;
    }
    const [directoryName] = pathFromRoot.split(sep);
    if (directoryName) referencedDirectories.add(resolve(root, directoryName));
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "completed", removed: 0 };
    }
    return { status: "aborted", removed: 0 };
  }

  const now = input.now ?? Date.now();
  const graceMs = input.graceMs ?? OUTGOING_ATTACHMENT_ORPHAN_GRACE_MS;
  const removable: string[] = [];
  try {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = resolve(root, entry.name);
      if (!directory.startsWith(rootPrefix) || referencedDirectories.has(directory)) {
        continue;
      }
      const details = await stat(directory);
      if (now - details.mtimeMs >= graceMs) removable.push(directory);
    }
  } catch {
    return { status: "aborted", removed: 0 };
  }

  let removed = 0;
  for (const directory of removable) {
    try {
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      continue;
    }
  }
  return { status: "completed", removed };
}
