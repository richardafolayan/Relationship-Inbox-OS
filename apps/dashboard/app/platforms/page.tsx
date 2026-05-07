"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, PlatformCard } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { PLATFORM_LABEL } from "@/lib/risk";
import { Button } from "@/components/ui/button";
import { Canvas, PageHead, QuietRow } from "@/components/common/canvas";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

const PLATFORM_DISPLAY: Record<PlatformCard["platform"], string> = {
  LINKEDIN: "Linkedin",
  INSTAGRAM: "Instagram",
  TIKTOK: "Tiktok"
};

// Only platforms whose adapter has been hardened against the live UI are
// surfaced as actionable rows. Instagram and TikTok still flow through the
// runner so settings + future work can re-enable them, but the operator
// shouldn't see them as "Connect" rows on the main view yet.
const VISIBLE_PLATFORMS: ReadonlyArray<PlatformCard["platform"]> = ["LINKEDIN"];
const HIDDEN_PLATFORMS: ReadonlyArray<PlatformCard["platform"]> = ["INSTAGRAM", "TIKTOK"];

// Platforms: quiet rows for each platform we ship to operators. Name
// (title-case display), `last scan Xm ago` mono caption, status pill
// (dot + word), outlined "Open browser" / "Connect" button. No card
// wrappers.
export default function PlatformsPage() {
  const [rows, setRows] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [platforms, logRows] = await Promise.all([
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => []),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=150").catch(() => [])
    ]);
    setRows(platforms ?? []);
    setLogs(logRows ?? []);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  return (
    <Canvas>
      <PageHead eyebrow="Connected accounts" title="Platforms." />

      {actionError ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{actionError}</p>
      ) : null}

      {rows
        .filter((row) => VISIBLE_PLATFORMS.includes(row.platform) && row.status === "DEGRADED")
        .map((row) => (
          <DegradedBanner
            key={row.platform}
            platform={row.platform}
            stage={row.lastScanFailure?.stage}
            reason={row.lastScanFailure?.reason}
            requestId={row.lastScanFailure?.requestId}
            errorSummary={row.lastScanFailure?.errorSummary ?? row.lastError ?? undefined}
            screenshotFile={row.lastScanFailure?.screenshotFile}
            domDumpFile={
              row.lastScanFailure?.domDumpFile ??
              logs.find((log) => log.platform === row.platform && log.domDumpFile)?.domDumpFile
            }
            onRunSelectorTests={() =>
              runAction(
                apiPost("/runner/control/platform/test-selectors", { platform: row.platform }),
                setActionError,
                refresh
              )
            }
            onOpenReceipts={() => setReceiptsOpen(true)}
          />
        ))}

      {rows
        .filter((row) => VISIBLE_PLATFORMS.includes(row.platform))
        .map((row) => {
        const dot =
          row.status === "CONNECTED"
            ? "bg-risk-fresh"
            : row.status === "DEGRADED"
              ? "bg-risk-waiting"
              : row.status === "ERROR"
                ? "bg-risk-overdue"
                : "bg-ink-4";
        const label =
          row.status === "CONNECTED"
            ? "connected"
            : row.status === "DEGRADED"
              ? "needs a look"
              : row.status === "ERROR"
                ? "error"
                : "not connected";
        return (
          <QuietRow
            key={row.platform}
            name={PLATFORM_DISPLAY[row.platform]}
            stat={
              row.lastScanAt
                ? `last scan ${formatRelative(row.lastScanAt)}`
                : row.lastError ?? "sign in to enable"
            }
            status={
              <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-ink-2">
                <span className={`h-[6px] w-[6px] rounded-full ${dot}`} />
                {label}
              </span>
            }
            action={
              <div className="flex items-center gap-2">
                <Button
                  variant="quiet"
                  onClick={() =>
                    runAction(
                      apiPost("/runner/control/platform/open-browser", { platform: row.platform }),
                      setActionError
                    )
                  }
                >
                  {row.status === "CONNECTED" ? "Open browser" : "Connect"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    runAction(
                      apiPost("/runner/control/scan", { platform: row.platform }),
                      setActionError,
                      refresh
                    )
                  }
                >
                  Scan now
                </Button>
              </div>
            }
          />
        );
      })}

      {rows.filter((row) => VISIBLE_PLATFORMS.includes(row.platform)).length === 0 ? (
        <p className="mt-10 font-mono text-[12px] text-ink-3">No platforms reported by the runner.</p>
      ) : null}

      <p className="mt-10 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
        <button
          type="button"
          onClick={() => setReceiptsOpen(true)}
          className="hover:text-ink"
        >
          open receipts
        </button>
        {" · "}
        {HIDDEN_PLATFORMS.map((p) => PLATFORM_LABEL[p]).join(", ")} coming later
      </p>

      <ReceiptsDrawer
        open={receiptsOpen}
        onClose={() => setReceiptsOpen(false)}
        rows={logs}
        title="Platform receipts"
      />
    </Canvas>
  );
}
