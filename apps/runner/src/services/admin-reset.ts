import type { PlatformName } from "@inbox-os/core";
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
}

interface AdminResetPrisma {
  thread: {
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
  };
  sendRequest: {
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
  prismaClient?: AdminResetPrisma
): Promise<AdminResetResult> {
  const client = prismaClient ?? (await resolvePrismaClient());
  const matchedThreadIds = await client.thread.findMany({
    where: { platform },
    select: { id: true }
  });
  const threadIds = matchedThreadIds.map((entry) => entry.id);

  const [sendRequests, drafts, messages, threads] = await Promise.all([
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
    }),
    client.thread.deleteMany({
      where: {
        platform
      }
    })
  ]);

  const orphanPeople = await client.person.findMany({
    where: {
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
    deleted: {
      sendRequests: sendRequests.count,
      drafts: drafts.count,
      messages: messages.count,
      threads: threads.count,
      orphanPeople: deletedOrphans.count
    }
  };
}
