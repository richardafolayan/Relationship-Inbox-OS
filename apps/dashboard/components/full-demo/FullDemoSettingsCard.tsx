"use client";

import Link from "next/link";

import { useFullDemo } from "./FullDemoProvider";

/**
 * Settings page entry-point card. Links to /demo for the calm choice
 * screen, and surfaces a persistent "Turn off presenter demo" affordance
 * whenever the server flags are still on (even if local state is gone).
 */
export function FullDemoSettingsCard() {
  const { serverSettings, recoveryNeeded, active, exit } = useFullDemo();
  const flagsOn = !!serverSettings && (
    (serverSettings.presenterDemoMode && serverSettings.presenterDemoMode !== "off")
    || serverSettings.presenterReadOnly
  );

  return (
    <section
      className="space-y-3 rounded-3xl border border-hairline bg-paper p-5"
      data-demo-target="settings-full-demo"
    >
      <header className="space-y-1">
        <h2 className="text-base font-medium text-ink">Run full demo</h2>
        <p className="text-sm text-ink-2">
          Walk through the whole app. Sandbox uses a seeded showcase inbox. Live mode is read-only against real threads you choose.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/demo"
          className="inline-flex items-center rounded-pill bg-ink px-3 py-1.5 text-sm font-medium text-paper hover:bg-ink-2"
        >
          Open demo
        </Link>
        {(flagsOn || active || recoveryNeeded) ? (
          <button
            type="button"
            onClick={() => void exit()}
            className="inline-flex items-center rounded-pill border border-hairline bg-paper px-3 py-1.5 text-sm font-medium text-ink hover:border-hairline-strong"
            data-demo-target="settings-full-demo-exit"
          >
            Turn off presenter demo
          </button>
        ) : null}
      </div>
      {recoveryNeeded ? (
        <p className="text-xs text-ink-3">
          Presenter mode is on but the walkthrough state is missing locally. Use the button above to exit cleanly.
        </p>
      ) : null}
    </section>
  );
}
