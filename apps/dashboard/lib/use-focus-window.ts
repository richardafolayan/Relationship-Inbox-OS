"use client";

// Focus Reply Buffer — the client state hook + acknowledgement send.
//
// The window state lives in the operator profile JSON (one window at a time),
// so every surface and a reload read the same thing. Writes go through the
// existing /control/operator-profile merge endpoint (it only touches the
// fields we send, so this never clobbers the voice profile), then broadcast a
// "focus-window-changed" event so the other mounted surfaces refetch.

import { useCallback, useEffect, useState } from "react";
import { v5 as uuidv5 } from "uuid";
import { apiGet, apiGetRaw, apiPost } from "@/lib/api";
import { useCacheSeed } from "@/lib/use-cache-seed";
import { createExternalActionAttemptStore } from "@/lib/external-action-attempts";
import type { SendStatusResponse } from "@/lib/send-delivery";
import type {
  AckTemplates,
  CalendarSyncSettings,
  FocusAudience,
  FocusSettings,
  FocusWindowState,
  OperatorProfile
} from "@/lib/types";
import {
  isFocusActive,
  readAckTemplates,
  readCalendarSync,
  readFocusSettings,
  readFocusWindow
} from "@/lib/focus";

const PROFILE_PATH = "/runner/data/operator-profile";
const FOCUS_CHANGED_EVENT = "focus-window-changed";
const FOCUS_CHANGED_CHANNEL = "tovi-focus-window-changed";
const focusAcknowledgementAttempts = createExternalActionAttemptStore();

async function canReplaceFocusAcknowledgementAttempt(value: {
  clientSendId: string;
}): Promise<boolean> {
  const status = await apiGetRaw<{ safeToReplace: boolean }>(
    `/runner/data/external-action-status/${encodeURIComponent(value.clientSendId)}`
  );
  return status.safeToReplace;
}

/** Tell every mounted focus surface to refetch the profile. */
export function emitFocusChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(FOCUS_CHANGED_EVENT));
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(FOCUS_CHANGED_CHANNEL);
      channel.postMessage({ type: FOCUS_CHANGED_EVENT });
      channel.close();
    }
  }
}

// The setup + review sheets are mounted once globally (in AppShell), so any
// surface (Today card, top-bar toggle, thread strip) opens them by event.
export const FOCUS_OPEN_SETUP_EVENT = "focus:open-setup";
export const FOCUS_OPEN_REVIEW_EVENT = "focus:open-review";

export function openFocusSetup(opts?: { editNote?: boolean }): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FOCUS_OPEN_SETUP_EVENT, { detail: opts ?? {} }));
}

export function openFocusReview(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FOCUS_OPEN_REVIEW_EVENT));
}

