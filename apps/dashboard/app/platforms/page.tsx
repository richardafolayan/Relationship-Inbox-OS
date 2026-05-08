"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import { runActionWithFeedback } from "@/lib/feedback";
import type { AuditLogRow, PlatformCard } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { PLATFORM_LABEL } from "@/lib/risk";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import { Canvas, PageHead } from "@/components/common/canvas";
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
      <PageHead
        eyebrow="Connected accounts"
        title="Platforms"
        subtitle="Manage browser sessions, run scans, and inspect selector health for each platform."
      />

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
        const statusClass =
          row.status === "CONNECTED"
            ? "bg-risk-fresh/15 text-risk-fresh"
            : row.status === "DEGRADED"
              ? "bg-risk-waiting/15 text-risk-waiting"
              : row.status === "ERROR"
                ? "bg-risk-overdue/15 text-risk-overdue"
                : "bg-paper-2 text-ink-3";
        const label =
          row.status === "CONNECTED"
            ? "Connected"
            : row.status === "DEGRADED"
              ? "Needs a look"
              : row.status === "ERROR"
                ? "Error"
                : "Not connected";
        const report = row.latestSelectorReport;
        const passes = report?.results.filter((r) => r.status === "PASS").length ?? 0;
        const total = report?.results.length ?? 0;
        return (
          <details
            key={row.platform}
            className="group border-t border-hairline px-1 py-[18px] last:border-b last:border-hairline"
          >
            <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto_auto] items-center gap-6">
              <div>
                <div className="flex items-center gap-3">
                  <p className="m-0 font-display text-[18px] font-medium tracking-[-0.012em] text-ink">
                    {PLATFORM_DISPLAY[row.platform]}
                  </p>
                  <span
                    className={`inline-flex items-center rounded-[6px] px-[8px] py-[2px] text-[11px] font-medium uppercase tracking-[0.04em] ${statusClass}`}
                  >
                    {label}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[12px] text-ink-3">
                  {row.lastScanAt ? `last scan ${formatRelative(row.lastScanAt)}` : row.lastError ?? "sign in to enable"}
                  {report ? ` · selectors ${passes}/${total} passing` : ""}
                </p>
              </div>
              <div className="flex items-center gap-1 text-[12px] text-ink-3 group-open:text-ink">
                <span className="hover:text-ink">Profile details ▾</span>
              </div>
              <div className="flex items-center gap-2" onClick={(e) => e.preventDefault()}>
                <Button
                  variant="quiet"
                  onClick={() =>
                    runActionWithFeedback(
                      apiPost("/runner/control/platform/open-browser", { platform: row.platform }),
                      {
                        pending: `Opening ${PLATFORM_DISPLAY[row.platform]}…`,
                        success: `${PLATFORM_DISPLAY[row.platform]} opened`,
                        failure: `Couldn't open ${PLATFORM_DISPLAY[row.platform]}`,
                        setError: setActionError
                      }
                    )
                  }
                >
                  {row.status === "CONNECTED" ? "Open browser" : "Connect"}
                </Button>
                <Menu
                  trigger={
                    <Button variant="ghost" aria-label="More actions">
                      More ▾
                    </Button>
                  }
                  items={[
                    {
                      label: "Scan now",
                      onSelect: () =>
                        runActionWithFeedback(
                          apiPost("/runner/control/scan", { platform: row.platform }),
                          {
                            pending: `Scanning ${PLATFORM_DISPLAY[row.platform]}…`,
                            success: `${PLATFORM_DISPLAY[row.platform]} scan queued`,
                            failure: `${PLATFORM_DISPLAY[row.platform]} scan failed`,
                            setError: setActionError,
                            onDone: () => refresh()
                          }
                        )
                    },
                    ...(row.status === "CONNECTED"
                      ? [
                          {
                            label: "Reconnect",
                            onSelect: () =>
                              runAction(
                                apiPost("/runner/control/platform/connect", { platform: row.platform }),
                                setActionError,
                                refresh
                              )
                          }
                        ]
                      : []),
                    {
                      label: "Run selector tests",
                      onSelect: () =>
                        runAction(
                          apiPost("/runner/control/platform/test-selectors", { platform: row.platform }),
                          setActionError,
                          refresh
                        )
                    },
                    {
                      label: "Reset session…",
                      danger: true,
                      onSelect: () => {
                        if (
                          !window.confirm(
                            `Reset the ${PLATFORM_DISPLAY[row.platform]} session? You'll need to sign in again.`
                          )
                        ) {
                          return;
                        }
                        runAction(
                          apiPost("/runner/control/platform/reset-session", { platform: row.platform }),
                          setActionError,
                          refresh
                        );
                      }
                    }
                  ]}
                />
              </div>
            </summary>

            <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 font-mono text-[12px] text-ink-2">
              <p className="m-0">profile dir <span className="text-ink-3">·</span> <span className="text-ink-3">{row.profileDir}</span></p>
              {row.browserProfileMode ? (
                <p className="m-0">browser mode <span className="text-ink-3">·</span> <span className="text-ink-3">{row.browserProfileMode}</span></p>
              ) : null}
              {row.browserProfileName ? (
                <p className="m-0">profile <span className="text-ink-3">·</span> <span className="text-ink-3">{row.browserProfileName}</span></p>
              ) : null}
              {row.connectedAt ? (
                <p className="m-0">connected <span className="text-ink-3">·</span> <span className="text-ink-3">{formatRelative(row.connectedAt)}</span></p>
              ) : null}
            </div>

            {report ? (
              <div className="mt-4 rounded-[10px] border border-hairline bg-paper-2/50 p-4">
                <p className="m-0 mb-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                  Latest selector report · {formatRelative(report.completedAt)}
                </p>
                <ul className="m-0 space-y-1 text-[12px]">
                  {report.results.map((r) => (
                    <li key={r.key} className="flex items-center gap-2">
                      <span
                        className={`h-[6px] w-[6px] rounded-full ${
                          r.status === "PASS" ? "bg-risk-fresh" : "bg-risk-overdue"
                        }`}
                      />
                      <span className="text-ink-2">{r.key}</span>
                      <span className="text-ink-3">·</span>
                      <span className="text-ink-3">{r.count} hits</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-4 font-mono text-[12px] text-ink-3">
                No selector report yet. Run selector tests to generate one.
              </p>
            )}
          </details>
        );
      })}

      {rows.filter((row) => VISIBLE_PLATFORMS.includes(row.platform)).length === 0 ? (
        <p className="mt-10 font-mono text-[12px] text-ink-3">No platforms reported by the runner.</p>
      ) : null}

      <div className="mt-10 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
        <button
          type="button"
          onClick={() => setReceiptsOpen(true)}
          className="hover:text-ink"
        >
          open receipts
        </button>
        <span>
          {HIDDEN_PLATFORMS.map((p) => PLATFORM_LABEL[p]).join(", ")} coming later
        </span>
      </div>

      <ReceiptsDrawer
        open={receiptsOpen}
        onClose={() => setReceiptsOpen(false)}
        rows={logs}
        title="Platform receipts"
      />
    </Canvas>
  );
}
