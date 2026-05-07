"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost, runAction, ApiRequestError } from "@/lib/api";
import type { AuditLogRow, InboxResponse, PlatformCard } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { SelectableThreadRow } from "@/components/common/selectable-thread-row";
import { DegradedBanner } from "@/components/common/degraded-banner";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

// All inbox — same chrome as Today, body bucketed by risk. The runner's
// /data/inbox already returns the rows pre-sorted; we just split them
// into three sections and skip empty buckets.
//
// Multi-select: shift-click any row to enter select mode and toggle
// selection. While ≥1 row is selected, a sticky bottom action bar
// surfaces bulk Mark done / Snooze / Open in platform / Clear actions.
// Esc clears selection. Cmd/Ctrl+A selects all visible rows.
export default function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [platforms, setPlatforms] = useState<PlatformCard[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Multi-select state. selectedIds preserves insertion order so
  // shift-click range can find the anchor (last selected) deterministically.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Toggle to put the row list into checkbox-and-toggle mode without
  // requiring a modifier-click; useful when discovering the feature.
  const [forceSelectMode, setForceSelectMode] = useState(false);
  const lastToggledRef = useRef<string | null>(null);
  // Removed-locally so bulk actions feel instant; reconciled against
  // server data on the next refresh, mirroring /today.
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [inbox, platformRows, logRows] = await Promise.all([
      apiGet<InboxResponse>("/runner/data/inbox").catch(() => null),
      apiGet<PlatformCard[]>("/runner/data/platforms").catch(() => []),
      apiGet<AuditLogRow[]>("/runner/data/logs?limit=100").catch(() => [])
    ]);
    if (inbox) {
      setData(inbox);
      // Drop optimistic IDs the server has caught up on (same logic as /today).
      const stillPending = new Set(
        inbox.rows.filter((row) => row.needsReply !== false).map((row) => row.id)
      );
      setRemovedIds((prev) => {
        const next = new Set<string>();
        prev.forEach((id) => {
          if (stillPending.has(id)) next.add(id);
        });
        return next;
      });
    }
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

  const allRows = data?.rows ?? [];
  const rows = useMemo(
    () => allRows.filter((row) => !removedIds.has(row.id)),
    [allRows, removedIds]
  );
  const overdue = useMemo(() => rows.filter((r) => r.riskLevel === "RED"), [rows]);
  const waiting = useMemo(() => rows.filter((r) => r.riskLevel === "AMBER"), [rows]);
  const fresh = useMemo(() => rows.filter((r) => r.riskLevel === "GREEN"), [rows]);

  const buckets = [
    { key: "overdue", label: "Overdue — they’ve waited longest", items: overdue },
    { key: "waiting", label: "Waiting on you", items: waiting },
    { key: "fresh", label: "Fresh, no rush", items: fresh }
  ];
  const degraded = platforms.find((p) => p.status === "DEGRADED");

  const flatVisibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectMode = forceSelectMode || selectedIds.length > 0;

  const toggleId = useCallback(
    (id: string, opts: { shiftKey: boolean }) => {
      setSelectedIds((prev) => {
        const set = new Set(prev);
        if (opts.shiftKey && lastToggledRef.current && lastToggledRef.current !== id) {
          // Range select between anchor and target on the visible flat list.
          const anchor = lastToggledRef.current;
          const a = flatVisibleIds.indexOf(anchor);
          const b = flatVisibleIds.indexOf(id);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (const rangeId of flatVisibleIds.slice(lo, hi + 1)) set.add(rangeId);
            lastToggledRef.current = id;
            return Array.from(set);
          }
        }
        if (set.has(id)) {
          set.delete(id);
        } else {
          set.add(id);
        }
        lastToggledRef.current = id;
        return Array.from(set);
      });
    },
    [flatVisibleIds]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setForceSelectMode(false);
    lastToggledRef.current = null;
  }, []);

  // ⌘A / ctrl-A selects all visible rows when in select mode; Esc clears.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selectMode) {
        clearSelection();
        return;
      }
      if (selectMode && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedIds(flatVisibleIds);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode, flatVisibleIds, clearSelection]);

  const runBulk = useCallback(
    async (
      label: string,
      buildPath: (id: string) => string,
      body: Record<string, unknown> = {}
    ) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;
      setBulkPending(label);
      setBulkResult(null);
      // Optimistically hide the affected rows.
      setRemovedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.add(id));
        return next;
      });
      const results = await Promise.allSettled(
        ids.map((id) => apiPost(buildPath(id), body))
      );
      const failed = results.filter((r) => r.status === "rejected");
      const succeeded = ids.length - failed.length;
      if (failed.length > 0) {
        // Restore the failed ids to the visible list.
        const failedIds = new Set(
          failed.map((_, i) => {
            const original = results.findIndex((r, idx) => idx === i && r.status === "rejected");
            return ids[original >= 0 ? original : i];
          })
        );
        setRemovedIds((prev) => {
          const next = new Set(prev);
          failedIds.forEach((id) => next.delete(id));
          return next;
        });
        const firstReason = failed
          .map((f) => (f.status === "rejected" ? (f.reason as Error | ApiRequestError) : null))
          .find(Boolean);
        const reasonMsg = firstReason instanceof Error ? firstReason.message : "Unknown";
        setBulkResult(`${label}: ${succeeded} ok, ${failed.length} failed (${reasonMsg})`);
      } else {
        setBulkResult(`${label}: ${succeeded} of ${ids.length}`);
      }
      setBulkPending(null);
      clearSelection();
      void refresh();
    },
    [selectedIds, clearSelection, refresh]
  );

  return (
    <Canvas>
      <PageHead
        eyebrow="All conversations"
        title="Inbox."
        meta={
          selectMode ? (
            <span data-testid="inbox-select-count">{selectedIds.length} selected</span>
          ) : (
            <span>{rows.length} threads</span>
          )
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

      {bulkResult ? (
        <p className="mb-6 font-mono text-[11px] text-ink-3">{bulkResult}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <CaughtUp title="You’re caught up." body="No conversations need you right now." />
      ) : (
        <>
          {!selectMode ? (
            <div className="mb-3 flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3">
                Tip: ⌘-click a row to select multiple at once.
              </p>
              <button
                type="button"
                onClick={() => setForceSelectMode(true)}
                className="font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
              >
                Select
              </button>
            </div>
          ) : null}
          {buckets.map((bucket) =>
            bucket.items.length ? (
              <section key={bucket.key}>
                <SectionDivider label={bucket.label} />
                <div className="flex flex-col">
                  {bucket.items.map((row) => (
                    <SelectableThreadRow
                      key={row.id}
                      row={row}
                      selectMode={selectMode}
                      selected={selectedSet.has(row.id)}
                      onToggle={toggleId}
                    />
                  ))}
                </div>
              </section>
            ) : null
          )}
        </>
      )}

      {selectMode ? (
        <div
          data-testid="bulk-action-bar"
          className="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-hairline bg-paper px-4 py-2 shadow-card"
        >
          <span className="font-mono text-[11px] tracking-[0.04em] text-ink-3">
            {selectedIds.length} selected
          </span>
          <button
            type="button"
            disabled={!!bulkPending}
            onClick={() =>
              void runBulk("Mark done", (id) => `/runner/control/thread/${id}/mark-done`)
            }
            className="rounded-full px-3 py-1 text-[12px] font-medium text-ink hover:bg-paper-2 disabled:opacity-50"
          >
            {bulkPending === "Mark done" ? "Marking…" : "Mark done"}
          </button>
          <button
            type="button"
            disabled={!!bulkPending}
            onClick={() =>
              void runBulk("Snooze 16h", (id) => `/runner/control/thread/${id}/snooze`, { hours: 16 })
            }
            className="rounded-full px-3 py-1 text-[12px] font-medium text-ink hover:bg-paper-2 disabled:opacity-50"
          >
            {bulkPending === "Snooze 16h" ? "Snoozing…" : "Snooze 16h"}
          </button>
          <button
            type="button"
            disabled={!!bulkPending}
            onClick={() =>
              void runBulk("Rescan", (id) => `/runner/control/thread/${id}/rescan`)
            }
            className="rounded-full px-3 py-1 text-[12px] font-medium text-ink hover:bg-paper-2 disabled:opacity-50"
          >
            {bulkPending === "Rescan" ? "Rescanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={clearSelection}
            className="rounded-full px-3 py-1 text-[12px] text-ink-3 hover:bg-paper-2"
          >
            Clear
          </button>
        </div>
      ) : null}

      <ReceiptsDrawer
        open={receiptsOpen}
        onClose={() => setReceiptsOpen(false)}
        rows={logs}
        title="Inbox receipts"
      />
    </Canvas>
  );
}
