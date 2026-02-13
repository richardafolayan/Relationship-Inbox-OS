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
    const record = await prisma.auditLog.create({
      data: {
        platform: input.platform,
        stage: input.stage,
        action: input.action,
        status: input.status as AuditStatus,
        detailsJson: input.details ? JSON.stringify(input.details) : undefined,
        screenshotFile: input.screenshotFile,
        domDumpFile: input.domDumpFile
      }
    });

    return record.id;
  }

  return {
    log
  };
}
