"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MoreVertical } from "lucide-react";
import { apiGetRaw, apiPost } from "@/lib/api";
import { formatRelative } from "@/lib/time";
import { Menu } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

// WhatsApp connect card (#774). Off unless the runner reports enabled
// (WHATSAPP_ENABLED=true). "Connect" kicks the whatsapp-web.js session; the
// card then polls status and shows the QR (scan it in WhatsApp > Settings >
// Linked Devices). Calm, opt-in, no auto-send - mirrors the rest of Settings.
interface WhatsAppStatus {
  enabled: boolean;
  state: "qr_ready" | "connecting" | "connected" | "disconnected";
  qrDataUrl: string | null;
  updatedAt: string;
  hasPersistedSession?: boolean;
}

export function WhatsAppConnect({
  onScan,
  scanBusy = false,
  lastScanAt = null
}: {
  onScan?: () => void;
  scanBusy?: boolean;
  lastScanAt?: string | null;
} = {}) {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const data = await apiGetRaw<WhatsAppStatus>("/runner/data/whatsapp/status").catch(() => null);
    if (data) setStatus(data);
    return data;
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // While connecting / waiting for the scan, poll every 2s so the QR appears
  // and the card flips to "connected" without a manual reload.
  useEffect(() => {
    const active = status?.state === "connecting" || status?.state === "qr_ready";
    if (active && !pollRef.current) {
      pollRef.current = setInterval(() => void refresh(), 2000);
    } else if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [status?.state, refresh]);

  const connect = async () => {
    if (connecting) return;
    setConnecting(true);
    setError("");
    setNotice("");
    try {
      await apiPost("/runner/control/whatsapp/connect", {});
      await refresh();
    } catch {
      setError("Couldn't start the WhatsApp connection. Is the app running?");
    } finally {
      setConnecting(false);
    }
  };

  const refreshQr = async () => {
    if (refreshingQr) return;
    setRefreshingQr(true);
    setError("");
    setNotice("");
    try {
      await apiPost("/runner/control/whatsapp/refresh-qr", {});
      await refresh();
    } catch {
      setError("Couldn't refresh the WhatsApp QR code. Is the app running?");
    } finally {
      setRefreshingQr(false);
    }
  };

  const reset = async () => {
    if (resetting) return;
    if (
      !window.confirm(
        "Reset WhatsApp? You will need to scan a new QR code to link the phone again."
      )
    ) {
      return;
    }
    setResetting(true);
    setError("");
    setNotice("");
    try {
      await apiPost("/runner/control/whatsapp/reset", {});
      await refresh();
      setNotice("WhatsApp reset. Connect again to get a new QR code.");
    } catch {
      setError("Couldn't reset WhatsApp. Close WhatsApp Web and try again.");
    } finally {
      setResetting(false);
    }
  };

  // Hidden entirely until the operator has opted in at the runner level.
  if (status && !status.enabled) return null;

  const state = status?.state ?? "disconnected";
  const connected = state === "connected";
  const statusLabel = connected
    ? "Connected"
    : refreshingQr
      ? "Getting a new code"
      : state === "qr_ready"
        ? "Scan the code"
        : state === "connecting"
          ? "Connecting..."
          : "Not connected";
  const lastScanLabel = lastScanAt
    ? `Last scanned ${formatRelative(lastScanAt)}`
    : connected
      ? "Not scanned yet"
      : null;
  const showReset = (connected || status?.hasPersistedSession) && state !== "connecting";
  const primaryBusy = connecting || refreshingQr || resetting || scanBusy;

  return (
    <div>
      <div className="min-w-0">
        <p className="m-0 text-[16px] font-semibold text-ink">WhatsApp</p>
        <p
          className={cn(
            "m-0 mt-1 text-[13px] font-medium",
            connected ? "text-risk-fresh" : "text-ink-2"
          )}
          data-testid="platform-connection-status"
        >
          {statusLabel}
        </p>
        {lastScanLabel ? (
          <p className="m-0 mt-0.5 font-mono text-[11px] text-ink-3" data-testid="platform-last-scan">
            {lastScanLabel}
          </p>
        ) : null}
        <p
          className="m-0 mt-2 text-[13.5px] leading-[1.45] text-ink-3"
          style={{ textWrap: "pretty" }}
        >
          Link WhatsApp from your phone. The app reads chats into your inbox. You still press send.
        </p>
      </div>
      <div>
        {state === "qr_ready" && status?.qrDataUrl ? (
          <div className="mt-[14px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={status.qrDataUrl}
              alt="WhatsApp linking QR code"
              width={200}
              height={200}
              className="rounded-[10px] border border-hairline bg-white p-2"
            />
            <p className="m-0 mt-[8px] font-mono text-[11px] text-ink-3">
              Open WhatsApp, Linked Devices, Link a device.
            </p>
          </div>
        ) : null}
        {error ? (
          <p className="m-0 mt-[8px] rounded-row border border-hairline bg-paper px-3 py-2 text-[12px] leading-[1.45] text-ink-2">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="m-0 mt-[8px] font-mono text-[11px] text-risk-fresh">{notice}</p>
        ) : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {connected && onScan ? (
          <button
            type="button"
            onClick={onScan}
            disabled={primaryBusy}
            className="inline-flex min-h-[40px] items-center rounded-pill bg-ink px-4 py-[8px] text-[12.5px] font-medium text-paper hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {scanBusy ? "Working..." : "Scan now"}
          </button>
        ) : null}
        {state === "qr_ready" ? (
          <button
            type="button"
            onClick={refreshQr}
            disabled={primaryBusy}
            className="inline-flex min-h-[40px] items-center rounded-pill bg-ink px-4 py-[8px] text-[12.5px] font-medium text-paper hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshingQr ? "Refreshing..." : "New QR code"}
          </button>
        ) : null}
        {!connected && state !== "qr_ready" ? (
          <button
            type="button"
            onClick={connect}
            disabled={primaryBusy || state === "connecting"}
            className="inline-flex min-h-[40px] items-center rounded-pill bg-ink px-4 py-[8px] text-[12.5px] font-medium text-paper hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "connecting" ? "Connecting..." : "Connect WhatsApp"}
          </button>
        ) : null}
        {showReset ? (
          <Menu
            trigger={
              <button
                type="button"
                aria-label="More actions"
                disabled={resetting || refreshingQr}
                className="grid h-[40px] w-[40px] place-items-center rounded-[10px] border border-hairline text-ink-2 transition-colors duration-calm hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                title="More"
              >
                <MoreVertical className="h-[16px] w-[16px]" strokeWidth={2} />
              </button>
            }
            items={[
              {
                label: resetting ? "Resetting..." : "Reset WhatsApp",
                danger: true,
                onSelect: () => {
                  void reset();
                }
              }
            ]}
          />
        ) : null}
      </div>
    </div>
  );
}
