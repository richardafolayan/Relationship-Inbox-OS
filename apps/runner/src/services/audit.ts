import type { PlatformName } from "@inbox-os/core";
import type { AuditStatus } from "@prisma/client";
import { prisma } from "../db";
import { sanitizePlatformAuditInput } from "./platform-diagnostics";

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
    const safeInput = sanitizePlatformAuditInput(input);
    // Mirror details.threadId into the indexed column so per-thread receipt
    // lookups are an index read instead of a detailsJson LIKE-scan.
    const threadId =
      safeInput.platform !== "INSTAGRAM" &&
      safeInput.details &&
      typeof safeInput.details.threadId === "string"
        ? safeInput.details.threadId
        : undefined;
    const record = await prisma.auditLog.create({
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
