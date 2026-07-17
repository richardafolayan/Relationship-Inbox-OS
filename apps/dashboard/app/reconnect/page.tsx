"use client";

import { useCallback, useEffect, useMemo, useState, type MouseEvent } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { apiGet, apiPost } from "@/lib/api";
import type { InboxResponse, InboxRow } from "@/lib/types";
import { Canvas, PageHead, CaughtUp } from "@/components/common/canvas";
import { PersonAvatar } from "@/components/common/person-avatar";
import {
  combinedReconnectScore,
  interpretRefreshScoresResult,
  isReconnectCandidate,
  rankReconnectCandidates,
  RECONNECT_SCROLL_KEY,
  shouldDiscloseReconnectReason
} from "@/lib/reconnect";
import type { RefreshScoresStatus } from "@/lib/reconnect";
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
  status: RefreshScoresStatus;
  scored: number;
  skipped: number;
  failed: number;
  candidates_seen: number;
  limit: number;
}

type RefreshState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; summary: string; tone: "ok" | "warn" }
  | { kind: "error"; message: string };

// AppShell scrolls <main> (overflow-y-auto); document scroll is locked.
function getListScroller(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector("main");
}

function readScrollY(): number {
  try {
    const raw = sessionStorage.getItem(RECONNECT_SCROLL_KEY);
    if (raw == null) return 0;
    const y = Number(raw);
    return Number.isFinite(y) && y > 0 ? y : 0;
  } catch {
    return 0;
  }
}

function writeScrollY(y: number): void {
  try {
    sessionStorage.setItem(RECONNECT_SCROLL_KEY, String(Math.max(0, Math.round(y))));
  } catch {
    // Private mode / blocked storage: scroll restore is best-effort.
  }
}

function captureListScrollY(): number {
  return getListScroller()?.scrollTop ?? 0;
}

function restoreListScrollY(y: number): void {
  const scroller = getListScroller();
  if (scroller) scroller.scrollTop = y;
}

