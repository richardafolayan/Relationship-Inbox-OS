"use client";

// Focus Reply Buffer — the client state hook + acknowledgement send.
//
// The window state lives in the operator profile JSON (one window at a time),
// so every surface and a reload read the same thing. Writes go through the
// existing /control/operator-profile merge endpoint (it only touches the
// fields we send, so this never clobbers the voice profile), then broadcast a
// "focus-window-changed" event so the other mounted surfaces refetch.

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost, peekCache } from "@/lib/api";
import type { AckTemplates, FocusAudience, FocusSettings, FocusWindowState, OperatorProfile } from "@/lib/types";
import {
  isFocusActive,
  readAckTemplates,
  readFocusSettings,
  readFocusWindow
} from "@/lib/focus";

const PROFILE_PATH = "/runner/data/operator-profile";
const FOCUS_CHANGED_EVENT = "focus-window-changed";

/** Tell every mounted focus surface to refetch the profile. */
export function emitFocusChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(FOCUS_CHANGED_EVENT));
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

/**
 * Send an acknowledgement as a NORMAL outbound message through the existing
 * send path — no new send machinery. The runner tags it sentVia:"automation"
 * and emits MESSAGE_SENT, exactly like any composer send.
 */
export async function sendAcknowledgement(threadId: string, text: string): Promise<void> {
  const clientSendId = newWindowId();
  await apiPost(`/runner/control/thread/${threadId}/send`, { text, clientSendId });
}

export interface UseFocusWindow {
  profile: OperatorProfile | null;
  focusWindow: FocusWindowState;
  templates: AckTemplates;
  settings: FocusSettings;
  active: boolean;
  reload: () => void;
  startFocus: (opts: { endsAt: string; reason: string; note: string; audience: FocusAudience }) => Promise<OperatorProfile>;
  /** Edit a live window's end/reason/note/audience without clearing acks. */
  updateFocus: (opts: { endsAt: string; reason: string; note: string; audience: FocusAudience }) => Promise<OperatorProfile>;
  endFocus: () => Promise<OperatorProfile>;
  editNote: (note: string) => Promise<OperatorProfile>;
  markAcked: (personId: string | undefined) => Promise<void>;
  /** Append several person ids to the window's acked set in one write. */
  markManyAcked: (personIds: Array<string | undefined>) => Promise<void>;
  saveTemplates: (templates: AckTemplates) => Promise<OperatorProfile>;
  saveSettings: (settings: FocusSettings) => Promise<OperatorProfile>;
}

export function useFocusWindow(): UseFocusWindow {
  const [profile, setProfile] = useState<OperatorProfile | null>(
    () => peekCache<OperatorProfile>(PROFILE_PATH) ?? null
  );

  const load = useCallback(() => {
    void apiGet<OperatorProfile>(PROFILE_PATH, { ttlMs: 2000 })
      .then((data) => setProfile(data ?? null))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const onChange = () => load();
    window.addEventListener(FOCUS_CHANGED_EVENT, onChange);
    // A Settings voice-profile save also refreshes the whole profile.
    window.addEventListener("operator-profile-saved", onChange);
    return () => {
      window.removeEventListener(FOCUS_CHANGED_EVENT, onChange);
      window.removeEventListener("operator-profile-saved", onChange);
    };
  }, [load]);

  const focusWindow = readFocusWindow(profile);
  const templates = readAckTemplates(profile);
  const settings = readFocusSettings(profile);

  const update = useCallback(async (partial: Partial<OperatorProfile>) => {
    const next = await apiPost<OperatorProfile>("/runner/control/operator-profile", partial);
    setProfile(next);
    emitFocusChanged();
    return next;
  }, []);

  const startFocus = useCallback(
    (opts: { endsAt: string; reason: string; note: string; audience: FocusAudience }) =>
      update({
        focusWindow: {
          active: true,
          startedAt: new Date().toISOString(),
          endsAt: opts.endsAt,
          reason: opts.reason,
          note: opts.note,
          audience: opts.audience,
          windowId: newWindowId(),
          ackedPersonIds: []
        }
      }),
    [update]
  );

  const updateFocus = useCallback(
    (opts: { endsAt: string; reason: string; note: string; audience: FocusAudience }) =>
      update({
        focusWindow: {
          ...readFocusWindow(profile),
          active: true,
          endsAt: opts.endsAt,
          reason: opts.reason,
          note: opts.note,
          audience: opts.audience
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

  return {
    profile,
    focusWindow,
    templates,
    settings,
    active: isFocusActive(focusWindow),
    reload: load,
    startFocus,
    updateFocus,
    endFocus,
    editNote,
    markAcked,
    markManyAcked,
    saveTemplates,
    saveSettings
  };
}
