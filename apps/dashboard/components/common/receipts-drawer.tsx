"use client";

import { X } from "lucide-react";
import type { AuditLogRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { formatClock } from "@/lib/time";

const stageOrder = ["Connect", "Scan", "Parse", "AI", "Send", "Verify"];

function stageRank(stage?: string): number {
  if (!stage) {
    return stageOrder.length + 1;
  }
  const index = stageOrder.indexOf(stage);
  return index < 0 ? stageOrder.length + 1 : index;
}

interface ReceiptsDrawerProps {
  open: boolean;
  title?: string;
  rows: AuditLogRow[];
  onClose: () => void;
}

export function ReceiptsDrawer({ open, title = "Receipts", rows, onClose }: ReceiptsDrawerProps) {
  if (!open) {
    return null;
  }

  const ordered = [...rows].sort((a, b) => {
    if (stageRank(a.stage) !== stageRank(b.stage)) {
      return stageRank(a.stage) - stageRank(b.stage);
    }
    return Date.parse(a.timestamp) - Date.parse(b.timestamp);
  });

  return (
    <div
      className="fixed inset-0 z-50 bg-[color-mix(in_oklch,var(--ink)_24%,transparent)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="absolute inset-0 flex h-full w-full flex-col overflow-hidden bg-paper px-4 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] sm:inset-y-0 sm:left-auto sm:right-0 sm:max-w-xl sm:border-l sm:border-hairline sm:p-6 sm:shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex min-h-[56px] flex-shrink-0 items-center justify-between border-b border-hairline sm:mb-6 sm:min-h-0 sm:border-b-0">
          <div>
            <p className="hidden font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 sm:block">Receipts</p>
            <h3 className="mt-1 font-display text-[22px] font-semibold tracking-[-0.02em] sm:text-[26px]">{title}</h3>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="app-main-scroll flex min-h-0 flex-1 flex-col overflow-y-auto pb-8">
          {ordered.map((row) => (
            <div key={row.id} className="border-t border-hairline py-3 sm:py-4">
              <div className="mb-2 grid grid-cols-[auto_1fr_auto] items-baseline gap-x-2 gap-y-1 sm:flex sm:gap-3">
                <span
                  className={`h-[6px] w-[6px] rounded-full ${row.status === "OK" ? "bg-risk-fresh" : "bg-risk-overdue"}`}
                  aria-hidden
                />
                <span className="text-[15px] font-medium text-ink">{row.action}</span>
                <span className="col-start-2 font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 sm:col-auto">
                  {row.stage ?? "general"}
                </span>
                <span className="col-start-3 row-start-1 ml-auto font-mono text-[11px] text-ink-3 sm:col-auto sm:row-auto">{formatClock(row.timestamp)}</span>
              </div>
              {row.details ? (
                <pre className="mb-2 overflow-x-auto rounded-row bg-paper-2 p-3 font-mono text-[11px] text-ink-2">
                  {JSON.stringify(row.details, null, 2)}
                </pre>
              ) : null}
              <div className="flex gap-3 font-mono text-[11px] text-ink-3">
                {row.screenshotFile ? (
                  <a
                    className="underline-offset-2 hover:text-ink hover:underline"
                    href={`/artifacts/screenshots/${row.screenshotFile}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    screenshot
                  </a>
                ) : null}
                {row.domDumpFile ? (
                  <a
                    className="underline-offset-2 hover:text-ink hover:underline"
                    href={`/artifacts/dom_dumps/${row.domDumpFile}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    dom dump
                  </a>
                ) : null}
              </div>
            </div>
          ))}
          {!ordered.length ? <p className="pt-6 text-[14px] text-ink-3">No receipts yet.</p> : null}
        </div>
      </div>
    </div>
  );
}
