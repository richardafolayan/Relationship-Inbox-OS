// Focus Reply Buffer — pure helpers shared by every focus surface (Today
// banner, Inbox group, Thread strip, Setup + Review sheets, Settings).
//
// Everything here is framework-free and side-effect-free so it can be unit
// tested directly in node (see tests/dashboard-focus-helpers.test.mjs). The
// React hook, the operator-profile writes and the acknowledgement send live
// in lib/use-focus-window.ts — none of that belongs in this file.
//
// The feature is deliberately conservative (PM call): one-tap only, never
// auto-send, never AI-written text. The app only decides whether a contact
// is COVERED and which note TIER fits, then fills [Name] / [until] / [reason]
// into the operator's own template. The words stay the operator's.

import type {
  AckTemplates,
  FocusAudience,
  FocusSettings,
  FocusTier,
  FocusWindowState,
  InboxRow,
  OperatorProfile
} from "@/lib/types";

// The operator's two default notes, in plain ASCII (no em/en dashes — the
// release no-ui-dashes gate). Kept in step with the runner-side defaults in
// apps/runner/src/services/settings.ts.
export const DEFAULT_ACK_TEMPLATES: AckTemplates = {
  close:
    "Yo [Name], I'm locked in till [until] but I've seen this, I'll reply properly after, call me if it's urgent.",
  professional:
    "Hey [Name], I'm in a focused work block till [until] but I've seen this, I'll come back to it properly after."
};

export const DEFAULT_FOCUS_SETTINGS: FocusSettings = {
  reasonLabel: true,
  oneNotePerPerson: true,
  audience: "favourites"
};

export const EMPTY_FOCUS_WINDOW: FocusWindowState = {
  active: false,
  startedAt: "",
  endsAt: "",
  reason: "",
  note: "",
  audience: "favourites",
  windowId: "",
  ackedPersonIds: []
};

// Reason chips offered in the setup sheet. Optional — the operator can also
// run a window with no reason at all.
export const FOCUS_REASONS = ["deep work", "lecture", "gym", "church", "driving", "family time"];
export const DEFAULT_FOCUS_REASON = "deep work";

// The minimal shape the eligibility helpers read. InboxRow satisfies it
// structurally; the thread strip builds one from a ThreadResponse + its
// messages. Keeping the surface small means the helpers don't care which
// view produced the row.
export interface FocusRow {
  personId?: string;
  personName: string;
  personFavourite?: boolean;
  personBirthday?: string | null;
  platform: InboxRow["platform"];
  /** Phase-3 categorisation; "outreach" marks cold/business threads. */
  category?: string | null;
  needsReply?: boolean;
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
}

// ─────────────────────────── profile readers ───────────────────────────
// A profile from a runner build that predates the feature omits these
// fields; fall back to the calm defaults rather than crashing a surface.

export function readFocusWindow(profile: OperatorProfile | null | undefined): FocusWindowState {
  return profile?.focusWindow ?? EMPTY_FOCUS_WINDOW;
}

export function readAckTemplates(profile: OperatorProfile | null | undefined): AckTemplates {
  const t = profile?.ackTemplates;
  return {
    close: t?.close?.trim() ? t.close : DEFAULT_ACK_TEMPLATES.close,
    professional: t?.professional?.trim() ? t.professional : DEFAULT_ACK_TEMPLATES.professional
  };
}

export function readFocusSettings(profile: OperatorProfile | null | undefined): FocusSettings {
  return profile?.focusSettings ?? DEFAULT_FOCUS_SETTINGS;
}

export function isFocusActive(window: FocusWindowState | null | undefined): boolean {
  return !!window?.active;
}

// ─────────────────────────── formatting ───────────────────────────

/** "2026-06-07T17:30:00Z" -> "5:30pm". "" / invalid -> "". */
export function formatUntil(endsAt: string | null | undefined): string {
  if (!endsAt) return "";
  const d = new Date(endsAt);
  if (Number.isNaN(d.getTime())) return "";
  let hour = d.getHours();
  const minute = d.getMinutes();
  const meridiem = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  return `${hour}:${String(minute).padStart(2, "0")}${meridiem}`;
}

/** Build an end-time ISO from a "HH:MM" picker value; rolls to tomorrow if
 *  the time has already passed today so "until 6am" reads correctly at night. */
export function endsAtIsoFromTime(time: string, now: Date = new Date()): string {
  const parts = (time ?? "").split(":");
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return "";
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/** True when the display name is only a phone number or email (an unsaved
 *  iMessage handle) rather than a real saved contact name. */
export function looksLikePhoneOrEmail(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return true;
  if (trimmed.includes("@")) return true;
  const digits = (trimmed.match(/\d/g) ?? []).length;
  const phoneShaped = /^[+()\d\s.\-]+$/.test(trimmed);
  return phoneShaped && digits >= 5;
}

/** First name for the [Name] token. Falls back to "there" for empty/handle
 *  names (those are never covered, so this only guards the substitution). */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed || looksLikePhoneOrEmail(trimmed)) return trimmed || "there";
  return trimmed.split(/\s+/)[0] || trimmed;
}

