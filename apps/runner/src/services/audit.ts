import type { PlatformName } from "@inbox-os/core";
import type { AuditStatus } from "@prisma/client";
import { prisma } from "../db";

interface AuditInput {
  platform?: PlatformName;
  stage?: string;
  action: string;
  status: "OK" | "FAIL";
  details?: Record<string, unknown>;
  screenshotFile?: string;
  domDumpFile?: string;
}

export function createAuditService() {
  async function log(input: AuditInput): Promise<string> {
    // Mirror details.threadId into the indexed column so per-thread receipt
    // lookups are an index read instead of a detailsJson LIKE-scan.
    const threadId =
      input.details && typeof input.details.threadId === "string"
        ? input.details.threadId
        : undefined;
    const record = await prisma.auditLog.create({
      data: {
        platform: input.platform,
        stage: input.stage,
        action: input.action,
        status: input.status as AuditStatus,
        detailsJson: input.details ? JSON.stringify(input.details) : undefined,
        screenshotFile: input.screenshotFile,
        domDumpFile: input.domDumpFile,
        threadId
      }
    });

    return record.id;
  }

  return {
    log
  };
}
