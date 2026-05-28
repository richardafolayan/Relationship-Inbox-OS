"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ReplyBrief } from "@inbox-os/core";
import { cn } from "@/lib/utils";
import {
  MORE_DISCLOSURE_LABEL,
  durableContextLabel,
  moreSectionHasContent,
  shouldShowChecklist
} from "@/lib/reply-brief";
import { ActionItemsChecklist } from "./ActionItemsChecklist";

interface ReplyBriefPanelProps {
  threadId: string;
  brief: ReplyBrief;
  /** Active loops (mirrored from brief.required_points.text by the server). */
  openLoops: string[];
  dismissedOpenLoops: string[];
  onDismissLoop: (loop: string, dismissed: boolean) => void;
  /**
   * Issue #331. Per-loop AI coverage verdicts for the in-flight draft.
   * Forwarded to ActionItemsChecklist where "addressed" rows auto-tick
   * and "partial" rows render a soft "partly covered" hint with reason.
   */
  aiCoverageItems?: Array<{ loop: string; status: "addressed" | "partial"; reason?: string }>;
  /**
   * "auto-tick" / "highlight" / "off" mirror the existing checklist
   * behaviour driven by the operator's aiHelpLevel. Forwarded straight
   * to ActionItemsChecklist when the checklist is gated open.
   */
  aiCoverageMode?: "auto-tick" | "highlight" | "off";
}

