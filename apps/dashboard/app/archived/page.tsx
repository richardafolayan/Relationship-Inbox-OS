"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, runAction } from "@/lib/api";
import type { InboxRow } from "@/lib/types";
import { formatRelative } from "@/lib/time";
import { initials, PLATFORM_LABEL, avatarTone } from "@/lib/risk";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { Button } from "@/components/ui/button";

interface ArchivedResponse {
  rows: InboxRow[];
}

// Archived threads — rows in the same calm pattern. Click to open the
// thread, or use the quiet "unarchive" link to send it back to the inbox.
// Not in the sidebar nav; reachable directly via /archived.
export default function ArchivedPage() {
  const router = useRouter();
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await apiGet<ArchivedResponse>("/runner/data/archived");
      setRows(response.rows);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to load archived threads");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Canvas>
      <PageHead
        eyebrow="Handled"
        title="Archived"
        meta={rows && rows.length > 0 ? <span>{rows.length} threads</span> : null}
      />

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {!rows || rows.length === 0 ? (
        <CaughtUp title="No archived threads yet." body="Threads you mark as handled land here." />
      ) : (
        <div className="flex flex-col">
          {rows.map((row) => {
            const previewBody =
              row.lastMessageDirection === "OUT" ? `You: ${row.preview}` : row.preview;
            return (
              <div
                key={row.id}
                className="grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] last:border-b last:border-hairline"
              >
                <span
                  className="grid h-8 w-8 place-items-center rounded-full font-display text-[12px] font-semibold text-white"
                  style={{ background: avatarTone(row.personName) }}
                >
                  {initials(row.personName)}
                </span>
                <button
                  type="button"
                  onClick={() => router.push(`/thread/${row.id}`)}
                  className="min-w-0 text-left"
                >
                  <span className="mb-1 flex items-baseline gap-[10px]">
                    <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">
                      {row.personName}
                    </span>
                    <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
                      {PLATFORM_LABEL[row.platform]}
                    </span>
                  </span>
                  <span className="block max-w-[52ch] truncate text-[14px] text-ink-3">
                    {previewBody}
                  </span>
                </button>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
                    {formatRelative(row.lastMessageAt)}
                  </span>
                  <Button
                    variant="quiet"
                    onClick={() =>
                      runAction(
                        apiPost(`/runner/control/thread/${row.id}/unarchive`, {}),
                        setError,
                        refresh
                      )
                    }
                  >
                    Unarchive
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Canvas>
  );
}
