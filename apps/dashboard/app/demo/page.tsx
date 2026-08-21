"use client";

import { useCallback, useEffect, useState } from "react";

import { apiGet } from "@/lib/api";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Canvas, PageHead } from "@/components/common/canvas";
import { FullDemoStartScreen } from "@/components/full-demo/FullDemoStartScreen";

/**
 * /demo — calm choice screen for sample vs real read-only demo.
 * Operators land here from Settings → Pilot → Run demo. The page is
 * intentionally minimal: a heading, the two-option chooser, and nothing
 * else.
 *
 * Inbox rows are fetched up-front so the real-mode picker has something
 * to filter against without a second load. Sample mode remains available
 * when that fetch fails, while the page says that live data is unavailable.
 */
export default function FullDemoPage() {
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await apiGet<InboxResponse>("/runner/data/inbox");
      setRows(response.rows ?? []);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load live conversations"
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Canvas>
      <PageHead
        eyebrow="Demo"
        title="Run demo"
        subtitle="Try with sample conversations, or explore selected real conversations without sending. Nothing is sent automatically."
      />
      {error ? (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-row border border-hairline bg-paper-2 px-4 py-3 text-[12px] leading-[1.5] text-ink-2">
          <span>Live conversations could not be loaded. Sample conversations are still available.</span>
          <button type="button" onClick={() => void refresh()} className="shrink-0 underline underline-offset-2">
            Try again
          </button>
        </div>
      ) : null}
      {rows === null && !error ? (
        <p className="mb-5 font-mono text-[12px] text-ink-3" role="status">
          Loading live conversations…
        </p>
      ) : null}
      <FullDemoStartScreen inboxRows={rows ?? []} />
    </Canvas>
  );
}
