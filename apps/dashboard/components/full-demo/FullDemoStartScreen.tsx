"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { InboxRow } from "@/lib/types";
import { useFullDemo } from "./FullDemoProvider";
import { LiveThreadPicker } from "./LiveThreadPicker";

/**
 * Calm choice screen that opens when the operator picks "Run demo".
 * Two modes: sample conversations (safe practice data) and real
 * conversations in read-only mode (no automatic send). Real mode
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
      <section className="space-y-6" data-testid="full-demo-live-picker">
        <header className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            Real conversations · pick threads
          </p>
          <h2 className="m-0 font-display text-[20px] font-medium tracking-[-0.01em]">
            Choose the threads to walk through
          </h2>
          <p className="m-0 max-w-[60ch] text-[13px] text-ink-2">
            Read-only. Nothing is sent automatically. Sending, archiving, snoozing and marking
            handled are blocked with a clear notice.
          </p>
        </header>
        <LiveThreadPicker
          candidates={livePickerCandidates}
          selected={selected}
          onChange={setSelected}
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <Button
            variant="primary"
            disabled={selected.length === 0}
            onClick={() => void start("live", selected)}
            className="min-h-[44px] w-full sm:w-auto"
          >
            Start with selected conversations
          </Button>
          <Button variant="quiet" onClick={() => setPickingLive(false)} className="min-h-[44px] w-full sm:w-auto">
            Back
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="grid gap-3 sm:gap-4 md:grid-cols-2" data-testid="full-demo-mode-choice">
      <button
        type="button"
        className="flex min-h-[160px] w-full flex-col rounded-card border border-hairline bg-paper-2 p-4 text-left transition-colors duration-calm hover:border-hairline-strong sm:h-full sm:p-6"
        onClick={() => void start("sandbox")}
        data-demo-target="full-demo-start-sandbox"
        data-testid="full-demo-start-sample"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          Sample
        </span>
        <span className="mt-2 font-display text-[18px] font-medium tracking-[-0.01em] text-ink">
          Try with sample conversations
        </span>
        <span className="mt-2 text-[13.5px] leading-[1.55] text-ink-2">
          Practice with demo threads (Serena on iMessage, Timi on LinkedIn). Safe to explore.
          Nothing is sent automatically.
        </span>
      </button>

      <button
        type="button"
        className="flex min-h-[160px] w-full flex-col rounded-card border border-hairline bg-paper p-4 text-left transition-colors duration-calm hover:border-hairline-strong sm:h-full sm:p-6"
        onClick={() => setPickingLive(true)}
        data-demo-target="full-demo-start-live"
        data-testid="full-demo-start-real"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          Real, read-only
        </span>
        <span className="mt-2 font-display text-[18px] font-medium tracking-[-0.01em] text-ink">
          Explore using selected real conversations without sending
        </span>
        <span className="mt-2 text-[13.5px] leading-[1.55] text-ink-2">
          You choose which real threads to open. Sending, archiving and snoozing are blocked.
          Nothing is sent automatically.
        </span>
      </button>
    </section>
  );
}
