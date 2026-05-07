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

// Platforms: three quiet rows. Name (title-case display), `last scan Xm
// ago` mono caption, status pill (dot + word), outlined "Open browser" /
// "Connect" button. No card wrappers.
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
        .filter((row) => row.status === "DEGRADED")
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

      {rows.filter((row) => row.enabled).map((row) => {
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
        const selectorReport = row.latestSelectorReport;
        const selectorPasses = selectorReport
          ? selectorReport.results.filter((r) => r.status === "PASS").length
          : 0;
        const selectorTotal = selectorReport?.results.length ?? 0;
        return (
          <div
            key={row.platform}
            className="border-b border-hairline last:border-b-0"
          >
            <QuietRow
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
                <div className="flex flex-wrap items-center gap-2">
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
                  {row.status === "CONNECTED" ? (
                    <Button
                      variant="quiet"
                      onClick={() =>
                        runAction(
                          apiPost("/runner/control/platform/connect", { platform: row.platform }),
                          setActionError,
                          refresh
                        )
                      }
                    >
                      Reconnect
                    </Button>
                  ) : null}
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
                  <Button
                    variant="ghost"
                    onClick={() =>
                      runAction(
                        apiPost("/runner/control/platform/test-selectors", {
                          platform: row.platform
                        }),
                        setActionError,
                        refresh
                      )
                    }
                  >
                    Run selector tests
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Reset shared session for ${PLATFORM_DISPLAY[row.platform]}? This signs you out of the runner's browser profile.`
                        )
                      ) {
                        return;
                      }
                      runAction(
                        apiPost("/runner/control/platform/reset-session", {
                          platform: row.platform
                        }),
                        setActionError,
                        refresh
                      );
                    }}
                  >
                    Reset shared session
                  </Button>
                </div>
              }
            />
            <details className="px-1 pb-4">
              <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink">
                Profile details
              </summary>
              <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 font-mono text-[11px] text-ink-3">
                <dt>profile dir</dt>
                <dd className="break-all text-ink-2">{row.profileDir}</dd>
                {row.browserProfileMode ? (
                  <>
                    <dt>profile mode</dt>
                    <dd className="text-ink-2">{row.browserProfileMode}</dd>
                  </>
                ) : null}
                {row.browserProfileSyncMode ? (
                  <>
                    <dt>sync mode</dt>
                    <dd className="text-ink-2">{row.browserProfileSyncMode}</dd>
                  </>
                ) : null}
                {row.browserProfileName ? (
                  <>
                    <dt>chrome profile</dt>
                    <dd className="text-ink-2">{row.browserProfileName}</dd>
                  </>
                ) : null}
                {row.connectedAt ? (
                  <>
                    <dt>connected</dt>
                    <dd className="text-ink-2">{formatRelative(row.connectedAt)}</dd>
                  </>
                ) : null}
                {selectorReport ? (
                  <>
                    <dt>selector report</dt>
                    <dd className="text-ink-2">
                      {selectorPasses}/{selectorTotal} passed —{" "}
                      {formatRelative(selectorReport.completedAt)}
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>selector report</dt>
                    <dd className="text-ink-3">none yet — run selector tests to generate</dd>
                  </>
                )}
              </dl>
            </details>
          </div>
        );
      })}

      {rows.length === 0 ? (
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
        {PLATFORM_LABEL.LINKEDIN}, {PLATFORM_LABEL.INSTAGRAM}, {PLATFORM_LABEL.TIKTOK}
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
