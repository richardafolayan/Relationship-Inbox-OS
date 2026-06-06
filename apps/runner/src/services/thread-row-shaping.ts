import { calculateRisk, formatSlaCountdown, type PlatformName } from "@inbox-os/core";
import {
  isTemporaryLinkedInId,
  normalizeCanonicalLinkedInThreadId
} from "../linkedin/linkedinIdentity.js";
import { isMoreCanonical } from "./canonical-thread.js";

export type IdentityWarning = "unresolved_id";

export interface ThreadRowSource {
  id: string;
  platform: PlatformName;
  platformThreadId: string;
  threadUrl: string | null;
  personId: string;
  unreadCount: number;
  needsReply: boolean;
  lastMessagePreview: string | null;
  lastMessageAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  // Direction + text of the most-recent message regardless of sender. Used
  // to render "You: …" prefixes on outbound previews and the green/red
  // replied-vs-needs-reply indicator. Both nullable for older rows that
  // pre-date the Phase 2 schema additions.
  lastMessageDirection: "IN" | "OUT" | null;
  lastMessageText: string | null;
  riskLevel: "GREEN" | "AMBER" | "RED";
  riskReason: string | null;
  slaDueAt: Date | null;
  snoozedUntil: Date | null;
  whatTheyWant: string | null;
  rollingSummary: string | null;
  archivedAt: Date | null;
  category: string | null;
  /** "closed" | "open" | null - see Thread.closedStatus. The dashboard
   *  treats "closed" as a strong "set aside" signal even when the
   *  lightweight heuristic does not flag it. */
  closedStatus: string | null;
  /** One-line caption explaining the closed/open verdict. */
  closedStatusReason: string | null;
  /** AI reconnect-worthy score, 0-100. See Thread.reconnectScore. */
  reconnectScore: number | null;
  /** Short reason string the dashboard renders as a quiet "why" caption
   *  alongside top-ranked reconnect candidates. */
  reconnectScoreReason: string | null;
  updatedAt: Date;
  person: {
    id: string;
    displayName: string;
    inferredName: string | null;
    platform: PlatformName;
    avatarUrl: string | null;
    // Birthday synced from the operator's macOS Contacts: "MM-DD" plus an
    // optional four-digit year. Both null when no contact matched.
    birthday: string | null;
    birthYear: number | null;
    // Operator-pinned favourite (R-0066 / #483). Non-null timestamp = the
    // operator marked this contact a favourite, so their threads float to the
    // top of the Inbox section / Today bucket they already sit in. Null when
    // not favourited.
    favouritedAt: Date | null;
  };
  _count?: {
    messages: number;
  };
}

