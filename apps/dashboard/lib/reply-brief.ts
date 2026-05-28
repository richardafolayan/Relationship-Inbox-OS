import type { ReplyBrief, ReplyBriefPoint } from "@inbox-os/core";
import type { ThreadResponse } from "./types";

// Pure helpers backing the thread right-rail Reply Brief panel. The
// component is dumb; these decide what counts as "enough required points
// to surface a checklist", how to derive a safe brief when the server
// payload is missing one, etc. Extracted so the dashboard tests
// (tests/dashboard-reply-brief.test.mjs) can exercise the logic without
// React or jsdom.

/**
 * Conservative client-side fallback brief, used when the dashboard
 * receives a `ThreadResponse` whose `replyBrief` is null. The runner's
 * `GET /data/thread` already derives a server-side fallback for older
 * rows, so this branch is mostly defensive — for example when a
 * dashboard is talking to a runner build that predates the field, or
 * when `replyBriefJson` is corrupt.
 *
 * Never invents obligations. `required_points` is mapped 1:1 from
 * existing `openLoops` strings, and `on_you` falls back to a plain
 * statement of pending vs not-pending rather than echoing fragments of
 * unrelated context.
 */
export function chooseDisplayBrief(thread: Pick<
  ThreadResponse,
  "replyBrief" | "summary" | "whatTheyWant" | "openLoops" | "needsReply" | "messages"
>): ReplyBrief {
  if (thread.replyBrief) {
    return thread.replyBrief;
  }

  const latestInboundText =
    [...(thread.messages ?? [])].reverse().find((m) => m.direction === "IN")?.text ?? "";
  const trimmedSummary = (thread.summary ?? "").trim();
  const trimmedAsk = (thread.whatTheyWant ?? "").trim();
  const isStaticFallbackAsk =
    trimmedAsk.length === 0 || trimmedAsk.toLowerCase() === "no clear ask yet.";

  const whereItStands = trimmedSummary || latestInboundText.slice(0, 360);
  const onYou = !isStaticFallbackAsk
    ? trimmedAsk
    : thread.needsReply
      ? "They're waiting on a reply, but nothing specific has been asked. A short acknowledgement is enough."
      : "Nothing pending from them right now.";

  const required: ReplyBriefPoint[] = (thread.openLoops ?? []).map((text, i) => ({
    id: `loop-${i}`,
    text,
    status: "required" as const
  }));

  return {
    where_it_stands: whereItStands,
    on_you: onYou,
    required_points: required,
    optional_followups: [],
    handled_points: [],
    they_said: [],
    fuller_context: null,
    durable_context: null,
    tone_steer: null,
    enough_to_reply_without_scrolling: Boolean(whereItStands) && Boolean(onYou)
  };
}

// Gating for the Draft coverage section (#388). The reply checklist is now a
// top-level, action-first section rather than something tucked inside "More",
// so it surfaces whenever there is reply work to track: any active open loop,
// or any dismissed loop the operator might want to restore. (The checklist's
// own empty/manual-item states cover the rest.)
export function shouldShowDraftCoverage(args: {
  openLoopsCount: number;
  dismissedOpenLoopsCount: number;
}): boolean {
  if (args.openLoopsCount > 0) return true;
  if (args.dismissedOpenLoopsCount > 0) return true;
  return false;
}

// "More" disclosure has content when any of these exist:
//   - optional follow-ups
//   - fuller / durable context strings
//   - tone steer
//   - handled points worth surfacing
// (The reply checklist used to live here too; #388 promoted it to its own
// always-visible "Draft coverage" section.) When everything is empty, the
// disclosure renders nothing so the panel stays calm.
export function moreSectionHasContent(args: {
  brief: ReplyBrief;
  requiredPointsCount: number;
  dismissedOpenLoopsCount: number;
}): boolean {
  if (args.brief.optional_followups.length > 0) return true;
  if (args.brief.fuller_context && args.brief.fuller_context.trim()) return true;
  if (args.brief.durable_context && args.brief.durable_context.trim()) return true;
  if (args.brief.tone_steer && args.brief.tone_steer.trim()) return true;
  if (args.brief.handled_points && args.brief.handled_points.length > 0) return true;
  return false;
}

// "Who they are" label for the durable-context section. Kept neutral
// ("Who they are") rather than guessing pronouns — we don't carry a
// gender / pronoun signal on Person rows, and gendered guesses on
// non-Western names misfire often enough that neutral is safer.
export function durableContextLabel(): string {
  return "Who they are";
}

// Single source of truth for the disclosure label so the test can pin
// the exact wording from the spec.
export const MORE_DISCLOSURE_LABEL = "More context · nudge";
