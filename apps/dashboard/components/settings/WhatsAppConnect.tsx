"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGetRaw, apiPost } from "@/lib/api";
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
  deviceLabel,
  remoteDisabled = false,
  offlineExplanation
}: {
  onScan?: () => void;
  scanBusy?: boolean;
  deviceLabel?: string;
  remoteDisabled?: boolean;
  offlineExplanation?: string;
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
    if (connecting || remoteDisabled) return;
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
    if (refreshingQr || remoteDisabled) return;
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
    if (resetting || remoteDisabled) return;
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

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 text-[16px] font-semibold text-ink">WhatsApp</p>
          <p className="m-0 mt-1 text-[13.5px] leading-[1.45] text-ink-3" style={{ textWrap: "pretty" }}>
            Link WhatsApp from your phone. The app reads chats into your inbox. You still press send.
          </p>
          {deviceLabel ? (
            <p className="m-0 mt-1.5 text-[12px] leading-[1.4] text-ink-3">{deviceLabel}</p>
          ) : null}
        </div>
        <span
          className={cn(
            "shrink-0 rounded-pill px-2 py-[3px] font-mono text-[10.5px]",
            connected ? "bg-risk-fresh/15 text-risk-fresh" : "bg-paper-3 text-ink-3"
          )}
        >
          {statusLabel}
        </span>
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
        {error ? <p className="m-0 mt-[8px] rounded-row border border-hairline bg-paper px-3 py-2 text-[12px] leading-[1.45] text-ink-2">{error}</p> : null}
        {notice ? <p className="m-0 mt-[8px] font-mono text-[11px] text-risk-fresh">{notice}</p> : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {connected && onScan ? (
          <button
            type="button"
            onClick={onScan}
            disabled={scanBusy || resetting || remoteDisabled}
            title={remoteDisabled ? offlineExplanation : undefined}
            className="inline-flex items-center rounded-pill bg-ink px-3 py-[7px] text-[12.5px] font-medium text-paper hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {scanBusy ? "Working..." : "Scan WhatsApp"}
          </button>
        ) : null}
        {remoteDisabled && offlineExplanation ? (
          <span className="max-w-[36ch] text-[11.5px] leading-[1.4] text-ink-3">{offlineExplanation}</span>
        ) : connected && onScan ? (
          <span className="font-mono text-[11px] text-ink-3">Scan ready</span>
        ) : null}
        {state === "qr_ready" ? (
          <button
            type="button"
            onClick={refreshQr}
            disabled={refreshingQr || resetting || remoteDisabled}
            title={remoteDisabled ? offlineExplanation : undefined}
            className="inline-flex items-center rounded-pill border border-hairline bg-paper px-3 py-[7px] text-[12px] font-medium text-ink hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshingQr ? "Refreshing..." : "New QR code"}
          </button>
        ) : null}
        {!connected && state !== "qr_ready" ? (
          <button
            type="button"
            onClick={connect}
            disabled={connecting || resetting || state === "connecting" || remoteDisabled}
            title={remoteDisabled ? offlineExplanation : undefined}
            className="inline-flex items-center rounded-pill bg-ink px-3 py-[7px] text-[12px] font-medium text-paper hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "connecting" ? "Connecting..." : "Connect WhatsApp"}
          </button>
        ) : null}
        {(connected || status?.hasPersistedSession) && state !== "connecting" ? (
          <button
            type="button"
            onClick={reset}
            disabled={resetting || refreshingQr || remoteDisabled}
            title={remoteDisabled ? offlineExplanation : undefined}
            className="inline-flex items-center rounded-pill border border-hairline bg-transparent px-3 py-[7px] text-[12px] font-medium text-ink-2 hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {resetting ? "Resetting..." : "Reset WhatsApp"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
