"use client";

import { useCallback, useEffect, useState } from "react";
import { Info, MoreVertical } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import { runActionWithFeedback } from "@/lib/feedback";
import type { AuditLogRow, PlatformCard } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { IMPLEMENTED_PLATFORMS } from "@/lib/risk";
import { Button } from "@/components/ui/button";
import { Menu } from "@/components/ui/menu";
import { Canvas, PageHead } from "@/components/common/canvas";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { MacContactsHint } from "@/components/common/mac-contacts-hint";
import { classifyConsumerFailure } from "@/lib/consumer-failure";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

const PLATFORM_DISPLAY: Record<PlatformCard["platform"], string> = {
  LINKEDIN: "LinkedIn",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
  IMESSAGE: "iMessage",
  WHATSAPP: "WhatsApp"
};

const PLATFORM_GLYPH: Record<PlatformCard["platform"], string> = {
  LINKEDIN: "in",
  IMESSAGE: "iM",
  INSTAGRAM: "ig",
  TIKTOK: "tt",
  WHATSAPP: "wa"
};

const VISIBLE_PLATFORMS = IMPLEMENTED_PLATFORMS;
const COMING_SOON_PLATFORMS: ReadonlyArray<PlatformCard["platform"]> = (
  ["INSTAGRAM", "TIKTOK", "LINKEDIN", "IMESSAGE"] as const
).filter((p) => !IMPLEMENTED_PLATFORMS.includes(p));

// Platforms - 2-up card grid. Each card: glyph (left), name + one-line
// status (centre), icon row of actions (right). Coming-soon platforms
// get dashed empty cards in the same grid instead of a footer note, so
// the future state previews rather than disclaims. See section 03 of the
// redesign doc.
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

  const visibleRows = rows.filter((row) => VISIBLE_PLATFORMS.includes(row.platform));
  const connected = visibleRows.filter((row) => row.status === "CONNECTED").length;
  const total = visibleRows.length || VISIBLE_PLATFORMS.length;

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

      <div className="grid grid-cols-1 gap-[14px] md:grid-cols-2">
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
        {COMING_SOON_PLATFORMS.map((platform) => (
          <EmptyPlatformCard key={platform} platform={platform} />
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
  const statusToken =
    row.status === "CONNECTED"
      ? { className: "text-risk-fresh", label: "connected" }
      : row.status === "DEGRADED"
        ? { className: "text-risk-waiting", label: "needs a look" }
        : row.status === "ERROR"
          ? { className: "text-ink-2", label: "needs attention" }
          : { className: "text-ink-3", label: "not connected" };

  const scanLine = row.lastScanAt
    ? `last scan ${formatRelative(row.lastScanAt)}`
    : row.lastError
      ? classifyConsumerFailure(new Error(row.lastError), {
          path: "/runner/control/platform/connect",
          method: "POST"
        }).message
      : "sign in to enable";

  const report = row.latestSelectorReport;
  const passes = report?.results.filter((r) => r.status === "PASS").length ?? 0;
  const totalSelectors = report?.results.length ?? 0;

  return (
    <article className="rounded-[16px] border border-hairline bg-paper">
      <div className="grid grid-cols-[36px_1fr_auto] items-center gap-[14px] px-[20px] py-[18px]">
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
          <p className="m-0 truncate font-mono text-[11px] text-ink-3">
            <span className={statusToken.className}>● {statusToken.label}</span>
            <span className="mx-1">·</span>
            <span>{scanLine}</span>
            {report ? (
              <>
                <span className="mx-1">·</span>
                <span>selectors {passes}/{totalSelectors}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onToggleDetail}
            aria-label="Profile details"
            aria-expanded={detailOpen}
            className="grid h-[30px] w-[30px] place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
            title="Profile details"
          >
            <Info className="h-[14px] w-[14px]" strokeWidth={1.6} />
          </button>
          <Button
            variant="quiet"
            className="px-[12px] py-[7px] text-[12px]"
            onClick={() =>
              runActionWithFeedback(
                apiPost("/runner/control/platform/open-browser", { platform: row.platform }),
                {
                  pending: `Opening ${display}…`,
                  success: `${display} opened`,
                  failure: `Couldn't open ${display}`,
                  setError: setActionError
                }
              )
            }
          >
            {row.status === "CONNECTED" ? "Open browser" : "Connect"}
          </Button>
          <Menu
            trigger={
              <button
                type="button"
                aria-label="More actions"
                className="grid h-[30px] w-[30px] place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
                title="More"
              >
                <MoreVertical className="h-[14px] w-[14px]" strokeWidth={2} />
              </button>
            }
            items={[
              {
                label: "Scan now",
                onSelect: () =>
                  runActionWithFeedback(
                    apiPost("/runner/control/scan", { platform: row.platform }),
                    {
                      pending: `Scanning ${display}…`,
                      success: `${display} scan queued`,
                      failure: `${display} scan failed`,
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
                      `Reset the ${display} session? You'll need to sign in again.`
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
      </div>

      {detailOpen ? (
        <div className="border-t border-hairline px-[20px] py-[16px]">
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

function EmptyPlatformCard({ platform }: { platform: PlatformCard["platform"] }) {
  const display = PLATFORM_DISPLAY[platform];
  const glyph = PLATFORM_GLYPH[platform];
  return (
    <article className="grid grid-cols-[36px_1fr_auto] items-center gap-[14px] rounded-[16px] border border-dashed border-hairline-strong bg-paper px-[20px] py-[18px] text-ink-3">
      <span
        aria-hidden
        className="grid h-[36px] w-[36px] place-items-center rounded-[10px] border border-dashed border-hairline-strong bg-transparent font-mono text-[14px] font-semibold text-ink-3"
      >
        {glyph}
      </span>
      <div className="min-w-0">
        <h4 className="m-0 mb-[2px] font-display text-[16px] font-medium tracking-[-0.01em] text-ink-3">
          {display}
        </h4>
        <p className="m-0 font-mono text-[11px] text-ink-3">
          coming later · join waitlist
        </p>
      </div>
      <Button variant="quiet" className="px-[12px] py-[7px] text-[12px]">
        Notify me
      </Button>
    </article>
  );
}
