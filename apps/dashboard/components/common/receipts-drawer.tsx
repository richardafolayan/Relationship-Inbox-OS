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
        className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col border-l border-hairline bg-paper p-6 shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">Receipts</p>
            <h3 className="mt-1 font-display text-[26px] font-semibold tracking-[-0.02em]">{title}</h3>
          </div>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto pb-8">
          {ordered.map((row) => (
            <div key={row.id} className="border-t border-hairline py-4">
              <div className="mb-2 flex items-baseline gap-3">
                <span
                  className={`h-[6px] w-[6px] rounded-full ${row.status === "OK" ? "bg-risk-fresh" : "bg-risk-overdue"}`}
                  aria-hidden
                />
                <span className="text-[15px] font-medium text-ink">{row.action}</span>
                <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3">
                  {row.stage ?? "general"}
                </span>
                <span className="ml-auto font-mono text-[11px] text-ink-3">{formatClock(row.timestamp)}</span>
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