export interface ShapedThreadRow {
  id: string;
  /**
   * Platform-side stable id of the thread (e.g. iMessage chat guid).
   * Surfaced so the dashboard can target showcase demo threads by
   * their deterministic platformThreadId from data-demo-target attrs.
   */
  platformThreadId: string;
  personId: string;
  personName: string;
  /**
   * Heuristic name guess for personas with phone/email displayNames
   * (iMessage). The dashboard shows "Maybe …" with confirm/edit/dismiss
   * actions. Null when the displayName is already a real name (LinkedIn)
   * or when no inference matched.
   */
  personInferredName: string | null;
  personAvatarUrl: string | null;
  /**
   * Birthday for this row's contact, synced from macOS Contacts: a "MM-DD"
   * string plus an optional four-digit year. Both null when no contact
   * matched. The dashboard derives the "birthday soon" badge from these.
   */
  personBirthday: string | null;
  personBirthYear: number | null;
  /**
   * True when the operator has marked this contact a favourite (R-0066 /
   * #483). The dashboard floats favourited rows to the top of the Inbox
   * section and Today bucket they already belong to (without reordering
   * across risk levels) and can filter the Inbox to favourites only.
   */
  personFavourite: boolean;
  platform: PlatformName;
  preview: string;
  /**
   * "IN" when the latest message is from the other party, "OUT" when from
   * the operator. Drives the dashboard's "You: …" preview prefix and the
   * red/green replied-vs-needs-reply row indicator.
   */
  lastMessageDirection: "IN" | "OUT" | null;
  unreadCount: number;
  riskLevel: "GREEN" | "AMBER" | "RED";
  needsReply: boolean;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  riskReason?: string | null;
  slaCountdown: string;
  identityWarning?: IdentityWarning | null;
  messageCount: number;
  category: string | null;
  /**
   * AI-extracted one-line context, what would make a great reply or
   * what the contact is waiting on. Surfaced on Today + inbox rows as a
   * proactive nudge and used as the body of new-message notifications.
   * Null until the thread has been summarised.
   */
  whatTheyWant: string | null;
  /**
   * AI verdict on whether the conversation has wrapped up (#287 phase
   * 2.5). "closed" = last inbound is a natural endpoint and no reply
   * is owed; "open" = operator still owes a reply; null = unclassified
   * (provider unavailable on the relevant scan, or no inbound yet).
   * The dashboard treats "closed" as a strong "set aside" signal.
   */
  closedStatus: "closed" | "open" | null;
  /**
   * One-line caption explaining the closed / open verdict. Rendered as
   * a quiet "why" caption on the inbox row when the operator unhides
   * set-aside threads via Show all. Null when the row was classified
   * before reasons were introduced (will refill on next scan).
   */
  closedStatusReason: string | null;
  /**
   * Reconnect-worthy score (#287 phase 3.5). 0-100 integer indicating
   * how much it makes sense to send a deliberate "hey, been a while"
   * message to this LinkedIn dormant. Null when not yet scored or the
   * AI provider was unavailable; the dashboard falls back to its
   * deterministic relationship-signal ranking in that case.
   */
  reconnectScore: number | null;
  /** Short reason for the AI score; rendered as a quiet "why" caption. */
  reconnectScoreReason: string | null;
  archivedAt: string | null;
  snoozedUntil: string | null;
  /**
   * How many surviving inbox rows belong to the same person+platform.
   * 1 for the normal case; >1 when a contact has multiple distinct
   * conversations visible (typically LinkedIn recruiters pitching
   * different candidates in separate 1:1 threads). The dashboard
   * surfaces a "N threads" badge so the operator doesn't read repeat
   * names as accidental duplicates (issue #201).
   */
  personThreadCount: number;
}

// Display fields describe the LATEST message in either direction. They are
// folded SEPARATELY from the canonical (AI-field) sibling pick: an iMessage
// person's collapsed row reads id + AI fields from the most-recent-INBOUND
// sibling, but its preview / lastMessageAt / direction must come from
// whichever sibling owns the most-recent MESSAGE (often a newer outbound the
// operator sent from the other handle). See pickNewerDisplay + PM17.
export interface DisplayFields {
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageText: string | null;
  lastMessageDirection: "IN" | "OUT" | null;
}

function displayFieldsFor(row: ThreadRowSource): DisplayFields {
  return {
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageText: row.lastMessageText,
    lastMessageDirection: row.lastMessageDirection
  };
}

// Of two siblings' display bundles, keep the one whose latest message is
// newer (null lastMessageAt = epoch 0, matching the inbox sort + canonical
// tie-handling). Ties keep the incumbent so the fold is deterministic. The
// preview/text/direction always travel together with the lastMessageAt they
// belong to, so the preview never describes a different message than the
// timestamp.
function pickNewerDisplay(current: DisplayFields, next: DisplayFields): DisplayFields {
  const currentTime = current.lastMessageAt?.getTime() ?? 0;
  const nextTime = next.lastMessageAt?.getTime() ?? 0;
  return nextTime > currentTime ? next : current;
}

export interface ShapedThreadGroupRow {
  source: ThreadRowSource;
  dedupeKey: string;
  messageCount: number;
  needsReply: boolean;
  identityWarning: IdentityWarning | null;
  // Display fields (preview / lastMessageAt / direction) folded across the
  // person's siblings: the newest-MESSAGE sibling wins, independent of which
  // sibling is canonical for AI fields. For non-collapsed rows this equals
  // the source's own display fields.
  display: DisplayFields;
}

function resolveLinkedInCanonicalId(row: ThreadRowSource): string | null {
  const canonical = normalizeCanonicalLinkedInThreadId({
    platformThreadId: row.platformThreadId,
    threadUrl: row.threadUrl ?? undefined
  });
  if (!canonical || isTemporaryLinkedInId(canonical)) {
    return null;
  }
  return canonical;
}

function identityWarningForRow(row: ThreadRowSource): IdentityWarning | null {
  if (row.platform !== "LINKEDIN") {
    return null;
  }
  return resolveLinkedInCanonicalId(row) ? null : "unresolved_id";
}

function messageCountForRow(row: ThreadRowSource): number {
  return row._count?.messages ?? 0;
}