// The thread right-rail Reply Brief, ordered action-first (issue #388) so
// it reads top-to-bottom in seconds and the operator knows what to send
// without opening anything:
//   1. Reply job — what this reply needs to do (the `on_you` read).
//   2. They said — the contact's reply-relevant points, as bullets.
//   3. Draft coverage — the reply obligations with their tick states
//      against the in-flight draft; drives revisions.
//   4. Where it stands — the narrative trace, demoted below the action
//      sections but kept for operators who want the prose context.
// Secondary material (optional follow-ups, fuller / durable context, tone
// steer, handled points) stays behind a single collapsed "More" disclosure.
//
// Things to remember stays separate — it lives in its own section
// alongside this panel because it surfaces durable life facts (exams,
// trips, birthdays) rather than reply-state.
export function ReplyBriefPanel({
  threadId,
  brief,
  openLoops,
  dismissedOpenLoops,
  onDismissLoop,
  aiCoverageItems,
  aiCoverageMode = "off"
}: ReplyBriefPanelProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();

  const requiredCount = brief.required_points.length;
  const showChecklist = shouldShowChecklist({
    requiredPointsCount: requiredCount,
    dismissedOpenLoopsCount: dismissedOpenLoops.length
  });
  const hasMore = moreSectionHasContent(brief);

  // Trim once for the visible card. The brief text is already sanitised
  // server-side, but defensive trimming keeps stray whitespace from
  // pushing the panel out of its 10-second budget.
  const where = useMemo(() => brief.where_it_stands?.trim() ?? "", [brief.where_it_stands]);
  const onYou = useMemo(() => brief.on_you?.trim() ?? "", [brief.on_you]);
  const theySaid = useMemo(
    () => (brief.they_said ?? []).filter((p) => p.text.trim().length > 0),
    [brief.they_said]
  );

  return (
    <section
      data-testid="reply-brief"
      data-demo-target="reply-brief"
      data-tour="reply-brief"
      className="flex flex-col gap-7"
    >
      {/* 1. Reply job — the obligation read, promoted to lead the rail so
          the operator sees what this reply needs to do first. Backed by the
          existing `on_you` field; the data-demo-target stays the same so the
          pilot tour keeps resolving this anchor. */}
      {onYou ? (
        <div data-demo-target="reply-brief-on-you" data-tour="reply-brief-on-you">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
            Reply job
          </p>
          <p className="m-0 text-[14px] leading-[1.55] text-ink">{onYou}</p>
        </div>
      ) : null}

      {/* 2. They said — the contact's reply-relevant points as bullets, so
          the operator can answer without rereading the thread. */}
      {theySaid.length > 0 ? (
        <div>
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
            They said
          </p>
          <ul className="m-0 list-none space-y-[7px] p-0">
            {theySaid.map((point) => (
              <li
                key={`they:${point.id}`}
                className="flex items-start gap-2 text-[13.5px] leading-[1.55] text-ink-2"
              >
                <span
                  aria-hidden
                  className="mt-[8px] h-[5px] w-[5px] shrink-0 rounded-full bg-hairline-strong"
                />
                <span className="min-w-0 flex-1">{point.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* 3. Draft coverage — promoted out of the "More" disclosure (issue
          #388). The reply obligations and their tick states against the
          in-flight draft, so coverage drives revisions instead of hiding
          behind a click. Gated to 2+ required points or dismissed loops
          worth restoring; a single obligation stays carried by Reply job. */}
      {showChecklist ? (
        <ActionItemsChecklist
          threadId={threadId}
          openLoops={openLoops}
          dismissedOpenLoops={dismissedOpenLoops}
          isReopenMode={false}
          onDismiss={onDismissLoop}
          aiCoverageItems={aiCoverageItems}
          aiCoverageMode={aiCoverageMode}
        />
      ) : null}

      {/* 4. Where it stands — the narrative trace, demoted below the action
          sections but kept for operators who still want the prose. */}
      {where ? (
        <div data-demo-target="reply-brief-where-it-stands" data-tour="reply-brief-where-it-stands">
          <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
            Where it stands
          </p>
          <p className="m-0 text-[14px] leading-[1.55] text-ink">{where}</p>
        </div>
      ) : null}

      {hasMore ? (
        <div>
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-controls={moreId}
            className="group flex w-full items-center justify-between gap-2 border-t border-hairline pt-3 text-left font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:text-ink focus:outline-none focus-visible:text-ink"
          >
            <span>{MORE_DISCLOSURE_LABEL}</span>
            <ChevronDown
              aria-hidden
              strokeWidth={1.8}
              className={cn(
                "h-[13px] w-[13px] transition-transform duration-calm",
                moreOpen ? "rotate-180" : "rotate-0"
              )}
            />
          </button>

          {moreOpen ? (
            <div id={moreId} className="mt-4 flex flex-col gap-6">
              {brief.optional_followups.length > 0 ? (
                <div>
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    Optional follow-ups
                  </p>
                  <p className="mb-3 text-[12px] leading-[1.5] text-ink-3">
                    Suggestions the AI noticed. They didn't ask, so it's just a
                    nudge.
                  </p>
                  <ul className="m-0 list-none space-y-[7px] p-0">
                    {brief.optional_followups.map((point) => (
                      <li
                        key={`optional:${point.id}`}
                        className="flex items-start gap-2 text-[13px] leading-[1.55] text-ink-2"
                      >
                        <span
                          aria-hidden
                          className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-hairline-strong"
                        />
                        <span className="min-w-0 flex-1">{point.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {brief.durable_context && brief.durable_context.trim() ? (
                <div>
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    {durableContextLabel()}
                  </p>
                  <p className="m-0 text-[13px] leading-[1.55] text-ink-2">
                    {brief.durable_context.trim()}
                  </p>
                </div>
              ) : null}

              {brief.fuller_context && brief.fuller_context.trim() ? (
                <div>
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    More context
                  </p>
                  <p className="m-0 text-[13px] leading-[1.55] text-ink-2">
                    {brief.fuller_context.trim()}
                  </p>
                </div>
              ) : null}

              {brief.tone_steer && brief.tone_steer.trim() ? (
                <div>
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    Tone steer
                  </p>
                  <p className="m-0 text-[13px] leading-[1.55] text-ink-2">
                    {brief.tone_steer.trim()}
                  </p>
                </div>
              ) : null}

              {brief.handled_points && brief.handled_points.length > 0 ? (
                <div>
                  <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
                    Already covered
                  </p>
                  <ul className="m-0 list-none space-y-[6px] p-0">
                    {brief.handled_points.map((point) => (
                      <li
                        key={`handled:${point.id}`}
                        className="flex items-start gap-2 text-[12.5px] leading-[1.5] text-ink-3"
                      >
                        <span aria-hidden className="mt-[2px] shrink-0 text-ink-4">
                          ✓
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="text-ink-2 line-through decoration-ink-4">
                            {point.text}
                          </span>
                          {point.reason ? (
                            <span className="block text-[11.5px] text-ink-4">
                              {point.reason}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
