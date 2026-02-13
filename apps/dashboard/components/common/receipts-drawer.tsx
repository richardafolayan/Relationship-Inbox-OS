"use client";

import { X } from "lucide-react";
import type { AuditLogRow } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
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
    <div className="fixed inset-0 z-50 bg-slate-950/20 backdrop-blur-sm">
      <div className="absolute right-0 top-0 h-full w-full max-w-xl border-l border-slate-200 bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">{title}</h3>
          <Button variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-3 overflow-y-auto pb-8">
          {ordered.map((row) => (
            <div key={row.id} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge tone={row.status === "OK" ? "green" : "red"}>{row.status}</Badge>
                  <Badge tone="blue">{row.stage ?? "General"}</Badge>
                  <span className="text-sm font-medium text-slate-700">{row.action}</span>
                </div>
                <span className="text-xs text-slate-500">{formatClock(row.timestamp)}</span>
              </div>
              {row.details ? (
                <pre className="mb-2 overflow-x-auto rounded-lg bg-white p-2 text-xs text-slate-600">{JSON.stringify(row.details, null, 2)}</pre>
              ) : null}
              <div className="flex gap-3 text-xs">
                {row.screenshotFile ? (
                  <a className="font-medium text-blue-700 hover:underline" href={`/artifacts/screenshots/${row.screenshotFile}`} target="_blank">
                    Screenshot
                  </a>
                ) : null}
                {row.domDumpFile ? (
                  <a className="font-medium text-blue-700 hover:underline" href={`/artifacts/dom_dumps/${row.domDumpFile}`} target="_blank">
                    DOM dump
                  </a>
                ) : null}
              </div>
            </div>
          ))}
          {!ordered.length ? <p className="text-sm text-slate-500">No receipts yet.</p> : null}
        </div>
      </div>
    </div>
  );
}
