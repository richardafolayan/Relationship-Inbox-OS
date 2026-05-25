"use client";

import { useEffect, useState } from "react";

import { apiGet } from "@/lib/api";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Canvas, PageHead } from "@/components/common/canvas";
import { FullDemoStartScreen } from "@/components/full-demo/FullDemoStartScreen";

/**
 * /demo — the calm choice screen for the full presenter demo. Operators
 * land here from Settings → Run full demo. The page is intentionally
 * minimal: a heading, the two-option chooser, and nothing else.
 *
 * Inbox rows are fetched up-front so the live-mode picker has something
 * to filter against without a second load. We don't gate on success —
 * an empty inbox is fine (sandbox still works) and a fetch error just
 * means the live picker shows "No matches".
 */
export default function FullDemoPage() {
  const [rows, setRows] = useState<InboxRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiGet<InboxResponse>("/runner/data/inbox")
      .then((res) => {
        if (cancelled) return;
        setRows(res.rows ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Canvas>
      <PageHead eyebrow="Demo" title="Run full demo" />
      <div className="mx-auto max-w-2xl px-6 py-6">
        <FullDemoStartScreen inboxRows={rows} />
      </div>
    </Canvas>
  );
}
