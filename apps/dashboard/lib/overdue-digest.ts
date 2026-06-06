// Dashboard-side glue for the calm overdue-reply digest (#360). The runner
// owns persistence and selection (see apps/runner/src/services/overdue-
// digest.ts). The dashboard's job is the gate: only call `tick` and fire a
// notification when every condition is met, and never ask for permission
// from the scheduler.

export type OverdueDigestCadence = "off" | "daily" | "weekly";

export interface OverdueDigestCandidate {
  personId: string;
  personName: string;
  threadId: string;
  riskLevel: "RED" | "AMBER";
  lastInboundAt: string | null;
  stateKey: string;
}

export interface OverdueDigestSettings {
  cadence: OverdueDigestCadence;
  lastDigestAt: string | null;
  /** Browser-local date the last digest fired on; drives the daily cadence (#628). */
  lastDigestLocalDate: string | null;
  dismissForLocalDate: string | null;
  perPerson: Record<string, {
    displayName: string;
    lastIncludedAt: string | null;
    lastIncludedStateKey: string | null;
    snoozedUntil: string | null;
  }>;
}

export interface OverdueDigestPreview {
  settings: OverdueDigestSettings;
  candidates: OverdueDigestCandidate[];
  snoozed: Array<{ personId: string; displayName: string; snoozedUntil: string }>;
}

export interface OverdueDigestTickResult {
  due: boolean;
  reason: string;
  candidates: OverdueDigestCandidate[];
}

export interface SchedulerGateInputs {
  cadence: OverdueDigestCadence;
  notificationsSupported: boolean;
  notificationPermission: NotificationPermission | "unsupported";
  documentVisibility: DocumentVisibilityState | "unknown";
  quietHoursActive: boolean;
}

/**
 * Pure gate. The AppShell scheduler must NOT call the runner `tick` (or
 * anything else digest-related) when this returns false. Tested directly
 * by `dashboard-overdue-digest-gate.test.mjs` so the contract is locked.
 */
export function shouldQueryDigestTick(input: SchedulerGateInputs): boolean {
  if (input.cadence === "off") return false;
  if (!input.notificationsSupported) return false;
  if (input.notificationPermission !== "granted") return false;
  // We never fire when the operator is looking at the tab — Today already
  // shows the queue. The digest is a background nudge, not a duplicate.
  if (input.documentVisibility === "visible") return false;
  if (input.quietHoursActive) return false;
  return true;
}

/**
 * Local-date string in YYYY-MM-DD, derived from the browser's clock so the
 * runner can compare it against the persisted `dismissForLocalDate` without
 * caring about server time zones.
 */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function summariseCandidatesForAck(
  candidates: OverdueDigestCandidate[]
): Array<{ personId: string; displayName: string; stateKey: string }> {
  // Dedupe by personId in case the runner ever returns two threads for the
  // same person. The first-seen ordering matters (RED before AMBER, oldest
  // waiting first), so we preserve it.
  const seen = new Set<string>();
  const out: Array<{ personId: string; displayName: string; stateKey: string }> = [];
  for (const c of candidates) {
    if (seen.has(c.personId)) continue;
    seen.add(c.personId);
    out.push({
      personId: c.personId,
      displayName: c.personName,
      stateKey: c.stateKey
    });
  }
  return out;
}
