"use client";

import { Button } from "@/components/ui/button";
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
// {platform}." — no shouty caps, no DEGRADED label. The action link is
// quiet and lives in the same row.
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
  const label =
    PLATFORM_LABEL[platform as "LINKEDIN" | "INSTAGRAM" | "TIKTOK"] ?? platform.toLowerCase();

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-row border border-hairline bg-paper-2 px-5 py-3">
      <div className="flex flex-col gap-1">
        <p className="text-[14px] text-ink">
          <span className="mr-2 inline-block h-[6px] w-[6px] translate-y-[-1px] rounded-full bg-risk-overdue align-middle" />
          Something looks off on {label}.{" "}
          {onRunSelectorTests ? (
            <button
              type="button"
              onClick={onRunSelectorTests}
              className="text-accent-ink underline-offset-2 hover:underline"
            >
              Run selector tests
            </button>
          ) : null}
          {onRunSelectorTests && onOpenReceipts ? <span className="mx-2 text-ink-3">·</span> : null}
          {onOpenReceipts ? (
            <button
              type="button"
              onClick={onOpenReceipts}
              className="text-ink-2 underline-offset-2 hover:underline"
            >
              Open receipts
            </button>
          ) : null}
        </p>
        {errorSummary ? <p className="font-mono text-[11px] text-ink-3">{errorSummary}</p> : null}
        {stage || reason || requestId ? (
          <p className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
            {stage ? `stage ${stage}` : ""}
            {reason ? ` · ${reason}` : ""}
            {requestId ? ` · ${requestId}` : ""}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {screenshotFile ? (
          <a
            href={`/artifacts/screenshots/${screenshotFile}`}
            target="_blank"
            className="font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            rel="noreferrer"
          >
            screenshot
          </a>
        ) : null}
        {domDumpFile ? (
          <a
            href={`/artifacts/dom_dumps/${domDumpFile}`}
            target="_blank"
            className="font-mono text-[11px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            rel="noreferrer"
          >
            dom dump
          </a>
        ) : null}
        {onRunSelectorTests ? (
          <Button variant="quiet" onClick={onRunSelectorTests}>
            Run tests
          </Button>
        ) : null}
      </div>
    </div>
  );
}
