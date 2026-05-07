"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { InboxResponse } from "@/lib/types";
import { Canvas, PageHead, SectionDivider, CaughtUp } from "@/components/common/canvas";
import { ThreadRow } from "@/components/common/thread-row";
import { Button } from "@/components/ui/button";

const FOCUS_QUEUE_KEY = "inbox_focus_queue";

// At-risk = inbox filtered to overdue + waiting. Same shell as Inbox; we
// just drop the "fresh" bucket. Reply Focus Mode primes a queue of
// thread ids in localStorage and routes to the first one; the thread
// page reads the queue to show "Next in queue (N left)".
export default function AtRiskPage() {
  const router = useRouter();
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

  const enterFocusMode = () => {
    const queue = [...overdue, ...waiting].map((r) => r.id);
    if (!queue.length) return;
    window.localStorage.setItem(FOCUS_QUEUE_KEY, JSON.stringify(queue));
    router.push(`/thread/${queue[0]}`);
  };

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

      {total > 0 ? (
        <div className="mb-6 flex items-center gap-3">
          <Button variant="primary" onClick={enterFocusMode}>
            ▶ Reply focus mode
          </Button>
          <span className="font-mono text-[11px] text-ink-3">
            Steps through {total} thread{total === 1 ? "" : "s"}, oldest first.
          </span>
        </div>
      ) : null}

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
