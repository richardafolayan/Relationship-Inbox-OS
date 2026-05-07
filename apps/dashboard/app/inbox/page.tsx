"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { AuditLogRow, InboxResponse, InboxRow, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type CategoryFilter = "all" | "genuine" | "outreach";

const CATEGORY_LABELS: Record<CategoryFilter, string> = {
  all: "All threads",
  genuine: "Genuine",
  outreach: "Outreach"
};

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
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");

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
  const filtered = useMemo(() => {
    const normalisedFilter = filter.trim().toLowerCase();
    return rows.filter((row: InboxRow) => {
      if (category !== "all") {
        if ((row.category ?? "").toLowerCase() !== category) return false;
      }
      if (!normalisedFilter) return true;
      return (
        row.personName.toLowerCase().includes(normalisedFilter) ||
        row.preview.toLowerCase().includes(normalisedFilter)
      );
    });
  }, [rows, filter, category]);

  const overdue = useMemo(() => filtered.filter((r) => r.riskLevel === "RED"), [filtered]);
  const waiting = useMemo(() => filtered.filter((r) => r.riskLevel === "AMBER"), [filtered]);
  const fresh = useMemo(() => filtered.filter((r) => r.riskLevel === "GREEN"), [filtered]);

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
        title="Inbox."
        meta={
          <span>
            {filtered.length} of {rows.length} threads
          </span>
        }
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

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Input
          type="search"
          placeholder="Filter by name or message…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="w-full max-w-[320px]"
        />
        <div className="flex items-center gap-2">
          {(Object.keys(CATEGORY_LABELS) as CategoryFilter[]).map((key) => (
            <Button
              key={key}
              variant={category === key ? "primary" : "quiet"}
              onClick={() => setCategory(key)}
            >
              {CATEGORY_LABELS[key]}
            </Button>
          ))}
        </div>
      </div>

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : filtered.length === 0 ? (
        rows.length === 0 ? (
          <CaughtUp title="You’re caught up." body="No conversations need you right now." />
        ) : (
          <CaughtUp
            title="No matches."
            body="Clear the filter or switch the category to see more threads."
          />
        )
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
