"use client";

import Link from "next/link";
import type { InboxRow } from "@/lib/types";
import { PLATFORM_LABEL, toDisplayRisk, type DisplayRisk } from "@/lib/risk";
import { formatRelative } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";
import { PersonAvatar } from "@/components/common/person-avatar";
import { NameSuggestionPill } from "@/components/common/name-suggestion-pill";
import { birthdayCountdownLabel, daysUntilBirthday } from "@inbox-os/core/birthday";

interface ThreadRowProps {
  row: InboxRow;
  /** Optional - when provided, called after a name suggestion is confirmed/edited/dismissed so the parent can refresh the inbox. */
  onPersonChanged?: () => void;
  /** Optional DOM id applied to the row, so a parent can scroll it into view. */
  id?: string;
}

const riskTextClass: Record<DisplayRisk, string> = {
  overdue: "text-risk-overdue font-medium",
  waiting: "text-risk-waiting font-medium",
  fresh: "text-ink-2"
};

export function ThreadRow({ row, onPersonChanged, id }: ThreadRowProps) {
  const risk = toDisplayRisk(row.riskLevel);
  const cleanPreview = normalizePreview(row.preview);
  const previewBody =
    row.lastMessageDirection === "OUT" ? `You: ${cleanPreview}` : cleanPreview;
  // On threads still awaiting a reply, lead with the AI context line - it
  // says *why* the conversation needs the operator, not just the last
  // words. Replied/handled threads keep the literal preview so the
  // "You: …" sent-marker stays visible.
  const nudge = row.whatTheyWant?.trim();
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
  // "needs reply" is more conservative than the `needsReply` flag on the
  // row: only inbound, only when there's something unread, and only on
  // threads the operator hasn't archived. Surfaced as a quiet inline
  // marker so the operator can spot it while scanning the list.
  const needsReplyMarker =
    row.lastMessageDirection === "IN" && row.unreadCount > 0 && !row.archivedAt;
  // Quiet "birthday soon" marker, from the contact's macOS Contacts card.
  // Capped at a week so the row stays a reply-triage surface, not a
  // calendar; the Today page carries the fuller upcoming-birthdays list.
  const birthdayDays = daysUntilBirthday(row.personBirthday);
  const birthdayMarker =
    birthdayDays !== null && birthdayDays <= 7 ? birthdayCountdownLabel(birthdayDays) : null;

  return (
    <Link
      id={id}
      href={`/thread/${row.id}`}
      data-demo-target={row.platformThreadId ? `thread-row-${row.platformThreadId}` : undefined}
      className="group grid grid-cols-[32px_1fr_auto] items-center gap-4 border-t border-hairline px-1 py-[18px] transition-colors duration-calm last:border-b last:border-hairline hover:bg-paper-2"
    >
      <PersonAvatar
        name={row.personName}
        avatarUrl={row.personAvatarUrl}
        size={32}
        className="text-[12px]"
      />
      <span className="min-w-0">
        <span className="mb-1 flex items-baseline gap-[10px]">
          <span className="text-[15px] font-medium tracking-[-0.01em] text-ink">{row.personName}</span>
          <span className="rounded bg-paper-2 px-[6px] py-[1px] text-[10px] font-medium uppercase tracking-[0.04em] text-ink-2">
            {PLATFORM_LABEL[row.platform]}
          </span>
          {row.personInferredName && row.personId ? (
            <NameSuggestionPill
              personId={row.personId}
              inferredName={row.personInferredName}
              currentName={row.personName}
              onChanged={() => onPersonChanged?.()}
            />
          ) : row.platform === "IMESSAGE" && row.personId ? (
            <NameSuggestionPill
              personId={row.personId}
              inferredName={null}
              currentName={row.personName}
              onChanged={() => onPersonChanged?.()}
            />
          ) : null}
          {/* Metadata tags are space-separated (no glyph) — the row-top
              flex gap provides the spacing. */}
          {categoryLabel ? (
            <span className="font-mono text-[11px] tracking-[0.02em] text-ink-3">
              {categoryLabel}
            </span>
          ) : null}
          {needsReplyMarker ? (
            <span className="font-mono text-[11px] tracking-[0.02em] text-risk-overdue">
              needs reply
            </span>
          ) : null}
          {birthdayMarker ? (
            <span
              className={`font-mono text-[11px] tracking-[0.02em] ${
                birthdayDays === 0 ? "text-accent-ink" : "text-ink-3"
              }`}
            >
              birthday {birthdayMarker}
            </span>
          ) : null}
          {row.personThreadCount && row.personThreadCount > 1 ? (
            <span
              className="font-mono text-[11px] tracking-[0.02em] text-ink-3"
              title="Same contact has multiple separate conversations visible"
            >
              {row.personThreadCount} threads
            </span>
          ) : null}
        </span>
        <span className="block max-w-[52ch] truncate text-[14px] text-ink-2">{bodyText}</span>
      </span>
      <span className={`text-[12px] tracking-[-0.005em] ${riskTextClass[risk]}`}>
        {rightLabel}
      </span>
    </Link>
  );
}
