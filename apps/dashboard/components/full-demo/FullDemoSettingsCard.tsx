"use client";

import Link from "next/link";

import { useFullDemo } from "./FullDemoProvider";

/**
 * Settings Pilot entry-point card. Links to /demo for the calm choice
 * screen, and surfaces a persistent "Turn off demo" affordance whenever
 * the server flags are still on (even if local state is gone).
 */
export function FullDemoSettingsCard() {
  const { serverSettings, recoveryNeeded, active, exit } = useFullDemo();
  const flagsOn = !!serverSettings && (
    (serverSettings.presenterDemoMode && serverSettings.presenterDemoMode !== "off")
    || serverSettings.presenterReadOnly
  );

  return (
    <section
      className="space-y-3 rounded-[12px] border border-hairline bg-paper p-4 sm:rounded-3xl sm:p-5"
      data-demo-target="settings-full-demo"
      data-testid="settings-full-demo"
    >
      <header className="space-y-1">
        <h2 className="text-base font-medium text-ink">Demo</h2>
        <p className="text-sm text-ink-2">
          Try with sample conversations, or explore selected real conversations without sending.
          Nothing is sent automatically.
        </p>
      </header>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <Link
          href="/demo"
          className="inline-flex min-h-[44px] w-full items-center justify-center rounded-[10px] bg-ink px-3 py-2.5 text-sm font-medium text-paper hover:bg-ink-2 sm:w-auto sm:min-h-0 sm:rounded-pill sm:py-1.5"
        >
          Run demo
        </Link>
        {(flagsOn || active || recoveryNeeded) ? (
          <button
            type="button"
            onClick={() => void exit()}
            className="inline-flex min-h-[44px] w-full items-center justify-center rounded-[10px] border border-hairline bg-paper px-3 py-2.5 text-sm font-medium text-ink hover:border-hairline-strong sm:w-auto sm:min-h-0 sm:rounded-pill sm:py-1.5"
            data-demo-target="settings-full-demo-exit"
          >
            Turn off demo
          </button>
        ) : null}
      </div>
      {recoveryNeeded ? (
        <p className="text-xs text-ink-3">
          Demo mode is still on but the walkthrough state is missing locally. Use the button above to
          exit cleanly.
        </p>
      ) : null}
    </section>
  );
}
