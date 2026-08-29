"use client";

import { useEffect, useMemo, useState } from "react";
import { Bell, Check, Moon, Send, X } from "lucide-react";
import {
  focusAckExclusion,
  isFocusAckCandidate,
  needsReplyAfterFocusReminder,
  noteForRow,
  type FocusRow
} from "@/lib/focus";
import { sendAcknowledgement, useFocusWindow } from "@/lib/use-focus-window";
import type { ThreadResponse } from "@/lib/types";

// Derive the minimal focus row from the open thread. lastInbound/lastOutbound
// come from the loaded message window (the most recent messages are always
// loaded), which is enough to decide "arrived during focus" + "replied today".
function focusRowFromThread(thread: ThreadResponse): FocusRow {
  let lastIn: string | null = null;
  let lastOut: string | null = null;
  for (const message of thread.messages) {
    if (message.direction === "IN") {
      if (!lastIn || message.timestamp > lastIn) lastIn = message.timestamp;
    } else if (message.direction === "OUT") {
      if (!lastOut || message.timestamp > lastOut) lastOut = message.timestamp;
    }
  }
  return {
    personId: thread.personId,
    personName: thread.personName,
    personFavourite: thread.personFavourite,
    personBirthday: thread.personBirthday,
    isGroup: thread.isGroup,
    platform: thread.platform,
    category: null,
    needsReply: thread.needsReply,
    lastInboundAt: lastIn,
    lastOutboundAt: lastOut
  };
}

