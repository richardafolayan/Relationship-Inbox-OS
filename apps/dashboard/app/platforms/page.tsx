"use client";

import { useCallback, useEffect, useState } from "react";
import { Info, MoreVertical } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import { runActionWithFeedback } from "@/lib/feedback";
import type { AuditLogRow, PlatformCard } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { Canvas, PageHead } from "@/components/common/canvas";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { MacContactsHint } from "@/components/common/mac-contacts-hint";
import { classifyConsumerFailure } from "@/lib/consumer-failure";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { cn } from "@/lib/utils";

const PLATFORM_DISPLAY: Record<PlatformCard["platform"], string> = {
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  IMESSAGE: "iMessage",
  WHATSAPP: "WhatsApp",
  GOOGLE_MESSAGES: "Google Messages"
};

const PLATFORM_GLYPH: Record<PlatformCard["platform"], string> = {
  LINKEDIN: "in",
  IMESSAGE: "iM",
  INSTAGRAM: "ig",
  TIKTOK: "tt",
  WHATSAPP: "wa",
  GOOGLE_MESSAGES: "gm"
};

// Platforms - 2-up card grid. Each card: glyph, name, connection status,
// last scan, one primary action, and a secondary More menu for recovery.
export default function PlatformsPage() {
  const [rows, setRows] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState<PlatformCard["platform"] | null>(null);

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

  const visibleRows = rows;
  const connected = visibleRows.filter((row) => row.status === "CONNECTED").length;
  const total = visibleRows.length;

  return (
    <Canvas>
      <PageHead
        eyebrow="Connected accounts"
        title="Platforms"
        meta={
          <span>
            <strong className="font-medium text-ink">{connected}</strong>/{total} active
          </span>
        }
      />

      {actionError ? (
        <p className="mb-6 rounded-row border border-hairline bg-paper-2 px-4 py-3 text-[12px] leading-[1.5] text-ink-2">{actionError}</p>
      ) : null}

      {/* iMessage names show as numbers when this Mac's Contacts app is empty
          (issue #676). Renders nothing unless the runner confirms it. */}
      <MacContactsHint />

      {visibleRows
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

      <div className="grid grid-cols-1 gap-3 sm:gap-[14px] md:grid-cols-2">
        {visibleRows.map((row) => (
          <PlatformCardView
            key={row.platform}
            row={row}
            detailOpen={detailOpen === row.platform}
            onToggleDetail={() =>
              setDetailOpen((cur) => (cur === row.platform ? null : row.platform))
            }
            setActionError={setActionError}
            refresh={refresh}
          />
        ))}
      </div>

      <div className="mt-10 flex justify-end font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
        <button
          type="button"
          onClick={() => setReceiptsOpen(true)}
          className="hover:text-ink"
        >
          open receipts
        </button>
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

interface PlatformCardViewProps {
  row: PlatformCard;
  detailOpen: boolean;
  onToggleDetail: () => void;
  setActionError: (message: string | null) => void;
  refresh: () => Promise<void> | void;
}

function PlatformCardView({
  row,
  detailOpen,
  onToggleDetail,
  setActionError,
  refresh
}: PlatformCardViewProps) {
  const display = PLATFORM_DISPLAY[row.platform];
  const glyph = PLATFORM_GLYPH[row.platform];
  const supported = row.supported !== false;
  const connected = row.status === "CONNECTED";
  const scanEligible =
    connected || row.status === "DEGRADED" || row.status === "ERROR";
  const statusToken =
    !supported
      ? { className: "text-ink-3", label: "Not available" }
      : connected
        ? { className: "text-risk-fresh", label: "Connected" }
        : row.status === "DEGRADED"
          ? { className: "text-risk-waiting", label: "Needs a look" }
          : row.status === "ERROR"
            ? { className: "text-ink-2", label: "Needs attention" }
            : { className: "text-ink-3", label: "Not connected" };

  const lastScanLine = !supported
    ? "macOS only"
    : row.lastScanAt
      ? `Last scanned ${formatRelative(row.lastScanAt)}`
      : scanEligible
        ? "Not scanned yet"
        : null;

  const connectHint =
    !row.lastScanAt && row.lastError && !scanEligible
      ? classifyConsumerFailure(new Error(row.lastError), {
          path: "/runner/control/platform/connect",
          method: "POST"
        }).message
      : !scanEligible && supported
        ? "Sign in to enable"
        : null;

  const report = row.latestSelectorReport;
  const passes = report?.results.filter((r) => r.status === "PASS").length ?? 0;
  const totalSelectors = report?.results.length ?? 0;

  const primaryLabel = !supported
    ? "Not available"
    : scanEligible
      ? "Scan now"
      : "Connect";

  const runPrimary = () => {
    if (!supported) return;
    if (scanEligible) {
      runActionWithFeedback(apiPost("/runner/control/scan", { platform: row.platform }), {
        pending: `Scanning ${display}…`,
        success: `${display} scan queued`,
        failure: `${display} scan failed`,
        setError: setActionError,
        onDone: () => refresh()
      });
      return;
    }
    runActionWithFeedback(
      apiPost("/runner/control/platform/open-browser", { platform: row.platform }),
      {
        pending: `Opening ${display}…`,
        success: `${display} opened`,
        failure: `Couldn't open ${display}`,
        setError: setActionError
      }
    );
  };

  const moreItems: MenuItem[] = [
    ...(scanEligible
      ? [
          {
            label: "Open browser",
            onSelect: () =>
              runActionWithFeedback(
                apiPost("/runner/control/platform/open-browser", { platform: row.platform }),
                {
                  pending: `Opening ${display}…`,
                  success: `${display} opened`,
                  failure: `Couldn't open ${display}`,
                  setError: setActionError
                }
              )
          },
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
          !window.confirm(`Reset the ${display} session? You'll need to sign in again.`)
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
  ];

  return (
    <article className="rounded-[16px] border border-hairline bg-paper">
      <div className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-x-3 gap-y-3 px-4 py-4 sm:grid-cols-[36px_1fr_auto] sm:gap-[14px] sm:px-[20px] sm:py-[18px]">
        <span
          aria-hidden
          className="grid h-[36px] w-[36px] place-items-center rounded-[10px] bg-paper-2 font-mono text-[14px] font-semibold text-ink-2"
        >
          {glyph}
        </span>
        <div className="min-w-0">
          <h4 className="m-0 mb-[2px] flex items-center gap-2 font-display text-[16px] font-semibold tracking-[-0.01em] text-ink">
            {display}
          </h4>
          <p
            className={cn("m-0 text-[13px] font-medium", statusToken.className)}
            data-testid="platform-connection-status"
          >
            {statusToken.label}
          </p>
          {lastScanLine ? (
            <p className="m-0 mt-0.5 font-mono text-[11px] text-ink-3" data-testid="platform-last-scan">
              {lastScanLine}
            </p>
          ) : null}
          {connectHint ? (
            <p className="m-0 mt-0.5 font-mono text-[11px] text-ink-3">{connectHint}</p>
          ) : null}
          {report ? (
            <p className="m-0 mt-0.5 font-mono text-[11px] text-ink-3">
              selectors {passes}/{totalSelectors}
            </p>
          ) : null}
        </div>
        <div className="col-span-2 flex items-center justify-end gap-2 sm:col-auto sm:justify-start">
          <button
            type="button"
            onClick={onToggleDetail}
            aria-label="Profile details"
            aria-expanded={detailOpen}
            className="grid h-[40px] w-[40px] place-items-center rounded-[10px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
            title="Profile details"
          >
            <Info className="h-[14px] w-[14px]" strokeWidth={1.6} />
          </button>
          {supported ? (
            <Button
              variant="quiet"
              className="min-h-[40px] px-[14px] py-[8px] text-[12.5px]"
              onClick={runPrimary}
            >
              {primaryLabel}
            </Button>
          ) : (
            <Button variant="quiet" className="min-h-[40px] px-[14px] py-[8px] text-[12.5px]" disabled>
              Not available
            </Button>
          )}
          {supported ? (
            <Menu
              trigger={
                <button
                  type="button"
                  aria-label="More actions"
                  className="grid h-[40px] w-[40px] place-items-center rounded-[10px] border border-hairline text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
                  title="More"
                >
                  <MoreVertical className="h-[14px] w-[14px]" strokeWidth={2} />
                </button>
              }
              items={moreItems}
            />
          ) : null}
        </div>
      </div>

      {detailOpen ? (
        <div className="border-t border-hairline px-4 py-4 sm:px-[20px] sm:py-[16px]">
          <div className="grid grid-cols-1 gap-x-8 gap-y-1 font-mono text-[12px] text-ink-2 sm:grid-cols-2">
            <p className="m-0">
              profile dir <span className="text-ink-3">·</span>{" "}
              <span className="text-ink-3">{row.profileDir}</span>
            </p>
            {row.browserProfileMode ? (
              <p className="m-0">
                browser mode <span className="text-ink-3">·</span>{" "}
                <span className="text-ink-3">{row.browserProfileMode}</span>
              </p>
            ) : null}
            {row.browserProfileName ? (
              <p className="m-0">
                profile <span className="text-ink-3">·</span>{" "}
                <span className="text-ink-3">{row.browserProfileName}</span>
              </p>
            ) : null}
            {row.connectedAt ? (
              <p className="m-0">
                connected <span className="text-ink-3">·</span>{" "}
                <span className="text-ink-3">{formatRelative(row.connectedAt)}</span>
              </p>
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
            <p className="mt-3 font-mono text-[12px] text-ink-3">
              No selector report yet. Run selector tests to generate one.
            </p>
          )}
        </div>
      ) : null}
    </article>
  );
}
