"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiGet, apiPost } from "@/lib/api";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { PersonAvatar } from "@/components/common/person-avatar";
import {
  combinedReconnectScore,
  isReconnectCandidate,
  rankReconnectCandidates
} from "@/lib/reconnect";
import { formatDuration } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";

// Phase 3 of #287. Old LinkedIn threads do not vanish - they sit here as
// quiet prompts to reach out. The page deliberately does not draft a
// message or send anything; opening a thread takes the operator to the
// usual thread view where they can write the reconnect note themselves.
//
// iMessage threads never appear here (see lib/reconnect.ts for the
// platform-split rationale).

/** Response shape from POST /control/reconnect/refresh-scores. */
interface RefreshScoresResponse {
  status: "ok" | "ai_unavailable";
  scored: number;
  skipped: number;
  failed: number;
  candidates_seen: number;
  limit: number;
}

type RefreshState =
  | { kind: "idle" }
  | { kind: "running" }
  // The "done" state holds the last summary so the operator can see what
  // happened. It clears back to idle after a few seconds via a timer in
  // the click handler.
  | { kind: "done"; summary: string; tone: "ok" | "warn" }
  | { kind: "error"; message: string };

export default function ReconnectPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Inline running/success state for the "Refresh AI scores" button.
  // Memory note: every action button surfaces inline running / success
  // status, not just a label flip — that is what this state drives.
  const [refresh_state, setRefreshState] = useState<RefreshState>({ kind: "idle" });

  const refresh = useCallback(async () => {
    try {
      const inbox = await apiGet<InboxResponse>("/runner/data/inbox");
      setData(inbox);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the runner.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onResync = () => void refresh();
    window.addEventListener("runner-resync", onResync);
    return () => window.removeEventListener("runner-resync", onResync);
  }, [refresh]);

  const candidates = useMemo(() => {
    if (!data) return [] as InboxRow[];
    return rankReconnectCandidates(data.rows.filter(isReconnectCandidate));
  }, [data]);

  const handleRefreshScores = useCallback(async () => {
    if (refresh_state.kind === "running") return;
    setRefreshState({ kind: "running" });
    try {
      // Limit 20 matches the runner's default. Higher values are allowed
      // (up to 100) but 20 is a calm pace: it covers the typical pilot
      // backlog in two clicks without spiking provider usage.
      const result = await apiPost<RefreshScoresResponse>(
        "/runner/control/reconnect/refresh-scores",
        { limit: 20 }
      );
      // Pull the freshly-persisted scores into the page so the order
      // and captions update without a manual reload.
      await refresh();
      const tone: "ok" | "warn" = result.status === "ai_unavailable" ? "warn" : "ok";
      const summary =
        result.scored === 0 && result.skipped > 0
          ? "Already up to date"
          : result.status === "ai_unavailable"
            ? `Scored ${result.scored}, then AI went quiet`
            : `Scored ${result.scored}${result.skipped > 0 ? `, skipped ${result.skipped} already done` : ""}`;
      setRefreshState({ kind: "done", summary, tone });
      // Settle back to idle after a few seconds so the button is ready
      // for another click without the operator having to click away.
      window.setTimeout(() => {
        setRefreshState((current) => (current.kind === "done" ? { kind: "idle" } : current));
      }, 4500);
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : "Could not reach the runner.";
      setRefreshState({ kind: "error", message });
      window.setTimeout(() => {
        setRefreshState((current) => (current.kind === "error" ? { kind: "idle" } : current));
      }, 5000);
    }
  }, [refresh, refresh_state.kind]);

  const refreshButtonLabel = (() => {
    if (refresh_state.kind === "running") return "Scoring…";
    if (refresh_state.kind === "done") return refresh_state.summary;
    if (refresh_state.kind === "error") return refresh_state.message;
    return "Refresh AI scores";
  })();
  const refreshButtonTone =
    refresh_state.kind === "error"
      ? "text-risk-overdue"
      : refresh_state.kind === "done" && refresh_state.tone === "warn"
        ? "text-risk-waiting"
        : "text-ink-3";

  return (
    <Canvas>
      <PageHead
        eyebrow="Worth a hello"
        title="Reconnect"
        subtitle="LinkedIn threads that have gone quiet but still might be worth a gentle hello. Open one to write the message yourself - nothing here is auto-sent."
        meta={
          loaded ? (
            <span className="flex items-baseline gap-4">
              <span>
                <strong className="font-medium text-ink">{candidates.length}</strong>{" "}
                {candidates.length === 1 ? "person" : "people"}
              </span>
              {candidates.length > 0 ? (
                <button
                  type="button"
                  onClick={() => void handleRefreshScores()}
                  disabled={refresh_state.kind === "running"}
                  className={`font-mono text-[11px] uppercase tracking-[0.06em] transition-colors duration-calm hover:text-ink disabled:opacity-60 ${refreshButtonTone}`}
                  data-testid="reconnect-refresh-scores"
                  aria-live="polite"
                >
                  {refreshButtonLabel}
                </button>
              ) : null}
            </span>
          ) : null
        }
      />

      {error ? (
        <p className="mb-6 font-mono text-[11px] text-risk-overdue">{error}</p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : candidates.length === 0 ? (
        <CaughtUp
          title="Nothing to rekindle right now."
          body="When LinkedIn threads go quiet for more than 30 days they will show up here so you can revisit them on your own terms."
        />
      ) : (
        <div className="flex flex-col">
          {candidates.map((row, index) => (
            <ReconnectRow
              key={row.id}
              row={row}
              // The first few rows scoring above the "worth a hello"
              // threshold get a quiet accent. The threshold is gentle so
              // that even a deterministic-only ranking surfaces the
              // best handful at the top with a subtle "Suggested" mark.
              suggested={index < 3 && combinedReconnectScore(row) >= 55}
            />
          ))}
        </div>
      )}
    </Canvas>
  );
}

interface ReconnectRowProps {
  row: InboxRow;
  suggested: boolean;
}

// Reconnect row layout deliberately differs from Inbox: there is no risk
// dot or unread badge to defuse - everything here is, by definition,
// quiet. The right column shows "quiet for Nm" so the operator can pick
// the freshest-still-rememberable threads first. When the AI reconnect
// scorer (phase 3.5) ran for this thread the reason caption sits under
// the preview as a quiet "why".
function ReconnectRow({ row, suggested }: ReconnectRowProps) {
  const preview = normalizePreview(row.preview);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${preview}` : preview;
  const quietFor = formatDuration(row.lastMessageAt);
  const reason = row.reconnectScoreReason?.trim() || null;
  return (
    <Link
      href={`/thread/${row.id}`}
      className="grid grid-cols-[28px_1fr_auto] items-start gap-[14px] border-b border-hairline px-1 py-[13px] transition-colors duration-calm hover:bg-paper-2"
    >
      <PersonAvatar
        name={row.personName}
        avatarUrl={row.personAvatarUrl}
        size={28}
        className="text-[11px]"
      />
      <span className="flex min-w-0 flex-col gap-[3px]">
        <span className="flex min-w-0 items-baseline gap-[10px]">
          <span className="shrink-0 text-[14px] font-medium tracking-[-0.005em] text-ink">
            {row.personName}
          </span>
          {suggested ? (
            <span className="shrink-0 rounded-full bg-accent/15 px-[7px] py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink">
              Suggested
            </span>
          ) : null}
          <span className="min-w-0 truncate text-[13px] text-ink-3">{previewBody}</span>
        </span>
        {reason ? (
          <span className="block text-[12px] text-ink-3">{reason}</span>
        ) : null}
      </span>
      <span className="font-mono text-[11px] text-ink-3">quiet for {quietFor}</span>
    </Link>
  );
}
