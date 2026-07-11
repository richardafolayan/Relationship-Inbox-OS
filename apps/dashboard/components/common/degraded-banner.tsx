"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { PLATFORM_LABEL } from "@/lib/risk";

interface DegradedBannerProps {
  platform: "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | string;
  stage?: string;
  reason?: string;
  requestId?: string;
  errorSummary?: string;
  screenshotFile?: string;
  domDumpFile?: string;
  onRunSelectorTests?: () => void;
  onOpenReceipts?: () => void;
}

// Calm, single-sentence banner. The voice rule: "Something looks off on
// {platform}." - no shouty caps, no DEGRADED label. The action link is
// quiet and lives in the same row.
export function DegradedBanner({
  platform,
  onRunSelectorTests,
  onOpenReceipts
}: DegradedBannerProps) {
  const label =
    PLATFORM_LABEL[platform as "LINKEDIN" | "INSTAGRAM" | "TIKTOK"] ?? platform.toLowerCase();

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-row border border-hairline bg-paper-2 px-5 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-[14px] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] translate-y-[-1px] rounded-full bg-ink-3 align-middle" />
          {label} needs attention.
        </p>
        <p className="text-[12px] leading-[1.45] text-ink-3">
          The latest check did not finish, so this inbox may be out of date. Reconnect the account, then check again.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/settings#platforms" className="text-[12px] text-ink-2 underline-offset-2 hover:text-ink hover:underline">
          Open Settings
        </Link>
        {onRunSelectorTests ? (
          <Button variant="quiet" onClick={onRunSelectorTests}>
            Check connection
          </Button>
        ) : null}
        {onOpenReceipts ? (
          <Button variant="quiet" onClick={onOpenReceipts}>
            View diagnostics
          </Button>
        ) : null}
      </div>
    </div>
  );
}
