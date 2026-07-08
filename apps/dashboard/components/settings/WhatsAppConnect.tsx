"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGetRaw, apiPost } from "@/lib/api";

// WhatsApp connect card (#774). Off unless the runner reports enabled
// (WHATSAPP_ENABLED=true). "Connect" kicks the whatsapp-web.js session; the
// card then polls status and shows the QR (scan it in WhatsApp > Settings >
// Linked Devices). Calm, opt-in, no auto-send - mirrors the rest of Settings.
interface WhatsAppStatus {
  enabled: boolean;
  state: "qr_ready" | "connecting" | "connected" | "disconnected";
  qrDataUrl: string | null;
  updatedAt: string;
}

export function WhatsAppConnect() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [refreshingQr, setRefreshingQr] = useState(false);
  const [error, setError] = useState("");
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
    try {
      await apiPost("/runner/control/whatsapp/refresh-qr", {});
      await refresh();
    } catch {
      setError("Couldn't refresh the WhatsApp QR code. Is the app running?");
    } finally {
      setRefreshingQr(false);
    }
  };

  // Hidden entirely until the operator has opted in at the runner level.
  if (status && !status.enabled) return null;

  const state = status?.state ?? "disconnected";
  const connected = state === "connected";

  return (
    <div className="grid grid-cols-1 gap-4">
      <div>
        <p className="m-0 mb-[4px] text-[16px] font-semibold text-ink">WhatsApp</p>
        <p className="m-0 text-[13.5px] leading-[1.45] text-ink-3" style={{ textWrap: "pretty" }}>
          Link WhatsApp from your phone. The app reads chats into your inbox. You still press send.
        </p>
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
        {error ? <p className="m-0 mt-[8px] font-mono text-[11px] text-risk-overdue">{error}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-[10px]">
        <span className="font-mono text-[11px] text-ink-3">
          {connected
            ? "Connected"
            : refreshingQr
              ? "Getting a new code"
              : state === "qr_ready"
              ? "Scan the code"
              : state === "connecting"
                ? "Connecting..."
                : "Not connected"}
        </span>
        {state === "qr_ready" ? (
          <button
            type="button"
            onClick={refreshQr}
            disabled={refreshingQr}
            className="inline-flex items-center rounded-pill border border-hairline bg-paper px-3 py-[7px] text-[12px] font-medium text-ink hover:bg-[oklch(95%_0.004_80)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshingQr ? "Refreshing..." : "New QR code"}
          </button>
        ) : null}
        {!connected && state !== "qr_ready" ? (
          <button
            type="button"
            onClick={connect}
            disabled={connecting || state === "connecting"}
            className="inline-flex items-center rounded-pill bg-ink px-3 py-[7px] text-[12px] font-medium text-paper hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "connecting" ? "Connecting..." : "Connect WhatsApp"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