function shouldPreferSourceRow(current: ThreadRowSource, next: ThreadRowSource): boolean {
  const nextCount = messageCountForRow(next);
  const currentCount = messageCountForRow(current);
  if (nextCount !== currentCount) {
    return nextCount > currentCount;
  }
  const nextUpdated = next.updatedAt.getTime();
  const currentUpdated = current.updatedAt.getTime();
  if (nextUpdated !== currentUpdated) {
    return nextUpdated > currentUpdated;
  }
  const nextTime = next.lastMessageAt?.getTime() ?? 0;
  const currentTime = current.lastMessageAt?.getTime() ?? 0;
  if (nextTime !== currentTime) {
    return nextTime > currentTime;
  }
  return next.id > current.id;
}

function deriveNeedsReply(row: ThreadRowSource): boolean {
  if (row.lastInboundAt) {
    return !row.lastOutboundAt || row.lastInboundAt.getTime() > row.lastOutboundAt.getTime();
  }
  // No inbound = nothing is owed. Mirror calculateRisk, which returns
  // needsReply:false / GREEN / no SLA when lastInboundAt is null (risk.ts).
  // Trusting the stored row.needsReply column here (it can be true from an AI
  // summary or a seeded thread) produced a self-contradictory row: flagged
  // needs-reply, yet GREEN with "No SLA", surviving the needsReplyOnly inbox
  // filter while never aging to amber/red.
  return false;
}

function imessagePersonKey(row: Pick<ThreadRowSource, "platform" | "personId">): string {
  return `person:${row.platform}:${row.personId}`;
}

// Return the visible representative row with the AI-analysis fields the thread
// endpoint sources from the CANONICAL sibling (see canonical-thread.ts)
// overlaid, so the inbox row's preview + whatTheyWant match what the rail shows
// once the thread is opened. Identity, visibility (archivedAt / snoozedUntil),
// timestamps and risk deliberately STAY on the visible representative — exactly
// the split #499 made on the thread endpoint, and required because the
// dashboard filters/styles rows on archivedAt / snoozedUntil (swapping those in
// from an archived canonical would mis-hide or mis-bucket an otherwise-active
// row). The preview trio (lastMessageText / lastMessagePreview /
// lastMessageDirection) moves together so the rendered "You: …" prefix can
// never describe a different message than the previewed text.
function adoptCanonicalAiFields(
  visible: ThreadRowSource,
  canonical: ThreadRowSource
): ThreadRowSource {
  if (canonical.id === visible.id) {
    return visible;
  }
  return {
    ...visible,
    whatTheyWant: canonical.whatTheyWant,
    rollingSummary: canonical.rollingSummary,
    category: canonical.category,
    closedStatus: canonical.closedStatus,
    closedStatusReason: canonical.closedStatusReason,
    reconnectScore: canonical.reconnectScore,
    reconnectScoreReason: canonical.reconnectScoreReason,
    lastMessageText: canonical.lastMessageText,
    lastMessagePreview: canonical.lastMessagePreview,
    lastMessageDirection: canonical.lastMessageDirection
  };
}

// Reduce the FULL (visibility-unfiltered) iMessage sibling set to the
// canonical row per person, using the SAME ordering pickCanonicalThread runs
// on the thread endpoint. This is what lets the inbox pick canonical over the
// same population the rail does — without it, the loader's active-only filter
// can hand shapeThreadRows a different sibling set and the two sites diverge.
function canonicalByImessagePerson(siblings: ThreadRowSource[]): Map<string, ThreadRowSource> {
  const byPerson = new Map<string, ThreadRowSource>();
  for (const row of siblings) {
    if (row.platform !== "IMESSAGE") {
      continue;
    }
    const key = imessagePersonKey(row);
    const current = byPerson.get(key);
    const next = { id: row.id, lastInboundAt: row.lastInboundAt, messageCount: messageCountForRow(row) };
    if (
      !current ||
      isMoreCanonical(next, {
        id: current.id,
        lastInboundAt: current.lastInboundAt,
        messageCount: messageCountForRow(current)
      })
    ) {
      byPerson.set(key, row);
    }
  }
  return byPerson;
}

// Newest DISPLAY bundle per iMessage person across ALL siblings (incl.
// archived/snoozed ones absent from the visible `rows`). Folded into the
// collapsed row so its preview/lastMessageAt reflect the newest message in the
// merged thread view, even when that message lives on a non-visible sibling.
function newestDisplayByImessagePerson(siblings: ThreadRowSource[]): Map<string, DisplayFields> {
  const byPerson = new Map<string, DisplayFields>();
  for (const row of siblings) {
    if (row.platform !== "IMESSAGE") {
      continue;
    }
    const key = imessagePersonKey(row);
    const current = byPerson.get(key);
    const next = displayFieldsFor(row);
    byPerson.set(key, current ? pickNewerDisplay(current, next) : next);
  }
  return byPerson;
}

