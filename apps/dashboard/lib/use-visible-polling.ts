"use client";

import { useEffect, useRef } from "react";

/**
 * Run `tick` every `intervalMs`, but ONLY while the tab is visible.
 *
 * Several always-mounted components (the app shell, the top-status ticker,
 * the inbox) each poll the runner on a fixed wall-clock interval. In a
 * backgrounded tab those polls are pure waste — they keep the runner's
 * SQLite busy (competing with scans/sends/reassessments) for a view nobody
 * is looking at. This hook:
 *   - fires one immediate tick on mount (if visible),
 *   - polls on the interval while the tab is visible,
 *   - stops the interval entirely when the tab is hidden,
 *   - fires one catch-up tick the moment the tab becomes visible again.
 *
 * The callback is read through a ref so a changing `tick` identity never
 * re-arms the interval.
 */
export function useVisiblePolling(
  tick: () => void,
  intervalMs: number,
  enabled = true
): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => tickRef.current(), intervalMs);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tickRef.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      tickRef.current();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}
