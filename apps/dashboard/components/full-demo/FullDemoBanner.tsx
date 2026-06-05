"use client";

import { useFullDemo } from "./FullDemoProvider";

/**
 * Top-of-app banner that surfaces whenever the runner reports presenter
 * mode is on. Rendered from AppShell so it sits above every route. It's
 * visible in three situations:
 *
 *  1. Sandbox demo active — shows "Sandbox demo running" + exit.
 *  2. Live demo active — shows "Live demo, read only" + exit.
 *  3. Recovery: server flags on but local state lost (closed tab / crash).
 *     Banner explains and offers a one-click reset.
 */
export function FullDemoBanner() {
  const { active, mode, serverSettings, recoveryNeeded, exit } = useFullDemo();

  const showActive = active && mode;
  if (!showActive && !recoveryNeeded) return null;

  let title = "Demo running";
  let body: string | null = null;
  let tone: "info" | "warn" = "info";

  if (showActive && mode === "sandbox") {
    title = "Sandbox demo running";
    body = "All interactions stay in the demo data.";
  } else if (showActive && mode === "live") {
    title = "Live demo, read only";
    body = "Sending, archiving, snoozing and mark-handled are blocked.";
    tone = "warn";
  } else if (recoveryNeeded) {
    title = serverSettings?.presenterReadOnly
      ? "Live demo, read only (recover)"
      : "Sandbox demo running (recover)";
    body =
      "The app is still in presenter mode but the local walkthrough state is gone. Exit cleanly to restore normal behaviour.";
    tone = "warn";
  }

  const ring = tone === "warn" ? "border-risk-overdue/40 bg-[oklch(98%_0.03_28)]" : "border-hairline bg-paper-2";

  return (
    <div
      role="status"
      aria-live="polite"
      data-demo-target="full-demo-banner"
      className={`flex items-center justify-between gap-4 border-b px-4 py-2 text-sm ${ring}`}
    >
      <div className="flex flex-col">
        <span className="font-medium text-ink">{title}</span>
        {body ? <span className="text-xs text-ink-2">{body}</span> : null}
      </div>
      <button
        type="button"
        onClick={() => void exit()}
        className="rounded-pill border border-hairline bg-paper px-3 py-1 text-xs font-medium text-ink hover:border-hairline-strong"
        data-demo-target="full-demo-banner-exit"
      >
        Exit demo
      </button>
    </div>
  );
}