export function shapeThreadRows(
  rows: ThreadRowSource[],
  // The full, visibility-UNFILTERED iMessage sibling set for the persons being
  // shaped. When supplied, an iMessage person-group adopts its canonical
  // sibling's AI fields (see adoptCanonicalAiFields) so the row matches the
  // thread endpoint even when the live sibling is archived/snoozed and absent
  // from `rows`. Omitted (or empty) reproduces the legacy in-set behaviour, so
  // non-iMessage and pure-unit callers are unchanged.
  canonicalSiblings?: ThreadRowSource[]
): ShapedThreadGroupRow[] {
  const byThreadId = new Map<string, ThreadRowSource>();
  for (const row of rows) {
    const existing = byThreadId.get(row.id);
    if (!existing || shouldPreferSourceRow(existing, row)) {
      byThreadId.set(row.id, row);
    }
  }

  const deduped = new Map<string, ShapedThreadGroupRow>();

  for (const row of byThreadId.values()) {
    const messageCount = messageCountForRow(row);
    const identityWarning = identityWarningForRow(row);
    const unresolvedZeroMessageLinkedIn =
      row.platform === "LINKEDIN" && identityWarning === "unresolved_id" && messageCount <= 0;

    if (unresolvedZeroMessageLinkedIn) {
      continue;
    }

    // For iMessage we collapse threads-per-person so the same human with
    // a phone + email handle (two chat.db chats, one Person) shows as a
    // single row. The thread page merges messages from sibling threads
    // when rendering. LinkedIn keeps thread-level dedupe because separate
    // LinkedIn threads with the same person are intentional.
    const dedupeKey =
      row.platform === "IMESSAGE"
        ? imessagePersonKey(row)
        : `thread:${row.id}`;
    const candidate: ShapedThreadGroupRow = {
      source: row,
      dedupeKey,
      messageCount,
      needsReply: deriveNeedsReply(row),
      identityWarning,
      display: displayFieldsFor(row)
    };

    const existing = deduped.get(dedupeKey);
    if (!existing) {
      deduped.set(dedupeKey, candidate);
    } else {
      // Canonical pick (id + AI fields) and display fold are independent:
      // keep the more-canonical source, but always fold display across BOTH
      // siblings so a newer message on the losing sibling still surfaces.
      const winner = prefersCandidate(existing, candidate) ? candidate : existing;
      deduped.set(dedupeKey, {
        ...winner,
        display: pickNewerDisplay(existing.display, candidate.display)
      });
    }
  }

  // Final pass: align each surviving iMessage person-group's AI fields with the
  // canonical sibling computed over ALL siblings (not just the visible subset
  // `deduped` was built from). Keeps the visible row as the representative for
  // identity/visibility/link-target; only the AI-analysis fields move.
  if (canonicalSiblings && canonicalSiblings.length > 0) {
    const canonicalByPerson = canonicalByImessagePerson(canonicalSiblings);
    const newestDisplayByPerson = newestDisplayByImessagePerson(canonicalSiblings);
    for (const group of deduped.values()) {
      if (group.source.platform !== "IMESSAGE") {
        continue;
      }
      const canonical = canonicalByPerson.get(group.dedupeKey);
      if (canonical) {
        group.source = adoptCanonicalAiFields(group.source, canonical);
      }
      // Fold display across ALL siblings (not just the visible subset), so a
      // newer message on an archived/snoozed sibling still drives the row's
      // preview/lastMessageAt — matching the merged thread view.
      const newestDisplay = newestDisplayByPerson.get(group.dedupeKey);
      if (newestDisplay) {
        group.display = pickNewerDisplay(group.display, newestDisplay);
      }
    }
  }

  return Array.from(deduped.values());
}

