import type { PlatformName } from "./types";

export type MessageSyncMetric =
  | "source_change_to_persisted_message"
  | "persisted_message_to_visible_ui"
  | "send_click_to_visible_acknowledgement"
  | "send_click_to_trustworthy_platform_result";

export function afterNextPaint(callback: () => void): void {
  if (typeof window === "undefined") return;
  window.requestAnimationFrame(() => window.requestAnimationFrame(callback));
}

export function recordMessageSyncLatency(input: {
  metric: MessageSyncMetric;
  durationMs: number;
  platform?: PlatformName;
  outcome?: "success" | "failure";
}): void {
  if (typeof window === "undefined" || !Number.isFinite(input.durationMs) || input.durationMs < 0) return;
  const durationMs = Math.round(input.durationMs * 100) / 100;
  const end = performance.now();
  try {
    performance.measure(`rios:${input.metric}`, {
      start: Math.max(0, end - durationMs),
      end,
      detail: { platform: input.platform, outcome: input.outcome }
    });
  } catch {
    // The local telemetry POST remains useful on older WebViews.
  }
  void fetch("/runner/control/message-sync-latency", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, durationMs }),
    keepalive: true
  }).catch(() => undefined);
}
