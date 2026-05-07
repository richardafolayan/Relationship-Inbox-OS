"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api";
import type { AuditLogRow } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { ReceiptsDrawer } from "@/components/common/receipts-drawer";

// Activity log — receipts list using the same row pattern. Click any row
// to inspect details/screenshots/DOM dumps in the receipts drawer.
export default function LogsPage() {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const refresh = useCallback(async () => {
    const rows = await apiGet<AuditLogRow[]>("/runner/data/logs?limit=300").catch(
      () => [] as AuditLogRow[]
    );
    setLogs(rows);
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
        eyebrow="Receipts"
        title="Activity."
        meta={
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 hover:text-ink"
          >
            open drawer
          </button>
        }
      />

      {logs.length === 0 ? (
        <CaughtUp title="Nothing logged yet." body="Every scan, send, and selector check will appear here." />
      ) : (
        <div className="flex flex-col">
          {logs.map((log) => {
            const dot = log.status === "OK" ? "bg-risk-fresh" : "bg-risk-overdue";
            return (
              <div
                key={log.id}
                className="grid grid-cols-[160px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] last:border-b last:border-hairline"
              >
                <span className="font-mono text-[12px] tracking-[0.02em] text-ink-3">
                  {formatRelative(log.timestamp)}
                </span>
                <div className="min-w-0">
                  <p className="m-0 flex items-center gap-2 text-[15px] tracking-[-0.01em] text-ink">
                    <span className={`h-[6px] w-[6px] rounded-full ${dot}`} />
                    {log.action}
                  </p>
                  <p className="m-0 mt-1 font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    {log.platform ? `${log.platform.toLowerCase()} · ` : ""}
                    {log.stage ?? "general"}
                  </p>
                </div>
                <div className="flex items-center gap-3 font-mono text-[11px] text-ink-3">
                  {log.screenshotFile ? (
                    <a
                      className="hover:text-ink hover:underline"
                      href={`/artifacts/screenshots/${log.screenshotFile}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      screenshot
                    </a>
                  ) : null}
                  {log.domDumpFile ? (
                    <a
                      className="hover:text-ink hover:underline"
                      href={`/artifacts/dom_dumps/${log.domDumpFile}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      dom
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ReceiptsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        rows={logs}
        title="System receipts"
      />
    </Canvas>
  );
}
