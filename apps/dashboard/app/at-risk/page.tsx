"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";

// At-risk = inbox filtered to overdue + waiting. Same shell as Inbox; we
// just drop the "fresh" bucket. Extrapolation per the README's IA table.
export default function AtRiskPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const inbox = await apiGet<InboxResponse>("/runner/data/inbox").catch(() => null);
    if (inbox) setData(inbox);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  const rows = data?.rows ?? [];
  const overdue = useMemo(() => rows.filter((r) => r.riskLevel === "RED"), [rows]);
  const waiting = useMemo(() => rows.filter((r) => r.riskLevel === "AMBER"), [rows]);
  const total = overdue.length + waiting.length;

  return (
    <Canvas>
      <PageHead
        eyebrow="Needs you"
        title="At risk."
        meta={
          <>
            <span className="text-ink">{overdue.length}</span> overdue ·{" "}
            <span className="text-ink">{waiting.length}</span> waiting
          </>
        }
      />

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : total === 0 ? (
        <CaughtUp title="You’re caught up." body="Nothing is at risk right now." />
      ) : (
        <>
          {overdue.length ? (
            <section>
              <SectionDivider label="Overdue — they’ve waited longest" />
              <div className="flex flex-col">
                {overdue.map((row) => (
                  <ThreadRow key={row.id} row={row} />
                ))}
              </div>
            </section>
          ) : null}
          {waiting.length ? (
            <section>
              <SectionDivider label="Waiting on you" />
              <div className="flex flex-col">
                {waiting.map((row) => (
                  <ThreadRow key={row.id} row={row} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </Canvas>
  );
}