function prefersCandidate(current: ShapedThreadGroupRow, next: ShapedThreadGroupRow): boolean {
  // Pick the representative sibling thread for an iMessage person from the rows
  // shapeThreadRows was handed: the one still receiving inbound (most recent
  // lastInboundAt), tie-broken by message count then id. This decides the link
  // target / identity row. The AI-analysis fields are then re-aligned to the
  // canonical sibling computed over ALL siblings in the final pass above (see
  // canonicalByImessagePerson + adoptCanonicalAiFields), because the loader can
  // hand this only the active subset — so the representative chosen here may not
  // be the live sibling when that live sibling is archived/snoozed. Shares
  // isMoreCanonical with canonical-thread.ts so the rule can't drift between
  // selection sites.
  return isMoreCanonical(
    { id: next.source.id, lastInboundAt: next.source.lastInboundAt, messageCount: next.messageCount },
    { id: current.source.id, lastInboundAt: current.source.lastInboundAt, messageCount: current.messageCount }
  );
}

export interface RiskThresholds {
  amberHours: number;
  redHours: number;
}

export function toInboxRow(
  row: ShapedThreadGroupRow,
  personThreadCount: number,
  thresholds: RiskThresholds
): ShapedThreadRow {
  const source = row.source;
  // Risk is purely time-dependent (it ages amber -> red as the clock advances),
  // so recompute it at request time from the timestamps + current thresholds
  // rather than trusting the level frozen at the last scan/send. Otherwise a
  // thread keeps showing a stale risk level until a rescan rewrites it, which
  // is unbounded when scans are paused (cooldown, idle/disabled platform,
  // demo mode) — the Today/inbox views would then misstate urgency.
  const risk = calculateRisk({
    lastInboundAt: source.lastInboundAt,
    lastOutboundAt: source.lastOutboundAt,
    amberHours: thresholds.amberHours,
    redHours: thresholds.redHours
  });
  // Prefer the latest-message text (which respects direction) over the
  // legacy lastMessagePreview field (which only tracks inbound). Falls
  // through to AI-summary fields when neither is set, then a constant.
  // Read the message fields from the folded display bundle (the newest-
  // message sibling) rather than source, which is the canonical (newest-
  // INBOUND) sibling and can be older — see PM17. whatTheyWant /
  // rollingSummary stay on source because they are AI fields.
  const display = row.display;
  const previewText =
    display.lastMessageText ??
    display.lastMessagePreview ??
    source.whatTheyWant ??
    source.rollingSummary ??
    "No summary yet";
  return {
    id: source.id,
    platformThreadId: source.platformThreadId,
    personId: source.personId,
    personName: source.person.displayName,
    personInferredName: source.person.inferredName ?? null,
    personAvatarUrl: source.person.avatarUrl ?? null,
    personBirthday: source.person.birthday ?? null,
    personBirthYear: source.person.birthYear ?? null,
    personFavourite: source.person.favouritedAt != null,
    platform: source.platform,
    preview: previewText,
    lastMessageDirection: display.lastMessageDirection ?? null,
    unreadCount: source.unreadCount,
    riskLevel: risk.level,
    needsReply: row.needsReply,
    lastMessageAt: display.lastMessageAt?.toISOString() ?? null,
    lastInboundAt: source.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: source.lastOutboundAt?.toISOString() ?? null,
    riskReason: risk.riskReason,
    // slaDueAt is recomputed above from lastInboundAt + the current amber
    // threshold, so the countdown is live. Still suppress it when nothing is
    // owed (the operator has replied) so a no-longer-pending row doesn't read
    // "Overdue Xh" (issue #200).
    slaCountdown: row.needsReply ? formatSlaCountdown(risk.slaDueAt) : "",
    identityWarning: row.identityWarning,
    messageCount: row.messageCount,
    category: source.category ?? null,
    whatTheyWant: source.whatTheyWant ?? null,
    closedStatus: (source.closedStatus as "closed" | "open" | null) ?? null,
    closedStatusReason: source.closedStatusReason ?? null,
    reconnectScore: source.reconnectScore ?? null,
    reconnectScoreReason: source.reconnectScoreReason ?? null,
    archivedAt: source.archivedAt?.toISOString() ?? null,
    snoozedUntil: source.snoozedUntil?.toISOString() ?? null,
    personThreadCount
  };
}

// Count surviving rows per person+platform so the dashboard can flag
// rows where the same contact has multiple distinct conversations (issue
// #201). LinkedIn recruiters frequently start a separate 1:1 thread per
// candidate they pitch — these look like duplicate name rows but
// actually carry distinct content. Collapsing them would hide pitches
// the operator still needs to act on.
export function personThreadCounts(rows: ShapedThreadGroupRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.source.platform}:${row.source.personId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function personThreadCountKey(platform: PlatformName, personId: string): string {
  return `${platform}:${personId}`;
}
