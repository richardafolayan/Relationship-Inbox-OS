"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import { APP_NAME } from "@/lib/branding";
import {
  hostDeviceLabel,
  hostOfflineExplanation,
  hostStatusLine,
  isRemoteActionAvailable,
  remoteActionLabel,
  runsOnLine,
  type HostDevicePayload,
  type HostOnlineState,
  type HostPlatformId,
  type RemoteActionKind
} from "@/lib/host-device";
import type { HealthResponse } from "@/lib/types";

export interface HostDeviceState {
  online: HostOnlineState;
  hostname: string | null;
  platform: HostPlatformId | null;
  lastSeenAt: number | null;
  label: string;
  runsOn: string;
  statusLine: string;
  offlineExplanation: string;
  remoteAvailable: boolean;
  actionLabel: (kind: RemoteActionKind) => string;
  refresh: () => Promise<void>;
}

const EMPTY_PAYLOAD: HostDevicePayload = {};

export function useHostDevice(pollMs = 8_000): HostDeviceState {
  const [online, setOnline] = useState<HostOnlineState>(undefined);
  const [hostname, setHostname] = useState<string | null>(null);
  const [platform, setPlatform] = useState<HostPlatformId | null>(null);
  const [resolvedLabel, setResolvedLabel] = useState<string | null>(null);
  const [lastSeenAt, setLastSeenAt] = useState<number | null>(null);

  const applyHealth = useCallback((health: HealthResponse | null) => {
    if (!health) {
      setOnline(false);
      return;
    }
    const device = health.hostDevice ?? EMPTY_PAYLOAD;
    setOnline(true);
    setHostname(typeof device.hostname === "string" ? device.hostname : null);
    setPlatform(typeof device.platform === "string" ? device.platform : null);
    setResolvedLabel(typeof device.label === "string" ? device.label : null);
    setLastSeenAt(Date.now());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const health = await apiGet<HealthResponse>("/runner/health", { ttlMs: 4000 });
      applyHealth(health);
    } catch {
      setOnline(false);
    }
  }, [applyHealth]);

  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (!active) return;
      await refresh();
    };
    void tick();
    const timer = window.setInterval(() => void tick(), pollMs);
    const onResync = () => void tick();
    window.addEventListener("runner-resync", onResync);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("runner-resync", onResync);
    };
  }, [pollMs, refresh]);

  return useMemo(() => {
    const label = hostDeviceLabel(hostname, platform, resolvedLabel);
    return {
      online,
      hostname,
      platform,
      lastSeenAt,
      label,
      runsOn: runsOnLine(hostname, platform, resolvedLabel),
      statusLine: hostStatusLine({ online, lastSeenAt, platform }),
      offlineExplanation: hostOfflineExplanation(platform, APP_NAME),
      remoteAvailable: isRemoteActionAvailable(online),
      actionLabel: (kind: RemoteActionKind) => remoteActionLabel(kind, platform),
      refresh
    };
  }, [online, hostname, platform, resolvedLabel, lastSeenAt, refresh]);
}

export function usePhoneSettingsLayout(): boolean {
  const [phone, setPhone] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return phone;
}
