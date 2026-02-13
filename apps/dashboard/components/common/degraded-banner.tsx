"use client";

import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DegradedBannerProps {
  platform: string;
  domDumpFile?: string;
  onRunSelectorTests?: () => void;
  onOpenReceipts?: () => void;
}

export function DegradedBanner({ platform, domDumpFile, onRunSelectorTests, onOpenReceipts }: DegradedBannerProps) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-warningSoft px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-amber-900">
        <AlertTriangle className="h-4 w-4" />
        <span>{platform} scan degraded. We saved a screenshot + DOM dump. Run selector tests to fix.</span>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={onRunSelectorTests}>
          Run selector tests
        </Button>
        <Button variant="ghost" onClick={onOpenReceipts}>
          Open receipts
        </Button>
        {domDumpFile ? (
          <a className="text-sm font-medium text-blue-700 hover:underline" href={`/artifacts/dom_dumps/${domDumpFile}`} target="_blank">
            Open DOM dump
          </a>
        ) : null}
      </div>
    </div>
  );
}
