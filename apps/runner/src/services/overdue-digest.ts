// Overdue-reply digest service (#360).
//
// One calm digest, never per-thread. Off by default. See packages/core/src/
// overdue-digest.ts for the shared types and pure helpers. This module is
// the runner-side glue: it persists settings + per-person memory in the
// existing Setting JSON store, selects candidates from real thread rows,
// and exposes a small surface the dashboard scheduler can call.
//
// Important invariants:
//   - `tick` is read-only. It NEVER updates lastDigestAt or per-person
//     memory. The dashboard must call `ack` after the browser notification
//     actually fires (which is gated on permission, tab visibility, quiet
//     hours, cadence). This keeps the dedupe memory honest.
//   - The runner has no view onto the operator's quiet hours / tab focus.
//     Those gates live in the dashboard scheduler. `isDigestDue` here is
//     only the cadence calendar check.

import { PrismaClient } from "@prisma/client";
import {
  DEFAULT_OVERDUE_DIGEST_SETTINGS,
  buildStateKey,
  isDigestDue,
  isNonActionableInboundPlaceholder,
  type OverdueDigestCadence,
  type OverdueDigestCandidate,
  type OverdueDigestRowInput,
  type OverdueDigestSettings,
  type OverdueDigestTickResult
} from "@inbox-os/core";

export const OVERDUE_DIGEST_SETTING_KEY = "overdue_digest_v1";

/**
 * Recency horizon for the digest. Mirrors the dashboard's
 * `INBOX_HORIZON_DAYS` so the digest's idea of "overdue" cannot drift from
 * what Today calls overdue (issue #360 amendment 2). 30 days matches
 * `apps/dashboard/lib/horizon.ts`; kept as a local constant rather than
 * pulled from packages/core to keep this extraction minimal.
 */
const DIGEST_HORIZON_DAYS = 30;
const DIGEST_HORIZON_MS = DIGEST_HORIZON_DAYS * 24 * 60 * 60 * 1000;

/** Hard cap on candidates returned to the preview surface in Settings. */
const PREVIEW_CANDIDATE_CAP = 8;

const VALID_CADENCES: OverdueDigestCadence[] = ["off", "daily", "weekly"];

export function isValidCadence(value: unknown): value is OverdueDigestCadence {
  return typeof value === "string" && (VALID_CADENCES as string[]).includes(value);
}