/** Substitute the only three tokens the feature ever fills. No AI, no other
 *  rewriting — the rest of the note is the operator's verbatim words. */
export function fillNote(
  template: string,
  vars: { name: string; until: string; reason: string }
): string {
  return template
    .replace(/\[Name\]/g, vars.name || "there")
    .replace(/\[until\]/g, vars.until || "later")
    .replace(/\[reason\]/g, vars.reason || "");
}

// ─────────────────────────── eligibility ───────────────────────────

/** Which note tier fits a contact. LinkedIn (or other professional-leaning
 *  platforms) read professional; iMessage and the rest read close. The
 *  review sheet is the real safety net, so this stays deliberately simple. */
export function tierForRow(row: FocusRow): FocusTier {
  if (row.platform === "LINKEDIN") return "professional";
  if (row.category === "outreach") return "professional";
  return "close";
}

/**
 * Is this contact covered by the window, and at which tier? Conservative by
 * design (PM call):
 *   - favourites are always covered (the safe default audience)
 *   - "all personal" widens ONLY to saved personal iMessage contacts (a real
 *     name, or a synced birthday), never to LinkedIn/Instagram/TikTok unless
 *     favourited, and never to unknown numbers, spam, or outreach/business.
 */
export function coverageForRow(
  row: FocusRow,
  audience: FocusAudience
): { covered: boolean; tier: FocusTier } {
  const tier = tierForRow(row);
  // Outreach / business threads are never acknowledged, in any audience.
  if (row.category === "outreach") return { covered: false, tier };
  if (row.personFavourite) return { covered: true, tier };
  if (audience === "all_personal" && row.platform === "IMESSAGE") {
    const realName = !looksLikePhoneOrEmail(row.personName);
    const hasBirthday = !!row.personBirthday;
    if (realName || hasBirthday) return { covered: true, tier: "close" };
  }
  return { covered: false, tier };
}

/** A new inbound landed on this thread since the window opened. */
export function arrivedDuringFocus(
  row: FocusRow,
  window: FocusWindowState,
  now: Date = new Date()
): boolean {
  if (!isFocusActive(window) || !window.startedAt) return false;
  if (!row.lastInboundAt) return false;
  const started = Date.parse(window.startedAt);
  const inbound = Date.parse(row.lastInboundAt);
  if (!Number.isFinite(started) || !Number.isFinite(inbound)) return false;
  // Guard against a clock that hasn't reached the start yet.
  void now;
  return inbound >= started;
}

/** The operator has already replied to this contact today, so they've heard
 *  from you and there's nothing to reassure. */
export function hasRepliedToday(row: FocusRow, now: Date = new Date()): boolean {
  if (!row.lastOutboundAt) return false;
  const d = new Date(row.lastOutboundAt);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === now.toDateString();
}

/** This person already got their one note this window. */
export function isAcked(row: FocusRow, window: FocusWindowState): boolean {
  return !!row.personId && window.ackedPersonIds.includes(row.personId);
}

/**
 * The single source of truth for "should this thread offer a one-tap
 * acknowledgement right now". Every surface (Today count, Inbox group,
 * Thread strip, Review sheet) funnels through this so they never disagree.
 */
export function isFocusAckCandidate(
  row: FocusRow,
  window: FocusWindowState,
  settings: FocusSettings,
  opts: { now?: Date; quietHoursActive?: boolean } = {}
): boolean {
  // Respect quiet hours: the app stays silent then, so no notes are offered.
  if (opts.quietHoursActive) return false;
  if (!isFocusActive(window)) return false;
  if (!arrivedDuringFocus(row, window, opts.now)) return false;
  // Only unanswered inbound threads. needsReply === false means handled.
  if (row.needsReply === false) return false;
  if (!coverageForRow(row, window.audience).covered) return false;
  if (hasRepliedToday(row, opts.now)) return false;
  if (settings.oneNotePerPerson && isAcked(row, window)) return false;
  return true;
}

/** The acknowledgement note for a specific contact, tier-matched and tokens
 *  filled. Pure: the caller owns sending it (and only on an explicit tap). */
export function noteForRow(
  row: FocusRow,
  window: FocusWindowState,
  templates: AckTemplates
): string {
  const { tier } = coverageForRow(row, window.audience);
  const base = templates[tier] || DEFAULT_ACK_TEMPLATES[tier];
  return fillNote(base, {
    name: firstNameOf(row.personName),
    until: formatUntil(window.endsAt),
    reason: window.reason
  });
}
