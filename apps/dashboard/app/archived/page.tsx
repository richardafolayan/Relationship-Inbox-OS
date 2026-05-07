"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArchiveRestore, FolderOpen } from "lucide-react";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { InboxRow } from "@/lib/types";
import { formatRelative, formatClock } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Mirror of the Inbox view that lists archived threads. Same row shape, just
// with an Unarchive action on hover instead of Mark done / Archive. The data
// source is /runner/data/archived which filters server-side to archivedAt
// IS NOT NULL — keeps the operator's current inbox uncluttered while still
// preserving full history for everything they've handled.

interface ArchivedResponse {
  rows: InboxRow[];
}

export default function ArchivedPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await apiGet<ArchivedResponse>("/runner/data/archived");
      setRows(response.rows);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to load archived threads");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sortedRows = useMemo(() => rows ?? [], [rows]);

  if (loading && !rows) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-hidden">
      <div>
        <h2 className="text-2xl font-semibold">Archived</h2>
        <p className="text-sm text-slate-500">Threads you've finished with. Unarchive to send them back to the inbox.</p>
      </div>

      {error ? (
        <Card className="border-rose-200 bg-rose-50/60">
          <p className="text-sm font-semibold text-rose-900">{error}</p>
        </Card>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
        <div className="grid grid-cols-[2fr_1fr_2fr_1fr_1fr] gap-3 border-b border-slate-200 px-4 py-3 text-xs font-medium uppercase tracking-wide text-slate-500">
          <span>Person</span>
          <span>Platform</span>
          <span>Preview</span>
          <span>Time</span>
          <span className="text-right">Actions</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {sortedRows.map((row) => {
            const previewBody =
              row.lastMessageDirection === "OUT" ? `You: ${row.preview}` : row.preview;
            return (
              <div
                key={row.id}
                className="group grid grid-cols-[2fr_1fr_2fr_1fr_1fr] gap-3 border-b border-slate-100 px-4 py-3 transition duration-calm hover:bg-slate-50"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{row.personName}</p>
                  <p className="text-xs text-slate-500">Archived</p>
                </div>
                <div>
                  <Badge tone="blue">{row.platform}</Badge>
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-700">{previewBody}</p>
                </div>
                <div>
                  <p className="text-sm text-slate-700">{formatClock(row.lastMessageAt)}</p>
                  <p className="text-xs text-slate-500">{formatRelative(row.lastMessageAt)}</p>
                </div>
                <div className="flex items-center justify-end gap-1 opacity-0 transition duration-calm group-hover:opacity-100">
                  <Button variant="ghost" onClick={() => router.push(`/thread/${row.id}`)} title="Open thread">
                    <FolderOpen className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    title="Unarchive"
                    onClick={() =>
                      runAction(
                        apiPost(`/runner/control/thread/${row.id}/unarchive`, {}),
                        setError,
                        refresh
                      )
                    }
                  >
                    <ArchiveRestore className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
          {sortedRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">No archived threads yet.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
