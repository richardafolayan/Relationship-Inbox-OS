"use client";

import Link from "next/link";
import type { InboxRow } from "@/lib/types";
import { PLATFORM_LABEL, toDisplayRisk, type DisplayRisk } from "@/lib/risk";
import { formatRelative } from "@/lib/time";
import { cleanAskSummary, normalizePreview } from "@/lib/preview";
import { PersonAvatar } from "@/components/common/person-avatar";
import { NameSuggestionPill } from "@/components/common/name-suggestion-pill";
import { prefetchThreadData, cancelThreadPrefetch } from "@/lib/thread-prefetch";

interface SelectableThreadRowProps {
  row: InboxRow;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string, event: { shiftKey: boolean }) => void;
  onPersonChanged?: () => void;
}

const riskTextClass: Record<DisplayRisk, string> = {
  overdue: "text-risk-overdue font-medium",
  waiting: "text-risk-waiting font-medium",
  fresh: "text-ink-2"
};

// ThreadRow + select mode. Renders as Link normally (cmd/ctrl-click toggles
// select); renders as button in select mode (whole row toggles). Either
// way the modern row affordances apply: PersonAvatar with photo support,
// NameSuggestionPill rename, normalised preview, subtle risk label. The
// rename pill stops its own click propagation, so it's safe to embed
// inside both the Link and the button without triggering navigation
// or selection toggles.
export function SelectableThreadRow({
  row,
  selectMode,
  selected,
  onToggle,
  onPersonChanged
}: SelectableThreadRowProps) {
  const risk = toDisplayRisk(row.riskLevel);
  const cleanPreview = normalizePreview(row.preview);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${cleanPreview}` : cleanPreview;
  // Threads awaiting a reply lead with the AI context line ("what they
  // want"); replied/handled threads keep the literal "You: …" preview.
  // cleanAskSummary repairs legacy summaries stored hard-cut mid-word.
  const nudge = cleanAskSummary(row.whatTheyWant);
  const bodyText = row.needsReply !== false && nudge ? nudge : previewBody;
  const rightLabel =
    risk === "overdue"
      ? "Overdue"
      : risk === "waiting"
        ? "Waiting"
        : formatRelative(row.lastInboundAt ?? row.lastMessageAt);
  const category = row.category?.toLowerCase();
  const categoryLabel =
    category === "genuine" ? "genuine" : category === "outreach" ? "outreach" : null;
  const needsReplyMarker =
    row.lastMessageDirection === "IN" && row.unreadCount > 0 && !row.archivedAt;

  const renamePill = row.personId
    ? row.personInferredName
      ? (
          <NameSuggestionPill
            personId={row.personId}
            inferredName={row.personInferredName}
            currentName={row.personName}
            onChanged={() => onPersonChanged?.()}
          />
        )
      : row.platform === "IMESSAGE"
        ? (
            <NameSuggestionPill
              personId={row.personId}
              inferredName={null}
              currentName={row.personName}
              onChanged={() => onPersonChanged?.()}
            />
          )
        : null
    : null;

  const inner = (
    <>
      {selectMode ? (
        <span
          aria-hidden
          className={`grid h-8 w-8 place-items-center rounded-full border ${selected ? "border-accent bg-accent text-white" : "border-hairline-strong bg-paper text-ink-3"}`}
        >
          {selected ? (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 8.5l3 3 7-7" />
            </svg>
          ) : null}
        </span>
      ) : (
        <PersonAvatar
          name={row.personName}
          avatarUrl={row.personAvatarUrl}
          size={32}
          className="text-[12px]"
        />
      )}
      <span className="min-w-0">
        <span className="mb-1 flex items-baseline gap-[10px]">
          <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">{row.personName}</span>
          <span className="rounded bg-paper-2 px-[6px] py-[1px] text-[10px] font-medium uppercase tracking-[0.04em] text-ink-2">
            {PLATFORM_LABEL[row.platform]}
          </span>
          {renamePill}
          {categoryLabel ? (
            <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
              · {categoryLabel}
            </span>
          ) : null}
          {needsReplyMarker ? (
            <span className="font-mono text-[11px] tracking-[0.02em] text-risk-overdue">
              · needs reply
            </span>
          ) : null}
          {row.personThreadCount && row.personThreadCount > 1 ? (
            <span
              className="font-mono text-[11px] tracking-[0.02em] text-ink-3"
              title="Same contact has multiple separate conversations visible"
            >
              · {row.personThreadCount} threads
            </span>
          ) : null}
        </span>
        <span className="block max-w-[52ch] truncate text-[14px] text-ink-2">{bodyText}</span>
      </span>
      <span className={`text-[12px] tracking-[-0.005em] ${riskTextClass[risk]}`}>
        {rightLabel}
      </span>
    </>
  );

  const className = `group grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] transition-colors duration-calm last:border-b last:border-hairline ${selected ? "bg-paper-2" : "hover:bg-paper-2"}`;

  if (selectMode) {
    // role=button div instead of <button> so the NameSuggestionPill's
    // own <button> can render inside without producing invalid nested
    // <button> elements (and the React hydration error that goes with
    // them). Keyboard activation (Enter / Space) is wired manually so
    // the row stays accessible.
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        className={`${className} cursor-pointer text-left`}
        onClick={(event) => onToggle(row.id, { shiftKey: event.shiftKey })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(row.id, { shiftKey: event.shiftKey });
          }
        }}
      >
        {inner}
      </div>
    );
  }

  return (
    <Link
      href={`/thread/${row.id}`}
      className={className}
      onMouseEnter={() => prefetchThreadData(row.id)}
      onMouseLeave={cancelThreadPrefetch}
      onFocus={() => prefetchThreadData(row.id)}
      onClick={(event) => {
        // Cmd/Ctrl-click enters select mode without losing the inbox.
        // (Shift-click is reserved by the browser for "open in new
        //  window" on links and can't be reliably intercepted.)
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          onToggle(row.id, { shiftKey: event.shiftKey });
        }
      }}
    >
      {inner}
    </Link>
  );
}
