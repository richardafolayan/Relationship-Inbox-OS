"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

// All inbox — same chrome as Today, body bucketed by risk. The runner's
// /data/inbox already returns the rows pre-sorted; we just split them
// into three sections and skip empty buckets.
export default function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const [inbox, platformRows, logRows] = await Promise.all([
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => []),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=100").catch(() => [])
    ]);
    if (inbox) setData(inbox);
    setPlatforms(platformRows ?? []);
    setLogs(logRows ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      window.removeEventListener("runner-resync", onResync);
      clearInterval(timer);
    };
  }, [refresh]);

  const rows = data?.rows ?? [];
  const overdue = useMemo(() => rows.filter((r) => r.riskLevel === "RED"), [rows]);
  const waiting = useMemo(() => rows.filter((r) => r.riskLevel === "AMBER"), [rows]);
  const fresh = useMemo(() => rows.filter((r) => r.riskLevel === "GREEN"), [rows]);

  const buckets = [
    { key: "overdue", label: "Overdue — they’ve waited longest", items: overdue },
    { key: "waiting", label: "Waiting on you", items: waiting },
    { key: "fresh", label: "Fresh, no rush", items: fresh }
  ];
  const degraded = platforms.find((p) => p.status === "DEGRADED");

  return (
    <Canvas>
      <PageHead
        eyebrow="All conversations"
        title="Inbox"
        subtitle="Every active thread, sectioned by urgency. Search and filter to find one fast."
        meta={<span>{rows.length} threads</span>}
      />

      {degraded ? (
        <DegradedBanner
          platform={degraded.platform}
          stage={degraded.lastScanFailure?.stage}
          reason={degraded.lastScanFailure?.reason}
          requestId={degraded.lastScanFailure?.requestId}
          errorSummary={degraded.lastScanFailure?.errorSummary ?? degraded.lastError ?? undefined}
          screenshotFile={degraded.lastScanFailure?.screenshotFile}
          domDumpFile={
            degraded.lastScanFailure?.domDumpFile ??
            logs.find((log) => log.platform === degraded.platform && log.domDumpFile)?.domDumpFile
          }
          onRunSelectorTests={() =>
            runAction(
              apiPost("/runner/control/platform/test-selectors", { platform: degraded.platform }),
              setError,
              refresh
            )
          }
          onOpenReceipts={() => setReceiptsOpen(true)}
        />
      ) : null}

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <CaughtUp title="You’re caught up." body="No conversations need you right now." />
      ) : (
        buckets.map((bucket) =>
          bucket.items.length ? (
            <section key={bucket.key}>
              <SectionDivider label={bucket.label} />
              <div className="flex flex-col">
                {bucket.items.map((row) => (
                  <ThreadRow key={row.id} row={row} />
                ))}
              </div>
            </section>
          ) : null
        )
      )}

      <ReceiptsDrawer
        open={receiptsOpen}
        onClose={() => setReceiptsOpen(false)}
        rows={logs}
        title="Inbox receipts"
      />
    </Canvas>
  );
}