interface RawPerPerson {
  displayName?: unknown;
  lastIncludedAt?: unknown;
  lastIncludedStateKey?: unknown;
  snoozedUntil?: unknown;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseSettings(raw: unknown): OverdueDigestSettings {
  if (!raw || typeof raw !== "object") return cloneSettings(DEFAULT_OVERDUE_DIGEST_SETTINGS);
  const partial = raw as {
    cadence?: unknown;
    lastDigestAt?: unknown;
    lastDigestLocalDate?: unknown;
    dismissForLocalDate?: unknown;
    perPerson?: unknown;
  };
  const cadence = isValidCadence(partial.cadence) ? partial.cadence : "off";
  const perPersonRaw =
    partial.perPerson && typeof partial.perPerson === "object" ? (partial.perPerson as Record<string, RawPerPerson>) : {};
  const perPerson: OverdueDigestSettings["perPerson"] = {};
  for (const [personId, entry] of Object.entries(perPersonRaw)) {
    if (!entry || typeof entry !== "object") continue;
    perPerson[personId] = {
      displayName: asString(entry.displayName),
      lastIncludedAt: asNullableString(entry.lastIncludedAt),
      lastIncludedStateKey: asNullableString(entry.lastIncludedStateKey),
      snoozedUntil: asNullableString(entry.snoozedUntil)
    };
  }
  return {
    cadence,
    lastDigestAt: asNullableString(partial.lastDigestAt),
    lastDigestLocalDate: asNullableString(partial.lastDigestLocalDate),
    dismissForLocalDate: asNullableString(partial.dismissForLocalDate),
    perPerson
  };
}

export function cloneSettings(s: OverdueDigestSettings): OverdueDigestSettings {
  return {
    cadence: s.cadence,
    lastDigestAt: s.lastDigestAt,
    lastDigestLocalDate: s.lastDigestLocalDate,
    dismissForLocalDate: s.dismissForLocalDate,
    perPerson: Object.fromEntries(
      Object.entries(s.perPerson).map(([id, entry]) => [id, { ...entry }])
    )
  };
}

export interface OverdueDigestStore {
  get(): Promise<OverdueDigestSettings>;
  put(next: OverdueDigestSettings): Promise<OverdueDigestSettings>;
}

export function createOverdueDigestStore(prisma: PrismaClient): OverdueDigestStore {
  let cache: OverdueDigestSettings | null = null;

  return {
    async get() {
      if (cache) return cloneSettings(cache);
      const record = await prisma.setting.findUnique({ where: { key: OVERDUE_DIGEST_SETTING_KEY } });
      if (!record) {
        cache = cloneSettings(DEFAULT_OVERDUE_DIGEST_SETTINGS);
        return cloneSettings(cache);
      }
      try {
        cache = parseSettings(JSON.parse(record.valueJson));
      } catch {
        cache = cloneSettings(DEFAULT_OVERDUE_DIGEST_SETTINGS);
      }
      return cloneSettings(cache);
    },
    async put(next) {
      const sanitised = parseSettings(next);
      await prisma.setting.upsert({
        where: { key: OVERDUE_DIGEST_SETTING_KEY },
        update: { valueJson: JSON.stringify(sanitised) },
        create: { key: OVERDUE_DIGEST_SETTING_KEY, valueJson: JSON.stringify(sanitised) }
      });
      cache = cloneSettings(sanitised);
      return cloneSettings(cache);
    }
  };
}

// ---- Pure candidate selection -----------------------------------------------

/**
 * Filter and sort thread rows into digest candidates. Pure: takes all the
 * inputs it needs explicitly. The runner endpoint composes this with the
 * persisted settings and the current time; the unit tests exercise it
 * directly without standing up Prisma.
 *
 * Filters (#360 amendment 2 — same meaning as Today):
 *   - needsReply
 *   - riskLevel RED or AMBER (GREEN never overdue)
 *   - not archived (archivedAt == null)
 *   - not currently snoozed at the thread level (snoozedUntil <= now or null)
 *   - not scheduled to send
 *   - not "closed" per the AI verdict
 *   - lastMessageAt within the 30-day inbox horizon
 *   - latest visible text isn't a deleted/retracted placeholder (#360 amendment 3)
 *
 * Per-person filters (memory):
 *   - person snooze not active
 *   - not the same person+state as the immediately-previous sent digest
 *     (`lastIncludedAt === settings.lastDigestAt` AND
 *      `lastIncludedStateKey === currentStateKey`)
 *
 * Sort: RED before AMBER, then oldest lastInboundAt first. Stable on
 * personId.
 */
export function selectCandidates(input: {
  rows: OverdueDigestRowInput[];
  settings: OverdueDigestSettings;
  nowIso: string;
}): OverdueDigestCandidate[] {
  const { rows, settings, nowIso } = input;
  const now = Date.parse(nowIso);
  const candidates: OverdueDigestCandidate[] = [];

  for (const row of rows) {
    if (!row.needsReply) continue;
    if (row.riskLevel !== "RED" && row.riskLevel !== "AMBER") continue;
    if (row.archivedAt) continue;
    if (row.scheduledSendAt) continue;
    if (row.closedStatus === "closed") continue;

    if (row.snoozedUntil) {
      const snoozedUntilMs = Date.parse(row.snoozedUntil);
      if (!Number.isNaN(snoozedUntilMs) && snoozedUntilMs > now) continue;
    }

    if (row.lastMessageAt) {
      const lastMs = Date.parse(row.lastMessageAt);
      if (!Number.isNaN(lastMs) && now - lastMs > DIGEST_HORIZON_MS) continue;
    }

    // Deleted-placeholder rows: skip ONLY when the whole inbound side is
    // a placeholder and the AI has no real `whatTheyWant` either. Upstream
    // (#364) already keeps the placeholder out of `lastInboundAt` and the
    // needs-reply heuristic, so a thread reaching this point with a
    // placeholder preview still has a *real* prior inbound the operator
    // owes a reply to — we should NOT exclude it from the digest just
    // because the latest visible bubble was retracted. The combined check
    // here is a last-resort guard against rows where both signals are
    // empty/placeholder; expected to be rare post-#364.
    if (
      isNonActionableInboundPlaceholder(row.preview) &&
      isNonActionableInboundPlaceholder(row.whatTheyWant ?? "")
    ) {
      continue;
    }

    const memory = settings.perPerson[row.personId];
    if (memory?.snoozedUntil) {
      const snoozeMs = Date.parse(memory.snoozedUntil);
      if (!Number.isNaN(snoozeMs) && snoozeMs > now) continue;
    }

    const stateKey = buildStateKey(row);

    if (
      memory &&
      memory.lastIncludedAt &&
      settings.lastDigestAt &&
      memory.lastIncludedAt === settings.lastDigestAt &&
      memory.lastIncludedStateKey === stateKey
    ) {
      // Person appeared in the immediately-previous sent digest with the
      // same state. Skip THIS digest only — once a different digest is
      // sent (or their state changes), they're eligible again.
      continue;
    }

    candidates.push({
      personId: row.personId,
      personName: row.personName,
      threadId: row.threadId,
      riskLevel: row.riskLevel,
      lastInboundAt: row.lastInboundAt,
      stateKey
    });
  }

  candidates.sort((a, b) => {
    const rank = (level: "RED" | "AMBER") => (level === "RED" ? 0 : 1);
    if (rank(a.riskLevel) !== rank(b.riskLevel)) {
      return rank(a.riskLevel) - rank(b.riskLevel);
    }
    const inboundKey = (iso: string | null) => {
      const ts = iso ? Date.parse(iso) : Number.NaN;
      return Number.isFinite(ts) ? ts : Number.MAX_SAFE_INTEGER;
    };
    const aIn = inboundKey(a.lastInboundAt);
    const bIn = inboundKey(b.lastInboundAt);
    if (aIn !== bIn) return aIn - bIn;
    return a.personId.localeCompare(b.personId);
  });

  return candidates;
}

// ---- tick / ack / dismiss / snooze --------------------------------------------

export interface TickInputs {
  settings: OverdueDigestSettings;
  rows: OverdueDigestRowInput[];
  nowIso: string;
  localDate: string;
}

export function computeTick(input: TickInputs): OverdueDigestTickResult {
  const { settings, rows, nowIso, localDate } = input;
  if (settings.cadence === "off") {
    return { due: false, reason: "cadence_off", candidates: [] };
  }
  if (settings.dismissForLocalDate && settings.dismissForLocalDate === localDate) {
    return { due: false, reason: "dismissed_today", candidates: [] };
  }
  if (!isDigestDue(settings.cadence, settings.lastDigestAt, nowIso, localDate, settings.lastDigestLocalDate)) {
    return { due: false, reason: "not_due", candidates: [] };
  }
  const candidates = selectCandidates({ rows, settings, nowIso }).slice(0, PREVIEW_CANDIDATE_CAP);
  if (candidates.length === 0) {
    return { due: false, reason: "no_candidates", candidates: [] };
  }
  return { due: true, reason: "due", candidates };
}

export interface AckPersonInput {
  personId: string;
  displayName: string;
  stateKey: string;
}

/**
 * Pure: returns the settings state to persist after a successful digest.
 * Idempotent on `(now, included)` — passing identical inputs twice writes
 * the same row. `localDate` is the dashboard-LOCAL date the digest fired on
 * (the daily cadence compares against it, #628); omitted/legacy callers leave
 * `lastDigestLocalDate` null and the daily check falls back to the UTC prefix.
 */
export function applyAck(
  settings: OverdueDigestSettings,
  included: AckPersonInput[],
  nowIso: string,
  localDate?: string | null
): OverdueDigestSettings {
  const next = cloneSettings(settings);
  next.lastDigestAt = nowIso;
  next.lastDigestLocalDate = asNullableString(localDate);
  for (const person of included) {
    const existing = next.perPerson[person.personId];
    next.perPerson[person.personId] = {
      displayName: person.displayName || existing?.displayName || "",
      lastIncludedAt: nowIso,
      lastIncludedStateKey: person.stateKey,
      snoozedUntil: existing?.snoozedUntil ?? null
    };
  }
  return next;
}

export function applyDismissToday(
  settings: OverdueDigestSettings,
  localDate: string
): OverdueDigestSettings {
  const next = cloneSettings(settings);
  next.dismissForLocalDate = localDate;
  return next;
}

export function applySnoozePerson(
  settings: OverdueDigestSettings,
  personId: string,
  displayName: string,
  untilIso: string
): OverdueDigestSettings {
  const next = cloneSettings(settings);
  const existing = next.perPerson[personId];
  next.perPerson[personId] = {
    displayName: displayName || existing?.displayName || "",
    lastIncludedAt: existing?.lastIncludedAt ?? null,
    lastIncludedStateKey: existing?.lastIncludedStateKey ?? null,
    snoozedUntil: untilIso
  };
  return next;
}

export function applyUnsnoozePerson(
  settings: OverdueDigestSettings,
  personId: string
): OverdueDigestSettings {
  const next = cloneSettings(settings);
  const existing = next.perPerson[personId];
  if (!existing) return next;
  next.perPerson[personId] = {
    ...existing,
    snoozedUntil: null
  };
  return next;
}

/** Convenience for the Settings preview: snoozed people, name-sorted. */
export function listSnoozedPeople(
  settings: OverdueDigestSettings,
  nowIso: string
): Array<{ personId: string; displayName: string; snoozedUntil: string }> {
  const now = Date.parse(nowIso);
  const rows: Array<{ personId: string; displayName: string; snoozedUntil: string }> = [];
  for (const [personId, entry] of Object.entries(settings.perPerson)) {
    if (!entry.snoozedUntil) continue;
    const ms = Date.parse(entry.snoozedUntil);
    if (Number.isNaN(ms) || ms <= now) continue;
    rows.push({
      personId,
      displayName: entry.displayName || personId,
      snoozedUntil: entry.snoozedUntil
    });
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rows;
}

export { DIGEST_HORIZON_DAYS, PREVIEW_CANDIDATE_CAP };
