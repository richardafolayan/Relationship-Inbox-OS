"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { InboxRow } from "@/lib/types";
import { useFullDemo } from "./FullDemoProvider";
import { LiveThreadPicker } from "./LiveThreadPicker";

/**
 * Calm choice screen that opens when the operator picks "Run full demo".
 * Two modes: sandbox (seeded showcase data, safe to interact with) and
 * live read-only (real threads, every mutation intercepted). Live mode
 * requires explicit thread selection so it can never accidentally
 * surface every private conversation in the inbox at once.
 */

export function FullDemoStartScreen({ inboxRows }: { inboxRows: InboxRow[] }) {
  const { start } = useFullDemo();
  const [pickingLive, setPickingLive] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  const livePickerCandidates = useMemo(
    () => inboxRows.filter((r) => r.id && r.personName),
    [inboxRows]
  );

  if (pickingLive) {
    return (
      <section className="space-y-6">
        <header className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            Live demo · pick threads
          </p>
          <h2 className="m-0 font-display text-[20px] font-medium tracking-[-0.01em]">
            Choose the threads to walk through
          </h2>
          <p className="m-0 max-w-[60ch] text-[13px] text-ink-2">
            The app stays read-only. Sending, archiving, snoozing and marking handled are intercepted with a clear notice.
          </p>
        </header>
        <LiveThreadPicker
          candidates={livePickerCandidates}
          selected={selected}
          onChange={setSelected}
        />
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={selected.length === 0}
            onClick={() => void start("live", selected)}
          >
            Start live demo
          </Button>
          <Button variant="quiet" onClick={() => setPickingLive(false)}>
            Back
          </Button>
        </div>
      </section>
    );
  }

  // Two side-by-side option cards. At narrow widths the grid collapses
  // to a single column; at the Canvas's full 920px the cards sit side
  // by side so the page does not feel empty.
  return (
    <section className="grid gap-3 sm:gap-4 md:grid-cols-2">
      <button
        type="button"
        className="flex min-h-[160px] flex-col rounded-card border border-hairline bg-paper-2 p-4 text-left transition-colors duration-calm hover:border-hairline-strong sm:h-full sm:p-6"
        onClick={() => void start("sandbox")}
        data-demo-target="full-demo-start-sandbox"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          Sandbox
        </span>
        <span className="mt-2 font-display text-[18px] font-medium tracking-[-0.01em] text-ink">
          Start sandbox demo
        </span>
        <span className="mt-2 text-[13.5px] leading-[1.55] text-ink-2">
          Seeds a showcase inbox: Serena on iMessage, Timi on LinkedIn, and a handful of demo threads. Every action stays inside the demo data.
        </span>
      </button>

      <button
        type="button"
        className="flex min-h-[160px] flex-col rounded-card border border-hairline bg-paper p-4 text-left transition-colors duration-calm hover:border-hairline-strong sm:h-full sm:p-6"
        onClick={() => setPickingLive(true)}
        data-demo-target="full-demo-start-live"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          Live, read-only
        </span>
        <span className="mt-2 font-display text-[18px] font-medium tracking-[-0.01em] text-ink">
          Use selected live threads
        </span>
        <span className="mt-2 text-[13.5px] leading-[1.55] text-ink-2">
          Walk through with real threads you choose. Sending, archiving and snoozing are intercepted.
        </span>
      </button>
    </section>
  );
}