function newWindowId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fw_${Date.now().toString(36)}_${Math.round(Math.random() * 1e9).toString(36)}`;
}

// ─────────────────────────── expiry reconciliation ───────────────────────────
// Liveness is derived from the clock (isFocusActive checks endsAt), so the UI
// flips off the moment a window lapses even if nothing below runs. These two
// guards exist to also write `active:false` back to the profile exactly once,
// so Settings, other tabs and the next reload agree without each deriving it.

// One reconciliation per expired window across every mounted hook instance
// (top bar, rail card, overlays and Settings all run useFocusWindow at once).
const reconciledWindowIds = new Set<string>();
// Suppress the reconciler while a user-initiated profile write is in flight,
// so an "extend window" / "start focus" click racing the expiry timer can't
// be clobbered by a stale deactivation built from the pre-click snapshot.
let profileWriteInFlight = false;

async function reconcileExpiredWindow(windowId: string): Promise<void> {
  if (!windowId || reconciledWindowIds.has(windowId) || profileWriteInFlight) return;
  reconciledWindowIds.add(windowId);
  try {
    // Re-read the freshest profile first: if the operator extended this
    // window or already started a new one, there is nothing to end.
    const profile = await apiGet<OperatorProfile>(PROFILE_PATH);
    const current = profile?.focusWindow;
    if (!current || current.windowId !== windowId || !current.active) return;
    if (isFocusActive(current) || profileWriteInFlight) return;
    await apiPost<OperatorProfile>("/runner/control/operator-profile", {
      focusWindow: { ...current, active: false }
    });
    emitFocusChanged();
  } catch {
    // Leave it derivable-only; retry next time a surface observes the expiry.
    reconciledWindowIds.delete(windowId);
  }
}

/**
 * Send an acknowledgement as a NORMAL outbound message through the existing
 * send path — no new send machinery. The runner tags it sentVia:"automation"
 * and emits MESSAGE_SENT, exactly like any composer send.
 */
export async function sendAcknowledgement(
  threadId: string,
  personId: string | undefined,
  text: string,
  focusWindowId: string
): Promise<void> {
  if (!personId) throw new Error("This focus note cannot be safely linked to a person.");
  const scope = `focus-ack:${focusWindowId}:${personId}`;
  const intent = {
    source: "focus_ack" as const,
    threadId,
    personId,
    text,
    focusWindowId
  };
  const expectedClientSendId = uuidv5(`manual:${focusWindowId}:${personId}`, uuidv5.URL);
  let { clientSendId } = await focusAcknowledgementAttempts.getOrCreateScopedValue(
    scope,
    intent,
    () => ({ clientSendId: expectedClientSendId }),
    canReplaceFocusAcknowledgementAttempt
  );
  const queued = await apiPost<{ clientSendId: string }>(`/runner/control/thread/${threadId}/send`, {
    text,
    clientSendId,
    source: "focus_ack",
    focusWindowId
  });
  if (queued.clientSendId !== clientSendId) {
    const replaced = await focusAcknowledgementAttempts.replaceScopedValue(
      scope,
      (value: { clientSendId: string }) => value.clientSendId === clientSendId,
      { clientSendId: queued.clientSendId }
    );
    if (!replaced) throw new Error("The focus note status changed in another window. Check it before retrying.");
    clientSendId = queued.clientSendId;
  }
  try {
    await waitForFocusAcknowledgementDelivery(clientSendId);
  } catch (error) {
    if (!(error instanceof FocusAcknowledgementDeliveryError) || !error.status.retrySafe) {
      throw error;
    }
    const retry = await apiPost<{ clientSendId: string }>(
      `/runner/control/thread/${threadId}/retry-send`,
      { clientSendId }
    );
    if (retry.clientSendId !== clientSendId) {
      const replaced = await focusAcknowledgementAttempts.replaceScopedValue(
        scope,
        (value: { clientSendId: string }) => value.clientSendId === clientSendId,
        { clientSendId: retry.clientSendId }
      );
      if (!replaced) throw new Error("The focus note status changed in another window. Check it before retrying.");
      clientSendId = retry.clientSendId;
    }
    await waitForFocusAcknowledgementDelivery(clientSendId);
  }
  await apiPost(`/runner/control/thread/${threadId}/focus-ack/complete`, {
    clientSendId,
    focusWindowId
  });
  await focusAcknowledgementAttempts.completeScopedValue<{ clientSendId: string }>(
    scope,
    (value) => value.clientSendId === clientSendId
  );
  emitFocusChanged();
}

export class FocusAcknowledgementDeliveryError extends Error {
  constructor(readonly status: SendStatusResponse, message: string) {
    super(message);
    this.name = "FocusAcknowledgementDeliveryError";
  }
}

export async function waitForFocusAcknowledgementDelivery(
  clientSendId: string,
  readStatus: (path: string) => Promise<SendStatusResponse> = apiGetRaw,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
  maxAttempts = 120
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await readStatus(
      `/runner/data/send-status/${encodeURIComponent(clientSendId)}`
    );
    if (status.status === "SENT") return;
    if (status.status === "FAILED") {
      if (status.deliveryUncertain || status.errorKind === "DELIVERY_UNCERTAIN") {
        throw new FocusAcknowledgementDeliveryError(
          status,
          "Delivery could not be confirmed. Check the conversation before trying again."
        );
      }
      throw new FocusAcknowledgementDeliveryError(
        status,
        status.errorMessage ?? "The focus note was not sent."
      );
    }
    if (status.status === "CANCELLED" || status.status === "NOT_FOUND") {
      throw new FocusAcknowledgementDeliveryError(
        status,
        "The focus note did not reach the recipient."
      );
    }
    await wait(Math.min(250 + attempt * 50, 1_000));
  }
  throw new Error("The focus note is still queued. Its status will be checked before any retry.");
}

export interface UseFocusWindow {
  profile: OperatorProfile | null;
  focusWindow: FocusWindowState;
  templates: AckTemplates;
  settings: FocusSettings;
  calendarSync: CalendarSyncSettings;
  active: boolean;
  reload: () => void;
  startFocus: (opts: {
    endsAt: string;
    reason: string;
    note: string;
    /** Professional-tier note for this window ("" = use the saved template). */
    professionalNote?: string;
    audience: FocusAudience;
    autoSendAcknowledgements: boolean;
  }) => Promise<OperatorProfile>;
  /** Edit a live window's end/reason/notes/audience without clearing acks. */
  updateFocus: (opts: {
    endsAt: string;
    reason: string;
    note: string;
    /** Omitted = keep the window's current professional note. */
    professionalNote?: string;
    audience: FocusAudience;
    autoSendAcknowledgements: boolean;
  }) => Promise<OperatorProfile>;
  endFocus: () => Promise<OperatorProfile>;
  editNote: (note: string) => Promise<OperatorProfile>;
  markAcked: (personId: string | undefined) => Promise<void>;
  /** Append several person ids to the window's acked set in one write. */
  markManyAcked: (personIds: Array<string | undefined>) => Promise<void>;
  saveTemplates: (templates: AckTemplates) => Promise<OperatorProfile>;
  saveSettings: (settings: FocusSettings) => Promise<OperatorProfile>;
  /** Save the calendar auto-focus subscription (issue #786). */
  saveCalendarSync: (calendarSync: CalendarSyncSettings) => Promise<OperatorProfile>;
}

export function useFocusWindow(): UseFocusWindow {
  // Seed from the shared client cache so every focus surface paints the
  // last-known window state immediately. Read via useCacheSeed (NOT a
  // useState initializer): this hook mounts both in the app shell and in
  // page bodies, so the shell's profile fetch can warm the cache before a
  // page boundary hydrates - a useState seed would leak that into the
  // hydration render and mismatch the server HTML.
  const profileSeed = useCacheSeed<OperatorProfile>(PROFILE_PATH);
  const [profileState, setProfile] = useState<OperatorProfile | null>(null);
  const profile = profileState ?? profileSeed ?? null;

  const load = useCallback(() => {
    void apiGet<OperatorProfile>(PROFILE_PATH, { ttlMs: 2000 })
      .then((data) => setProfile(data ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    const channel = typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(FOCUS_CHANGED_CHANNEL)
      : null;
    channel?.addEventListener("message", onChange);
    window.addEventListener(FOCUS_CHANGED_EVENT, onChange);
    // A Settings voice-profile save also refreshes the whole profile.
    window.addEventListener("operator-profile-saved", onChange);
    return () => {
      channel?.removeEventListener("message", onChange);
      channel?.close();
      window.removeEventListener(FOCUS_CHANGED_EVENT, onChange);
      window.removeEventListener("operator-profile-saved", onChange);
    };
  }, [load]);

  const focusWindow = readFocusWindow(profile);
  const templates = readAckTemplates(profile);
  const settings = readFocusSettings(profile);
  const calendarSync = readCalendarSync(profile);

  useEffect(() => {
    if (!focusWindow.active || !focusWindow.autoSendAcknowledgements) return undefined;
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [focusWindow.active, focusWindow.autoSendAcknowledgements, load]);

  // Flip the UI off the moment the live window's endsAt passes, without a
  // reload. isFocusActive() already derives liveness from the clock at every
  // render; this effect only guarantees a render HAPPENS right after endsAt
  // (timer while visible, catch-up on tab return) and triggers the one-shot
  // storage reconciliation once the window has lapsed. Bumping expiryTick
  // re-runs the effect (it is in the dep list), so long windows re-arm
  // hourly rather than trusting one giant setTimeout across laptop sleeps.
  // The lapsed branch never bumps — that would re-render in a loop.
  const [expiryTick, setExpiryTick] = useState(0);
  const endsAtMs = Date.parse(focusWindow.endsAt ?? "");
  useEffect(() => {
    if (!focusWindow.active || !Number.isFinite(endsAtMs)) return undefined;
    if (Date.now() >= endsAtMs) {
      // Already lapsed (timer just fired, a reload after the end, or a stale
      // profile from before this fix). Derived state is already inactive;
      // write it back once so storage and other tabs agree.
      void reconcileExpiredWindow(focusWindow.windowId);
      return undefined;
    }
    const delay = Math.min(endsAtMs - Date.now() + 250, 60 * 60 * 1000);
    const timer = setTimeout(() => setExpiryTick((n) => n + 1), delay);
    // Background tabs throttle timers and laptops sleep through them; catch
    // up the instant the tab is visible again.
    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() >= endsAtMs) {
        setExpiryTick((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [focusWindow.active, endsAtMs, focusWindow.windowId, expiryTick]);

  const update = useCallback(async (partial: Partial<OperatorProfile>) => {
    profileWriteInFlight = true;
    try {
      const next = await apiPost<OperatorProfile>("/runner/control/operator-profile", partial);
      setProfile(next);
      emitFocusChanged();
      return next;
    } finally {
      profileWriteInFlight = false;
    }
  }, []);

  const startFocus = useCallback(
    (opts: {
      endsAt: string;
      reason: string;
      note: string;
      professionalNote?: string;
      audience: FocusAudience;
      autoSendAcknowledgements: boolean;
    }) =>
      update({
        focusWindow: {
          active: true,
          startedAt: new Date().toISOString(),
          endsAt: opts.endsAt,
          reason: opts.reason,
          note: opts.note,
          professionalNote: opts.professionalNote ?? "",
          audience: opts.audience,
          windowId: newWindowId(),
          ackedPersonIds: [],
          autoSendAcknowledgements: opts.autoSendAcknowledgements,
          // A hand-started window; the calendar auto-focus service never
          // touches it (issue #786).
          source: "manual",
          sourceEventKey: ""
        }
      }),
    [update]
  );

  const updateFocus = useCallback(
    (opts: {
      endsAt: string;
      reason: string;
      note: string;
      professionalNote?: string;
      audience: FocusAudience;
      autoSendAcknowledgements: boolean;
    }) =>
      update({
        focusWindow: {
          ...readFocusWindow(profile),
          active: true,
          endsAt: opts.endsAt,
          reason: opts.reason,
          note: opts.note,
          professionalNote:
            opts.professionalNote ?? readFocusWindow(profile).professionalNote ?? "",
          audience: opts.audience,
          autoSendAcknowledgements: opts.autoSendAcknowledgements
        }
      }),
    [update, profile]
  );

  const endFocus = useCallback(
    () => update({ focusWindow: { ...readFocusWindow(profile), active: false } }),
    [update, profile]
  );

  const editNote = useCallback(
    (note: string) => update({ focusWindow: { ...readFocusWindow(profile), note } }),
    [update, profile]
  );

  const markAcked = useCallback(
    async (personId: string | undefined) => {
      if (!personId) return;
      const current = readFocusWindow(profile);
      if (current.ackedPersonIds.includes(personId)) return;
      await update({
        focusWindow: { ...current, ackedPersonIds: [...current.ackedPersonIds, personId] }
      });
    },
    [update, profile]
  );

  const markManyAcked = useCallback(
    async (personIds: Array<string | undefined>) => {
      const current = readFocusWindow(profile);
      const seen = new Set(current.ackedPersonIds);
      const toAdd = personIds.filter((id): id is string => !!id && !seen.has(id));
      if (toAdd.length === 0) return;
      await update({ focusWindow: { ...current, ackedPersonIds: [...current.ackedPersonIds, ...toAdd] } });
    },
    [update, profile]
  );

  const saveTemplates = useCallback(
    (next: AckTemplates) => update({ ackTemplates: next }),
    [update]
  );

  const saveSettings = useCallback(
    (next: FocusSettings) => update({ focusSettings: next }),
    [update]
  );

  const saveCalendarSync = useCallback(
    (next: CalendarSyncSettings) => update({ calendarSync: next }),
    [update]
  );

  return {
    profile,
    focusWindow,
    templates,
    settings,
    calendarSync,
    active: isFocusActive(focusWindow),
    reload: load,
    startFocus,
    updateFocus,
    endFocus,
    editNote,
    markAcked,
    markManyAcked,
    saveTemplates,
    saveSettings,
    saveCalendarSync
  };
}