// A single compact strip above the composer when the open thread arrived
// during the active focus window: a pre-filled acknowledgement with Send /
// Edit / Dismiss. Sends through the existing send path; the proper reply
// still waits in the composer below.
export function FocusThreadStrip({
  thread,
  onSent
}: {
  thread: ThreadResponse;
  onSent?: () => void;
}) {
  const { focusWindow, settings, templates, active, markAcked } = useFocusWindow();
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<"open" | "sent" | "dismissed">("open");
  const [busy, setBusy] = useState(false);

  const row = useMemo(() => focusRowFromThread(thread), [thread]);
  const candidate = active && isFocusAckCandidate(row, focusWindow, settings);
  const automatic =
    active && focusAckExclusion(row, focusWindow, settings) === "automatic";
  const postFocusReminder = needsReplyAfterFocusReminder(row, focusWindow);
  const reminderKey = postFocusReminder
    ? `focus-post-reply:${focusWindow.windowId || focusWindow.startedAt}:${thread.id}:${row.lastInboundAt ?? ""}`
    : null;
  const [dismissedReminderKey, setDismissedReminderKey] = useState<string | null>(null);

  useEffect(() => {
    if (candidate && note === null) {
      setNote(noteForRow(row, focusWindow, templates));
    }
  }, [candidate, note, row, focusWindow, templates]);

  useEffect(() => {
    setNote(null);
    setEditing(false);
    setStatus("open");
    setBusy(false);
  }, [thread.id, focusWindow.windowId]);

  useEffect(() => {
    if (!reminderKey) {
      setDismissedReminderKey(null);
      return;
    }
    try {
      setDismissedReminderKey(
        window.localStorage.getItem(reminderKey) === "dismissed" ? reminderKey : null
      );
    } catch {
      setDismissedReminderKey(null);
    }
  }, [reminderKey]);

  const dismissPostFocusReminder = () => {
    if (!reminderKey) return;
    setDismissedReminderKey(reminderKey);
    try {
      window.localStorage.setItem(reminderKey, "dismissed");
    } catch {
      // Best-effort only; the visible dismiss still applies for this render.
    }
  };

  if (postFocusReminder && dismissedReminderKey !== reminderKey) {
    return (
      <div className="mb-2 flex items-start gap-[11px] rounded-[12px] border border-hairline bg-paper px-[13px] py-[10px]">
        <Bell className="mt-[3px] h-[13px] w-[13px] shrink-0 text-accent" strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <div className="mb-[3px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-accent-ink">
            Focus block ended
          </div>
          <div className="text-[13px] leading-[1.45] text-ink">
            They still need a proper reply. The composer is ready below.
          </div>
        </div>
        <button
          type="button"
          onClick={dismissPostFocusReminder}
          aria-label="Dismiss reminder"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-[6px] text-ink-4 transition-colors duration-calm hover:bg-paper-2 hover:text-ink-2"
        >
          <X className="h-[13px] w-[13px]" strokeWidth={1.9} />
        </button>
      </div>
    );
  }

  if (automatic && !focusWindow.ackedPersonIds.includes(thread.personId)) {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-[12px] border border-hairline bg-paper-2 px-3 py-[10px] text-[12.5px] text-ink-2">
        <Moon className="h-[14px] w-[14px] shrink-0 text-accent" strokeWidth={1.8} />
        <span>Automatic focus notes are on. Covered contacts get your saved note once.</span>
      </div>
    );
  }

  if (status === "dismissed") return null;
  if (status === "open" && !candidate) return null;

  const send = async () => {
    // Re-check at click time: the window can lapse between render and tap,
    // and a note promising "till X" must never go out after X.
    if (busy || !candidate) return;
    setBusy(true);
    try {
      await sendAcknowledgement(
        thread.id,
        thread.personId,
        note ?? noteForRow(row, focusWindow, templates),
        focusWindow.windowId
      );
      setStatus("sent");
      setEditing(false);
      onSent?.();
    } catch {
      // Leave the strip actionable so the operator can retry.
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setStatus("dismissed");
    await markAcked(thread.personId);
  };

  if (status === "sent") {
    return (
      <div className="mb-2 flex items-center gap-2 rounded-[12px] border border-hairline bg-paper px-3 py-[10px] text-[12.5px] text-ink-2">
        <Check className="h-[14px] w-[14px] shrink-0 text-risk-fresh" strokeWidth={2} />
        <span>Note sent. They know you’ve seen it. Your proper reply still waits below.</span>
      </div>
    );
  }

  return (
    <div
      className="mb-2 flex items-start gap-[11px] rounded-[12px] border px-[13px] py-[10px]"
      style={{
        borderColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
        background: "var(--accent-soft)"
      }}
    >
      <Moon className="mt-[3px] h-[13px] w-[13px] shrink-0 text-accent" strokeWidth={1.7} />
      <div className="min-w-0 flex-1">
        <div className="mb-[3px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-accent-ink">
          Came in during your focus block
        </div>
        {editing ? (
          <textarea
            value={note ?? ""}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            autoFocus
            className="w-full resize-y rounded-[6px] border border-accent bg-paper px-2 py-1.5 text-[13px] leading-[1.45] text-ink outline-none"
          />
        ) : (
          <div className="text-[13px] leading-[1.45] text-ink">{note}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-[6px]">
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy}
          className="inline-flex items-center gap-[6px] whitespace-nowrap rounded-pill bg-accent px-[13px] py-[6px] text-[12.5px] font-medium text-white transition-opacity duration-calm hover:opacity-90 disabled:opacity-50"
        >
          <Send className="h-[12px] w-[12px]" strokeWidth={1.7} />
          {busy ? "Sending…" : "Send note"}
        </button>
        <button
          type="button"
          onClick={() => setEditing((prev) => !prev)}
          className="rounded-pill border border-hairline-strong px-[12px] py-[5px] text-[12px] text-ink-2 transition-colors duration-calm hover:text-ink"
        >
          {editing ? "Done" : "Edit"}
        </button>
        <button
          type="button"
          onClick={() => void dismiss()}
          aria-label="Dismiss"
          className="grid h-6 w-6 place-items-center rounded-[6px] text-ink-4 transition-colors duration-calm hover:bg-paper-2 hover:text-ink-2"
        >
          <X className="h-[13px] w-[13px]" strokeWidth={1.9} />
        </button>
      </div>
    </div>
  );
}
