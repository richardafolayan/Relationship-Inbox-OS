import type { PlatformName } from "@inbox-os/core";
import { readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { envBool, isDev } from "../dev-flags.js";

export class AdminResetGuardError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "AdminResetGuardError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface AdminResetDeleteCounts {
  sendRequests: number;
  drafts: number;
  messages: number;
  threads: number;
  orphanPeople: number;
}

export interface AdminResetResult {
  platform: PlatformName;
  matchedThreadCount: number;
  deleted: AdminResetDeleteCounts;
  privateMedia?: AdminResetPrivateMediaResult;
}

export interface AdminResetPrivateMediaResult {
  removedCacheRoots: number;
  removedStagedPaths: number;
  skippedUnsafePaths: number;
}

export interface AdminResetMediaScope {
  dataRoot: string;
  outgoingAttachmentsRoot: string;
  platformCacheRoot?: string;
}

interface AdminResetPrisma {
  thread: {
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  sendRequest: {
    findMany?: (args: unknown) => Promise<Array<{ attachmentsJson: string | null }>>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  draft: {
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  message: {
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  person: {
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
}

let prismaRef: AdminResetPrisma | null = null;

async function resolvePrismaClient(): Promise<AdminResetPrisma> {
  if (prismaRef) {
    return prismaRef;
  }
  const dbModule = await import("../db.js");
  prismaRef = dbModule.prisma as unknown as AdminResetPrisma;
  return prismaRef;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function isStrictlyInside(root: string, candidate: string): boolean {
  const offset = relative(resolve(root), resolve(candidate));
  return Boolean(offset) && !offset.startsWith("..") && !isAbsolute(offset);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isStrictlyInsideReal(root: string, candidate: string): Promise<boolean> {
  try {
    return isStrictlyInside(await realpath(root), await realpath(candidate));
  } catch {
    return false;
  }
}

function stagedPaths(rows: Array<{ attachmentsJson: string | null }>): {
  paths: string[];
  invalid: number;
} {
  const paths = new Set<string>();
  let invalid = 0;
  for (const row of rows) {
    if (!row.attachmentsJson) continue;
    try {
      const parsed = JSON.parse(row.attachmentsJson) as unknown;
      if (!Array.isArray(parsed)) {
        invalid += 1;
        continue;
      }
      for (const entry of parsed) {
        const path =
          typeof entry === "object" && entry !== null && "absolutePath" in entry
            ? (entry as { absolutePath?: unknown }).absolutePath
            : undefined;
        if (typeof path === "string" && path.trim()) paths.add(resolve(path));
        else invalid += 1;
      }
    } catch {
      invalid += 1;
    }
  }
  return { paths: [...paths], invalid };
}

export async function resetPlatformPrivateMedia(input: {
  rows: Array<{ attachmentsJson: string | null }>;
  scope: AdminResetMediaScope;
}): Promise<AdminResetPrivateMediaResult> {
  const dataRoot = resolve(input.scope.dataRoot);
  const outgoingRoot = resolve(input.scope.outgoingAttachmentsRoot);
  if (!isStrictlyInside(dataRoot, outgoingRoot)) {
    throw new Error("Outgoing attachment root must be confined beneath the runner data root");
  }
  if (
    (await exists(outgoingRoot)) &&
    !(await isStrictlyInsideReal(dataRoot, outgoingRoot))
  ) {
    throw new Error("Outgoing attachment root resolves outside the runner data root");
  }
  const cacheRoot = input.scope.platformCacheRoot
    ? resolve(input.scope.platformCacheRoot)
    : null;
  if (cacheRoot && !isStrictlyInside(dataRoot, cacheRoot)) {
    throw new Error("Platform media cache root must be confined beneath the runner data root");
  }
  if (
    cacheRoot &&
    (await exists(cacheRoot)) &&
    !(await isStrictlyInsideReal(dataRoot, cacheRoot))
  ) {
    throw new Error("Platform media cache root resolves outside the runner data root");
  }

  let removedCacheRoots = 0;
  let removedStagedPaths = 0;
  const parsed = stagedPaths(input.rows);
  let skippedUnsafePaths = parsed.invalid;
  const removableParents = new Set<string>();
  for (const path of parsed.paths) {
    if (!isStrictlyInside(outgoingRoot, path)) {
      skippedUnsafePaths += 1;
      continue;
    }
    if (await exists(path)) {
      if (!(await isStrictlyInsideReal(outgoingRoot, path))) {
        skippedUnsafePaths += 1;
        continue;
      }
      await rm(path, { force: true });
      removedStagedPaths += 1;
    }
    const parent = dirname(path);
    if (isStrictlyInside(outgoingRoot, parent)) removableParents.add(parent);
  }
  for (const parent of removableParents) {
    try {
      if ((await readdir(parent)).length === 0) await rm(parent, { force: true });
    } catch {
      // A concurrent cleanup or upload can make the parent disappear/change.
    }
  }

  if (cacheRoot) {
    if (await exists(cacheRoot)) {
      await rm(cacheRoot, { recursive: true, force: true });
      removedCacheRoots = 1;
    }
  }

  return { removedCacheRoots, removedStagedPaths, skippedUnsafePaths };
}

export function isAdminResetEnabled(): boolean {
  const explicit = process.env.ADMIN_RESET_ENABLED;
  if (explicit !== undefined) {
    return envBool("ADMIN_RESET_ENABLED", false);
  }
  return isDev();
}

export function validateAdminResetGuards(input: {
  token: string | null | undefined;
  confirm: string | null | undefined;
}): void {
  if (!isAdminResetEnabled()) {
    throw new AdminResetGuardError("Admin reset is disabled in this environment.", 403, "reset_disabled");
  }

  const expectedToken = clean(process.env.ADMIN_RESET_TOKEN);
  if (!expectedToken) {
    throw new AdminResetGuardError(
      "ADMIN_RESET_TOKEN is not configured on the runner.",
      500,
      "missing_reset_token"
    );
  }

  if (clean(input.token) !== expectedToken) {
    throw new AdminResetGuardError("Invalid admin reset token.", 403, "invalid_reset_token");
  }

  if (clean(input.confirm) !== "RESET") {
    throw new AdminResetGuardError("Confirmation text must be RESET.", 400, "invalid_reset_confirmation");
  }
}

export async function resetPlatformInboxGraph(
  platform: PlatformName,
  prismaClient?: AdminResetPrisma,
  mediaScope?: AdminResetMediaScope
): Promise<AdminResetResult> {
  const client = prismaClient ?? (await resolvePrismaClient());
  const matchedThreadIds = await client.thread.findMany({
    where: { platform },
    select: { id: true }
  });
  const threadIds = matchedThreadIds.map((entry) => entry.id);
  let privateMedia: AdminResetPrivateMediaResult | undefined;
  if (mediaScope) {
    if (!client.sendRequest.findMany) {
      throw new Error("Admin reset media cleanup requires SendRequest attachment lookup");
    }
    const rows = await client.sendRequest.findMany({
      where: { thread: { platform } },
      select: { attachmentsJson: true }
    });
    privateMedia = await resetPlatformPrivateMedia({ rows, scope: mediaScope });
  }

  // Delete the child rows (sendRequest, draft, message) BEFORE the parent
  // thread rows. thread.deleteMany cascades to those children natively
  // (onDelete: Cascade with SQLite foreign_keys on), so if the thread delete
  // raced ahead of the child deletes the child deleteMany calls would count 0
  // and under-report. The three children are independent of each other, so
  // they can still run in parallel; only the thread delete must come after.
  const [sendRequests, drafts, messages] = await Promise.all([
    client.sendRequest.deleteMany({
      where: {
        thread: {
          platform
        }
      }
    }),
    client.draft.deleteMany({
      where: {
        thread: {
          platform
        }
      }
    }),
    client.message.deleteMany({
      where: {
        thread: {
          platform
        }
      }
    })
  ]);
  const threads = await client.thread.deleteMany({
    where: {
      platform
    }
  });

  const orphanPeople = await client.person.findMany({
    where: {
      platform,
      threads: {
        none: {}
      }
    },
    select: {
      id: true
    }
  });
  const orphanIds = orphanPeople.map((person) => person.id);
  const deletedOrphans =
    orphanIds.length > 0
      ? await client.person.deleteMany({
          where: {
            id: {
              in: orphanIds
            }
          }
        })
      : { count: 0 };

  return {
    platform,
    matchedThreadCount: threadIds.length,
    privateMedia,
    deleted: {
      sendRequests: sendRequests.count,
      drafts: drafts.count,
      messages: messages.count,
      threads: threads.count,
      orphanPeople: deletedOrphans.count
    }
  };
}
