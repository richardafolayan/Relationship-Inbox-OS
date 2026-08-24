"use client";

import { Button } from "@/components/ui/button";
import { InlineActionButton } from "@/components/common/inline-action-button";
import type { InlineActionState } from "@/lib/feedback";
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
  selectorActionState?: InlineActionState | null;
  onOpenReceipts?: () => void;
}

// Calm, single-sentence banner. The voice rule: "Something looks off on
// {platform}." - no shouty caps, no DEGRADED label. The action link is
// quiet and stays with the recovery controls.
export function DegradedBanner({
  platform,
  onRunSelectorTests,
  selectorActionState,
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
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/settings#platforms" className="text-[12px] text-ink-2 underline-offset-2 hover:text-ink hover:underline">
          Open Settings
        </Link>
        {onRunSelectorTests ? (
          <InlineActionButton
            idleLabel="Check connection"
            state={selectorActionState}
            onClick={onRunSelectorTests}
            className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill border border-hairline px-[18px] py-[11px] text-sm font-medium tracking-[-0.005em] text-ink-2 transition-[transform,background-color,border-color,color] duration-calm ease-out hover:border-hairline-strong hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          />
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