export default function ReconnectPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh_state, setRefreshState] = useState<RefreshState>({ kind: "idle" });
  const [aboutOpen, setAboutOpen] = useState(false);

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

  // Restore list place after a thread visit so the operator can keep scanning.
  useEffect(() => {
    if (!loaded) return;
    const scroller = getListScroller();
    const y = readScrollY();
    if (y > 0) {
      requestAnimationFrame(() => {
        restoreListScrollY(y);
      });
    }
    const onScroll = () => writeScrollY(captureListScrollY());
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      writeScrollY(captureListScrollY());
      scroller?.removeEventListener("scroll", onScroll);
    };
  }, [loaded]);

  const candidates = useMemo(() => {
    if (!data) return [] as InboxRow[];
    return rankReconnectCandidates(data.rows.filter(isReconnectCandidate));
  }, [data]);

  const handleRefreshScores = useCallback(async () => {
    if (refresh_state.kind === "running") return;
    setRefreshState({ kind: "running" });
    try {
      const result = await apiPost<RefreshScoresResponse>(
        "/runner/control/reconnect/refresh-scores",
        { limit: 20 }
      );
      await refresh();
      const { summary, tone } = interpretRefreshScoresResult(result);
      setRefreshState({ kind: "done", summary, tone });
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
    return "Refresh scores";
  })();
  const refreshButtonTone =
    refresh_state.kind === "error"
      ? "text-risk-overdue border-risk-overdue/40"
      : refresh_state.kind === "done" && refresh_state.tone === "warn"
        ? "text-risk-waiting border-risk-waiting/40"
        : refresh_state.kind === "done"
          ? "text-ink border-hairline-strong"
          : "text-ink-2 border-hairline";

  return (
    <Canvas data-testid="reconnect-page">
      <PageHead
        eyebrow="Worth a hello"
        title="Reconnect"
        subtitle="LinkedIn people who went quiet. Open one to write a hello yourself."
        meta={
          loaded ? (
            <span className="flex items-baseline justify-end gap-4">
              <span>
                <strong className="font-medium text-ink">{candidates.length}</strong>{" "}
                {candidates.length === 1 ? "person" : "people"}
              </span>
            </span>
          ) : null
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:mb-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => setAboutOpen((open) => !open)}
            className="min-h-[36px] text-left text-[12px] text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline"
            data-testid="reconnect-about-toggle"
            aria-expanded={aboutOpen}
          >
            {aboutOpen ? "Hide list notes" : "About this list"}
          </button>
          {aboutOpen ? (
            <p
              className="mt-1 max-w-[60ch] text-[12px] leading-[1.5] text-ink-3"
              data-testid="reconnect-about-body"
            >
              LinkedIn catch-ups only. iMessage replies stay in Today and Inbox as
              active conversations. Nothing here is auto-sent.
            </p>
          ) : null}
        </div>

        {loaded && candidates.length > 0 ? (
          <button
            type="button"
            onClick={() => void handleRefreshScores()}
            disabled={refresh_state.kind === "running"}
            className={`inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-pill border px-4 text-[13px] font-medium tracking-[-0.005em] transition-colors duration-calm hover:border-hairline-strong hover:text-ink disabled:opacity-60 ${refreshButtonTone}`}
            data-testid="reconnect-refresh-scores"
            aria-live="polite"
            aria-busy={refresh_state.kind === "running"}
          >
            {refresh_state.kind === "running" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : null}
            <span className="max-w-[240px] truncate sm:max-w-[320px]">{refreshButtonLabel}</span>
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="mb-6 rounded-row border border-hairline bg-paper-2 px-4 py-3 text-[12px] leading-[1.5] text-ink-2">
          {error}
        </p>
      ) : null}

      {!loaded ? (
        <p className="font-mono text-[12px] text-ink-3">Loading…</p>
      ) : candidates.length === 0 ? (
        <CaughtUp
          title="Nothing to rekindle right now."
          body="When LinkedIn threads go quiet for more than 30 days they will show up here. iMessage replies stay in Today and Inbox."
        />
      ) : (
        <div className="flex flex-col" data-testid="reconnect-list">
          {candidates.map((row, index) => (
            <ReconnectRow
              key={row.id}
              row={row}
              suggested={index < 3 && combinedReconnectScore(row) >= 55}
              onNavigate={() => writeScrollY(captureListScrollY())}
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
  onNavigate: () => void;
}

// Compact two-level row for fast mobile scanning:
//   Name                                          52d
//   You: last message preview…
//   Suggested · Why this person?  (disclosure for long AI reasons)
function ReconnectRow({ row, suggested, onNavigate }: ReconnectRowProps) {
  const preview = normalizePreview(row.preview);
  const previewBody = row.lastMessageDirection === "OUT" ? `You: ${preview}` : preview;
  const quietFor = formatDuration(row.lastMessageAt);
  const reason = row.reconnectScoreReason?.trim() || null;
  const discloseReason = shouldDiscloseReconnectReason(reason);
  const [reasonOpen, setReasonOpen] = useState(false);

  const toggleReason = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setReasonOpen((open) => !open);
  };

  return (
    <article
      className={`border-b border-hairline ${
        suggested ? "border-l-2 border-l-accent/50 pl-2 sm:pl-3" : "pl-1"
      }`}
      data-testid="reconnect-row"
      data-suggested={suggested ? "true" : "false"}
    >
      <Link
        href={`/thread/${row.id}`}
        onClick={onNavigate}
        className="grid min-h-[56px] grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-x-3 py-3 transition-colors duration-calm hover:bg-paper-2 sm:min-h-[60px] sm:gap-x-3.5 sm:py-[14px]"
        data-testid="reconnect-row-link"
      >
        <PersonAvatar
          name={row.personName}
          avatarUrl={row.personAvatarUrl}
          size={32}
          className="text-[11px]"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className="min-w-0 truncate text-[14px] font-medium tracking-[-0.005em] text-ink sm:text-[15px]"
              data-testid="reconnect-row-name"
            >
              {row.personName}
            </span>
            {suggested ? (
              <span
                className="shrink-0 rounded-full bg-accent/15 px-[7px] py-[2px] font-mono text-[10px] uppercase tracking-[0.08em] text-accent-ink"
                data-testid="reconnect-row-suggested"
              >
                Suggested
              </span>
            ) : null}
          </span>
          <span
            className="block min-w-0 truncate text-[13px] leading-[1.4] text-ink-3"
            data-testid="reconnect-row-preview"
          >
            {previewBody}
          </span>
          {reason && !discloseReason ? (
            <span
              className="block min-w-0 truncate text-[12px] leading-[1.4] text-ink-3"
              data-testid="reconnect-row-reason"
            >
              {reason}
            </span>
          ) : null}
        </span>
        <span
          className="shrink-0 pt-0.5 font-mono text-[11px] tabular-nums text-ink-3"
          data-testid="reconnect-row-elapsed"
          title={`quiet for ${quietFor}`}
        >
          {quietFor}
        </span>
      </Link>

      {reason && discloseReason ? (
        <div className="pb-3 pl-[44px] pr-1 sm:pl-[46px]" data-testid="reconnect-row-reason-wrap">
          <button
            type="button"
            onClick={toggleReason}
            className="min-h-[36px] text-left text-[12px] font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline"
            data-testid="reconnect-row-why"
            aria-expanded={reasonOpen}
          >
            {reasonOpen ? "Hide reason" : "Why this person?"}
          </button>
          {reasonOpen ? (
            <p
              className="mt-1 max-w-[64ch] text-[12px] leading-[1.45] text-ink-3"
              data-testid="reconnect-row-reason"
            >
              {reason}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
