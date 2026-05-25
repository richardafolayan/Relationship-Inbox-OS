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
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-medium tracking-tight">Live demo: choose threads</h1>
          <p className="text-sm text-ink-2">
            Pick the real threads you want on screen during the demo. The app stays read-only, so sending, archiving, snoozing and marking handled are all intercepted with a clear notice. Nothing real is changed.
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
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-medium tracking-tight">Run full demo</h1>
        <p className="text-sm text-ink-2">
          Use a safe demo inbox to walk through the whole app without touching real conversations.
        </p>
      </header>

      <div className="space-y-4">
        <button
          type="button"
          className="block w-full rounded-3xl border border-hairline bg-paper-2 p-5 text-left transition-colors hover:border-hairline-strong"
          onClick={() => void start("sandbox")}
          data-demo-target="full-demo-start-sandbox"
        >
          <div className="text-sm font-medium text-ink">Start sandbox demo</div>
          <div className="mt-1 text-sm text-ink-2">
            Seeds a showcase inbox: Serena on iMessage, Timi on LinkedIn, and a handful of demo threads. Every action stays inside the demo data.
          </div>
        </button>

        <button
          type="button"
          className="block w-full rounded-3xl border border-hairline bg-paper p-5 text-left transition-colors hover:border-hairline-strong"
          onClick={() => setPickingLive(true)}
          data-demo-target="full-demo-start-live"
        >
          <div className="text-sm font-medium text-ink">Use selected live threads</div>
          <div className="mt-1 text-sm text-ink-2">
            Walk through with real threads you choose. The app is read-only, so sending, archiving and snoozing are intercepted.
          </div>
          <div className="mt-2 text-xs text-ink-3">
            Live mode is read-only by default. It will not send messages or change real threads.
          </div>
        </button>
      </div>
    </div>
  );
}
