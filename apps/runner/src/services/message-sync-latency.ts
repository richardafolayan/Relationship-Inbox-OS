import type { PlatformName } from "@inbox-os/core";

export const MESSAGE_SYNC_METRICS = [
  "source_change_to_persisted_message",
  "persisted_message_to_visible_ui",
  "send_click_to_visible_acknowledgement",
  "send_click_to_trustworthy_platform_result"
] as const;

export type MessageSyncMetric = (typeof MESSAGE_SYNC_METRICS)[number];

export interface MessageSyncLatencySample {
  metric: MessageSyncMetric;
  durationMs: number;
  platform?: PlatformName;
  outcome?: "success" | "failure";
  observedAt: string;
}

export interface MessageSyncLatencySummary {
  metric: MessageSyncMetric;
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)] ?? null;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

export function createMessageSyncLatencyTracker(maxSamplesPerMetric = 500): {
  record(input: Omit<MessageSyncLatencySample, "observedAt"> & { observedAt?: string }): void;
  startSend(clientSendId: string, clickedAt: string): void;
  finishSend(input: {
    clientSendId: string;
    platform: PlatformName;
    outcome: "success" | "failure";
    finishedAt?: string;
  }): void;
  summary(): MessageSyncLatencySummary[];
  samples(): MessageSyncLatencySample[];
} {
  const samplesByMetric = new Map<MessageSyncMetric, MessageSyncLatencySample[]>();
  const sendStarts = new Map<string, string>();

  function record(
    input: Omit<MessageSyncLatencySample, "observedAt"> & { observedAt?: string }
  ): void {
    if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return;
    const rows = samplesByMetric.get(input.metric) ?? [];
    rows.push({
      ...input,
      durationMs: Math.round(input.durationMs * 100) / 100,
      observedAt: input.observedAt ?? new Date().toISOString()
    });
    if (rows.length > maxSamplesPerMetric) {
      rows.splice(0, rows.length - maxSamplesPerMetric);
    }
    samplesByMetric.set(input.metric, rows);
  }

  return {
    record,
    startSend(clientSendId, clickedAt): void {
      if (!sendStarts.has(clientSendId) && Number.isFinite(Date.parse(clickedAt))) {
        sendStarts.set(clientSendId, clickedAt);
      }
    },
    finishSend(input): void {
      const startedAt = sendStarts.get(input.clientSendId);
      sendStarts.delete(input.clientSendId);
      if (!startedAt) return;
      const finishedAt = input.finishedAt ?? new Date().toISOString();
      const durationMs = Date.parse(finishedAt) - Date.parse(startedAt);
      record({
        metric: "send_click_to_trustworthy_platform_result",
        durationMs,
        platform: input.platform,
        outcome: input.outcome,
        observedAt: finishedAt
      });
    },
    summary(): MessageSyncLatencySummary[] {
      return MESSAGE_SYNC_METRICS.map((metric) => {
        const values = (samplesByMetric.get(metric) ?? []).map((sample) => sample.durationMs);
        return {
          metric,
          samples: values.length,
          p50Ms: rounded(percentile(values, 0.5)),
          p95Ms: rounded(percentile(values, 0.95)),
          minMs: rounded(values.length > 0 ? Math.min(...values) : null),
          maxMs: rounded(values.length > 0 ? Math.max(...values) : null)
        };
      });
    },
    samples(): MessageSyncLatencySample[] {
      return MESSAGE_SYNC_METRICS.flatMap((metric) => samplesByMetric.get(metric) ?? []);
    }
  };
}
