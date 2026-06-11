"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { apiGet } from "@/lib/api";
import { isQuietHoursActive } from "@/lib/quiet-hours";
import { formatRelative } from "@/lib/time";
import { normalizePreview } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/common/person-avatar";
import { FocusSheet } from "@/components/common/focus/focus-sheet";
import { coverageForRow, isFocusAckCandidate, noteForRow } from "@/lib/focus";
import { sendAcknowledgement, type UseFocusWindow } from "@/lib/use-focus-window";
import type { InboxResponse, InboxRow } from "@/lib/types";

type RowState = "open" | "sent" | "dismissed";

function rowKey(row: InboxRow): string {
  return row.personId ?? row.id;
}

export function FocusReviewSheet({
  open,
  onClose,
  focus
}: {
  open: boolean;
  onClose: () => void;
  focus: UseFocusWindow;
}) {
  const { focusWindow, settings, templates, markAcked, markManyAcked, active } = focus;
  const [candidates, setCandidates] = useState<InboxRow[]>([]);
  const [state, setState] = useState<Record<string, RowState>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Latest window/settings/templates, read at snapshot time. Held in refs so
  // sending an ack (which mutates focusWindow.ackedPersonIds) does NOT re-run
  // the snapshot effect and wipe the just-sent row's confirmation line.
  const fwRef = useRef(focusWindow);
  fwRef.current = focusWindow;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const templatesRef = useRef(templates);
  templatesRef.current = templates;

  // Snapshot the candidates once per opening so a row stays visible (with its
  // "Note sent" / "Left for later" confirmation) after the operator acts,
  // rather than vanishing the instant it's acknowledged.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void apiGet<InboxResponse>("/runner/data/inbox", { ttlMs: 2000 })
      .then((res) => {
        if (cancelled) return;
        const quiet = isQuietHoursActive();
        const cands = res.rows.filter((row) =>
          isFocusAckCandidate(row, fwRef.current, settingsRef.current, { quietHoursActive: quiet })
        );
        const nextState: Record<string, RowState> = {};
        const nextNotes: Record<string, string> = {};
        for (const row of cands) {
          const key = rowKey(row);
          nextState[key] = "open";
          nextNotes[key] = noteForRow(row, fwRef.current, templatesRef.current);
        }
        setCandidates(cands);
        setState(nextState);
        setNotes(nextNotes);
        setEditing(null);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const openCount = candidates.filter((row) => state[rowKey(row)] === "open").length;

  const sendOne = useCallback(
    async (row: InboxRow) => {
      const key = rowKey(row);
      // The window can lapse while the sheet is open; the notes promise a
      // "till X" that has passed, so nothing may be sent past the end.
      if (!active || state[key] !== "open" || busy) return;
      setBusy(true);
      try {
        await sendAcknowledgement(row.id, notes[key] ?? noteForRow(row, focusWindow, templates));
        await markAcked(row.personId);
        setState((prev) => ({ ...prev, [key]: "sent" }));
        setEditing(null);
      } catch {
        // Keep the row actionable so the operator can retry.
      } finally {
        setBusy(false);
      }
    },
    [active, state, busy, notes, focusWindow, templates, markAcked]
  );

  const dismissOne = useCallback(
    async (row: InboxRow) => {
      const key = rowKey(row);
      if (state[key] !== "open") return;
      setState((prev) => ({ ...prev, [key]: "dismissed" }));
      setEditing(null);
      // Suppress for the rest of the window without sending anything.
      await markAcked(row.personId);
    },
    [state, markAcked]
  );

  const sendAll = useCallback(async () => {
    if (!active || busy) return;
    setBusy(true);
    try {
      const open = candidates.filter((row) => state[rowKey(row)] === "open");
      for (const row of open) {
        const key = rowKey(row);
        try {
          await sendAcknowledgement(row.id, notes[key] ?? noteForRow(row, focusWindow, templates));
          setState((prev) => ({ ...prev, [key]: "sent" }));
        } catch {
          // Skip a failed send; the row stays open for a manual retry.
        }
      }
      await markManyAcked(open.map((row) => row.personId));
    } finally {
      setBusy(false);
    }
  }, [active, busy, candidates, state, notes, focusWindow, templates, markManyAcked]);

  const title = !active
    ? "This focus window has ended."
    : candidates.length === 0
      ? "Nothing's come in yet."
      : openCount === 0
        ? "All acknowledged."
        : `${openCount} ${openCount === 1 ? "person" : "people"} messaged.`;

  return (
    <FocusSheet
      open={open}
      onClose={onClose}
      eyebrow="During your focus block"
      title={title}
      sub={
        !active
          ? "These quick notes only make sense mid-block, so none can be sent now."
          : candidates.length === 0
            ? "When a covered contact messages, you'll be able to send them a quick note here."
            : "Send a quick note so they know you've seen them. Your proper replies still wait in Today."
      }
      footer={
        <>
          {active && openCount > 0 ? (
            <Button variant="primary" onClick={() => void sendAll()} disabled={busy}>
              Send note to all waiting
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {!active ? (
        <p className="py-4 text-[13.5px] leading-[1.5] text-ink-2">
          You're back. Anyone still waiting is in Today, ready for their proper reply.
        </p>
      ) : candidates.length === 0 ? (
        <p className="py-4 text-[13.5px] leading-[1.5] text-ink-2">
          No covered contact has messaged since this window started. The buffer only ever offers a
          note for people you'd actually want to reassure.
        </p>
      ) : (
        <div className="flex flex-col">
          {candidates.map((row) => {
            const key = rowKey(row);
            const rowStatus = state[key] ?? "open";
            const tier = coverageForRow(row, focusWindow.audience).tier;
            const isEditing = editing === key;
            return (
              <div
                key={key}
                className={cn(
                  "grid grid-cols-[32px_1fr] gap-3 border-t border-hairline py-4 first:border-t-0",
                  rowStatus === "dismissed" ? "opacity-50" : null
                )}
              >
                <PersonAvatar name={row.personName} avatarUrl={row.personAvatarUrl} size={32} />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium text-ink">{row.personName}</span>
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3">
                      {row.platform.toLowerCase()} · {formatRelative(row.lastInboundAt)}
                    </span>
                    <span className="rounded-[4px] bg-accent-soft px-[6px] py-[2px] font-mono text-[9px] uppercase tracking-[0.04em] text-accent-ink">
                      {tier}
                    </span>
                  </div>
                  <p className="m-0 mb-[9px] mt-[3px] line-clamp-2 text-[12.5px] text-ink-3">
                    {normalizePreview(row.preview)}
                  </p>

                  {rowStatus === "open" ? (
                    <>
                      {isEditing ? (
                        <textarea
                          value={notes[key] ?? ""}
                          onChange={(event) =>
                            setNotes((prev) => ({ ...prev, [key]: event.target.value }))
                          }
                          rows={2}
                          autoFocus
                          className="mb-[10px] w-full resize-y rounded-[8px] border border-accent bg-paper px-3 py-2 text-[12.5px] leading-[1.5] text-ink outline-none"
                        />
                      ) : (
                        <p className="m-0 mb-[10px] rounded-[8px] bg-accent-soft px-3 py-[9px] text-[12.5px] leading-[1.5] text-ink-2">
                          {notes[key]}
                        </p>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void sendOne(row)}
                          disabled={busy}
                          className="rounded-[8px] border border-accent bg-accent px-[11px] py-[5px] text-[12px] font-medium text-white transition-opacity duration-calm hover:opacity-90 disabled:opacity-50"
                        >
                          Send note
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(isEditing ? null : key)}
                          className="rounded-[8px] border border-hairline-strong px-[11px] py-[5px] text-[12px] text-ink-2 transition-colors duration-calm hover:text-ink"
                        >
                          {isEditing ? "Done" : "Edit"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void dismissOne(row)}
                          className="rounded-[8px] border border-hairline-strong px-[11px] py-[5px] text-[12px] text-ink-2 transition-colors duration-calm hover:text-ink"
                        >
                          Dismiss
                        </button>
                      </div>
                    </>
                  ) : rowStatus === "sent" ? (
                    <p className="m-0 flex items-center gap-2 text-[12.5px] text-ink-2">
                      <Check className="h-[14px] w-[14px] text-risk-fresh" strokeWidth={2} />
                      Note sent. They know you've seen it.
                    </p>
                  ) : (
                    <p className="m-0 text-[12.5px] text-ink-3">Left for later. No note sent.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </FocusSheet>
  );
}
