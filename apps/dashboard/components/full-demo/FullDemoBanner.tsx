"use client";

import { useFullDemo } from "./FullDemoProvider";

/**
 * Top-of-app banner that surfaces whenever the runner reports presenter
 * mode is on. Rendered from AppShell so it sits above every route. It's
 * visible in three situations:
 *
 *  1. Sample demo active — practice conversations + exit.
 *  2. Real read-only demo active — no auto-send guarantee + exit.
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
    title = "Sample demo running";
    body = "Practice conversations only. Nothing is sent automatically.";
  } else if (showActive && mode === "live") {
    title = "Real conversations, read-only";
    body = "Nothing is sent automatically. Sending, archiving and snoozing are blocked.";
    tone = "warn";
  } else if (recoveryNeeded) {
    title = serverSettings?.presenterReadOnly
      ? "Real conversations, read-only (recover)"
      : "Sample demo running (recover)";
    body =
      "The app is still in demo mode but the local walkthrough state is gone. Exit cleanly to restore normal behaviour.";
    tone = "warn";
  }

  const ring = tone === "warn" ? "border-risk-overdue/40 bg-accent-soft" : "border-hairline bg-paper-2";

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
