"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DegradedBannerProps {
  platform: string;
  stage?: string;
  reason?: string;
  requestId?: string;
  errorSummary?: string;
  screenshotFile?: string;
  domDumpFile?: string;
  onRunSelectorTests?: () => void;
  onOpenReceipts?: () => void;
}

export function DegradedBanner({
  platform,
  stage,
  reason,
  requestId,
  errorSummary,
  screenshotFile,
  domDumpFile,
  onRunSelectorTests,
  onOpenReceipts
}: DegradedBannerProps) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-warningSoft px-4 py-3">
      <div className="flex flex-col gap-1 text-sm text-amber-900">
        <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" />
        <span>{platform} scan degraded. We saved a screenshot + DOM dump. Run selector tests to fix.</span>
        </div>
        {errorSummary ? <p className="text-xs text-amber-950">{errorSummary}</p> : null}
        {(stage || reason || requestId) ? (
          <p className="text-xs text-amber-900/90">
            Stage: {stage ?? "n/a"}{reason ? ` · Reason: ${reason}` : ""}{requestId ? ` · Request: ${requestId}` : ""}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={onRunSelectorTests}>
          Run selector tests
        </Button>
        <Button variant="ghost" onClick={onOpenReceipts}>
          Open receipts
        </Button>
        {screenshotFile ? (
          <a className="text-sm font-medium text-blue-700 hover:underline" href={`/artifacts/screenshots/${screenshotFile}`} target="_blank">
            Open screenshot
          </a>
        ) : null}
        {domDumpFile ? (
          <a className="text-sm font-medium text-blue-700 hover:underline" href={`/artifacts/dom_dumps/${domDumpFile}`} target="_blank">
            Open DOM dump
          </a>
        ) : null}
      </div>
    </div>
  );
}
