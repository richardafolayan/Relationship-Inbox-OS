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
  TIKTOK: "Tiktok",
  IMESSAGE: "iMessage",
  WHATSAPP: "WhatsApp"
};

// Only platforms whose adapter has been hardened against the live UI are
// surfaced as actionable rows. Instagram and TikTok still flow through the
// runner so settings + future work can re-enable them, but the operator
// shouldn't see them as "Connect" rows on the main view yet.
//
// WhatsApp gets a dedicated card above the generic loop because its connect
// flow is QR-based, not "Open browser" — it lives in its own component
// rather than being templated into the existing card layout.
const VISIBLE_PLATFORMS: ReadonlyArray<PlatformCard["platform"]> = ["LINKEDIN", "IMESSAGE"];
const HIDDEN_PLATFORMS: ReadonlyArray<PlatformCard["platform"]> = ["INSTAGRAM", "TIKTOK"];

type WhatsAppConnectState = "disconnected" | "connecting" | "qr_ready" | "connected";

interface WhatsAppStatus {
  state: WhatsAppConnectState;
  hasQr: boolean;
  connectStartedAt: string | null;
}

function WhatsAppConnectCard({ setError }: { setError: (msg: string | null) => void }) {
  const [status, setStatus] = useState<WhatsAppStatus>({
    state: "disconnected",
    hasQr: false,
    connectStartedAt: null
  });
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Poll status every 2s while not connected. The runner's connect flow is
  // event-driven (wweb.js fires "qr" then "ready" asynchronously) so the
  // UI can't subscribe directly without an SSE topic — polling is fine
  // for the narrow connect window.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await apiGet<WhatsAppStatus>("/runner/control/whatsapp/status");
        if (cancelled || !next) return;
        setStatus(next);
        if (next.hasQr) {
          const qr = await apiGet<{ qrDataUrl: string }>("/runner/control/whatsapp/qr").catch(() => null);
          if (!cancelled && qr) setQrDataUrl(qr.qrDataUrl);
        } else {
          setQrDataUrl(null);
        }
      } catch {
        // Swallow — the dashboard already surfaces runner-down state via
        // its global health bar; double-toasting here is noise.
      }
    };
    void tick();
    const handle = window.setInterval(() => {
      if (status.state !== "connected") void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [status.state]);

  const onConnect = useCallback(async () => {
    setBusy(true);
    try {
      await runActionWithFeedback(
        apiPost("/runner/control/whatsapp/connect", {}),
        {
          pending: "Starting WhatsApp connect…",
          success: "WhatsApp connect started — scan the QR with your phone",
          failure: "Couldn't start WhatsApp connect",
          setError
        }
      );
    } finally {
      setBusy(false);
    }
  }, [setError]);

  const onDisconnect = useCallback(async () => {
    if (!window.confirm("Disconnect WhatsApp? You'll need to scan the QR again next time.")) return;
    setBusy(true);
    try {
      await runActionWithFeedback(
        apiPost("/runner/control/whatsapp/disconnect", {}),
        {
          pending: "Disconnecting WhatsApp…",
          success: "WhatsApp disconnected",
          failure: "Couldn't disconnect WhatsApp",
          setError
        }
      );
      setStatus({ state: "disconnected", hasQr: false, connectStartedAt: null });
      setQrDataUrl(null);
    } finally {
      setBusy(false);
    }
  }, [setError]);

  const statusLabel =
    status.state === "connected"
      ? "Connected"
      : status.state === "qr_ready"
        ? "Scan QR"
        : status.state === "connecting"
          ? "Connecting"
          : "Not connected";
  const statusClass =
    status.state === "connected"
      ? "bg-risk-fresh/15 text-risk-fresh"
      : status.state === "qr_ready" || status.state === "connecting"
        ? "bg-risk-waiting/15 text-risk-waiting"
        : "bg-paper-2 text-ink-3";

  return (
    <details
      open={status.state === "qr_ready" || status.state === "connecting"}
      className="group border-t border-hairline px-1 py-[18px] last:border-b last:border-hairline"
    >
      <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto_auto] items-center gap-6">
        <div>
          <div className="flex items-center gap-3">
            <p className="m-0 font-display text-[18px] font-medium tracking-[-0.012em] text-ink">WhatsApp</p>
            <span
              className={`inline-flex items-center rounded-[6px] px-[8px] py-[2px] text-[11px] font-medium uppercase tracking-[0.04em] ${statusClass}`}
            >
              {statusLabel}
            </span>
          </div>
          <p className="mt-1 font-mono text-[12px] text-ink-3">
            {status.state === "connected"
              ? "linked device — sessions persist across runner restarts"
              : status.state === "qr_ready"
                ? "open WhatsApp on your phone → Settings → Linked Devices → Link a Device"
                : status.state === "connecting"
                  ? "spinning up Puppeteer…"
                  : "library-driven · no DOM scraping"}
          </p>
        </div>
        <div className="flex items-center gap-1 text-[12px] text-ink-3 group-open:text-ink">
          <span className="hover:text-ink">Details ▾</span>
        </div>
        <div className="flex items-center gap-2" onClick={(e) => e.preventDefault()}>
          {status.state === "connected" ? (
            <Button variant="quiet" disabled={busy} onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button variant="quiet" disabled={busy} onClick={onConnect}>
              {status.state === "connecting" || status.state === "qr_ready" ? "Connecting…" : "Connect"}
            </Button>
          )}
        </div>
      </summary>

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 font-mono text-[12px] text-ink-2">
        {qrDataUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrDataUrl}
              alt="WhatsApp QR code — scan with your phone"
              className="h-[200px] w-[200px] rounded-md border border-hairline bg-white p-2"
            />
            <div className="self-center">
              <p className="m-0 text-ink">Open WhatsApp on your phone, tap <span className="text-ink">Settings → Linked Devices → Link a Device</span>, then scan this code.</p>
              <p className="mt-2 text-ink-3">Sessions persist across restarts. The QR refreshes every ~30s; this card always shows the latest one.</p>
            </div>
          </>
        ) : status.state === "connected" ? (
          <p className="col-span-2 m-0 text-ink-2">WhatsApp is paired. Threads will appear in the inbox after the next scan.</p>
        ) : (
          <p className="col-span-2 m-0 text-ink-3">No QR available yet. Click Connect to start the pairing flow — the QR will render here once the wweb.js client emits one (usually 1-3 seconds after launch).</p>
        )}
      </div>
    </details>
  );
}

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

      <WhatsAppConnectCard setError={setActionError} />

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
