"use client";

import { useEffect, useState } from "react";

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
 * to filter against without a second load. We don't gate on success —
 * an empty inbox is fine (sample mode still works) and a fetch error
 * just means the live picker shows "No matches".
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
      <PageHead
        eyebrow="Demo"
        title="Run demo"
        subtitle="Try with sample conversations, or explore selected real conversations without sending. Nothing is sent automatically."
      />
      <FullDemoStartScreen inboxRows={rows} />
    </Canvas>
  );
}
