import type { PlatformName } from "@inbox-os/core";
import type { AuditStatus } from "@prisma/client";
import { prisma } from "../db";
import { sanitizePlatformAuditInput } from "./platform-diagnostics";

interface AuditPrisma {
  thread: {
    findUnique(input: {
      where: { id: string };
      select: { platform: true };
    }): Promise<{ platform: PlatformName } | null>;
  };
  auditLog: {
    create(input: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

interface AuditInput {
  platform?: PlatformName;
  stage?: string;
  action: string;
  status: "OK" | "FAIL";
  details?: Record<string, unknown>;
  screenshotFile?: string;
  domDumpFile?: string;
}

export function createAuditService(prismaClient: AuditPrisma = prisma as unknown as AuditPrisma) {
  const threadPlatforms = new Map<string, PlatformName>();

  async function log(input: AuditInput): Promise<string> {
    const hintedThreadId =
      input.details && typeof input.details.threadId === "string"
        ? input.details.threadId
        : undefined;
    let actualPlatform = input.platform;
    if (hintedThreadId) {
      const cachedPlatform = threadPlatforms.get(hintedThreadId);
      if (cachedPlatform) {
        actualPlatform = cachedPlatform;
      } else {
        const thread = await prismaClient.thread
          .findUnique({ where: { id: hintedThreadId }, select: { platform: true } })
          .catch(() => null);
        if (thread?.platform) {
          actualPlatform = thread.platform;
          if (threadPlatforms.size >= 4096) {
            threadPlatforms.delete(threadPlatforms.keys().next().value!);
          }
          threadPlatforms.set(hintedThreadId, thread.platform);
        }
      }
    }
    const safeInput = sanitizePlatformAuditInput({ ...input, platform: actualPlatform });
    // Mirror details.threadId into the indexed column so per-thread receipt
    // lookups are an index read instead of a detailsJson LIKE-scan.
    const threadId =
      safeInput.platform !== "INSTAGRAM" &&
      safeInput.details &&
      typeof safeInput.details.threadId === "string"
        ? safeInput.details.threadId
        : undefined;
    const record = await prismaClient.auditLog.create({
      data: {
        platform: safeInput.platform,
        stage: safeInput.stage,
        action: safeInput.action,
        status: safeInput.status as AuditStatus,
        detailsJson: safeInput.details ? JSON.stringify(safeInput.details) : undefined,
        screenshotFile: safeInput.screenshotFile,
        domDumpFile: safeInput.domDumpFile,
        threadId
      }
    });

    return record.id;
  }

  return {
    log
  };
}
