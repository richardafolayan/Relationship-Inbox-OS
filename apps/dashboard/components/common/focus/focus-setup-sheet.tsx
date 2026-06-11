"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FocusSheet } from "@/components/common/focus/focus-sheet";
import { DEFAULT_FOCUS_REASON, endsAtIsoFromTime, FOCUS_REASONS, fillNote, formatUntil } from "@/lib/focus";
import type { UseFocusWindow } from "@/lib/use-focus-window";
import type { FocusAudience } from "@/lib/types";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// HH:MM picker value for the default "until" — 90 minutes out, so the window
// reads as a real block rather than a token few-minute pause.
function defaultTime(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 90 * 60 * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function timeFromIso(iso: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const AUDIENCE_OPTIONS: Array<{ value: FocusAudience; name: string; desc: string }> = [
  {
    value: "favourites",
    name: "Favourites only",
    desc: "Close personal contacts you've starred. The safest default."
  },
  {
    value: "all_personal",
    name: "All personal contacts",
    desc: "Saved people on iMessage too. Unknown numbers and businesses are still left alone."
  }
];

export function FocusSetupSheet({
  open,
  onClose,
  focus,
  startInNote
}: {
  open: boolean;
  onClose: () => void;
  focus: UseFocusWindow;
  startInNote?: boolean;
}) {
  const { focusWindow, templates, settings, active, startFocus, updateFocus } = focus;

  const [time, setTime] = useState(defaultTime());
  const [reason, setReason] = useState(DEFAULT_FOCUS_REASON);
  const [audience, setAudience] = useState<FocusAudience>(settings.audience);
  const [note, setNote] = useState(templates.close);
  const [noteEdited, setNoteEdited] = useState(false);

  // Seed the form whenever the sheet opens, from the live window (when
  // editing) or the operator's preferences (when starting fresh).
  useEffect(() => {
    if (!open) return;
    const seedTime = (active ? timeFromIso(focusWindow.endsAt) : null) ?? defaultTime();
    setTime(seedTime);
    setReason(active && focusWindow.reason ? focusWindow.reason : DEFAULT_FOCUS_REASON);
    setAudience(active ? focusWindow.audience : settings.audience);
    setNote(active && focusWindow.note ? focusWindow.note : templates.close);
    setNoteEdited(active && !!focusWindow.note);
  }, [open, active, focusWindow.endsAt, focusWindow.reason, focusWindow.audience, focusWindow.note, settings.audience, templates.close]);

  // Keep the note's [until] in step with the picker until the operator edits
  // the note themselves — then leave their words alone.
  const untilLabel = useMemo(() => formatUntil(endsAtIsoFromTime(time)), [time]);
  useEffect(() => {
    if (!open || noteEdited) return;
    setNote(fillNote(templates.close, { name: "[Name]", until: untilLabel, reason: settings.reasonLabel ? reason : "" }));
  }, [open, noteEdited, untilLabel, templates.close, reason, settings.reasonLabel]);

  const submit = async () => {
    const endsAt = endsAtIsoFromTime(time);
    const payload = {
      endsAt,
      reason: settings.reasonLabel ? reason : "",
      note,
      audience
    };
    try {
      if (active) {
        await updateFocus(payload);
      } else {
        await startFocus(payload);
      }
      onClose();
    } catch {
      // Leave the sheet open; the operator can retry. A failed profile
      // write is rare and non-destructive (nothing was sent).
    }
  };

  return (
    <FocusSheet
      open={open}
      onClose={onClose}
      eyebrow="Focus window"
      title="Protect a block of time."
      sub="Set when you'll resurface. People who message will know you've seen them, and you reply properly after."
      footer={
        <>
          <Button variant="primary" onClick={() => void submit()}>
            {active ? "Update window" : "Start focus"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-[18px]">
        <div className="flex gap-[14px]">
          <label className="flex-1">
            <span className="mb-1 block text-[13.5px] font-medium text-ink">Until</span>
            <span className="mb-2 block text-[12px] text-ink-3">When you'll resurface.</span>
            <input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="w-full rounded-[9px] border border-hairline bg-paper px-3 py-[9px] text-[13.5px] text-ink outline-none transition-colors duration-calm focus:border-accent"
            />
          </label>
          {settings.reasonLabel ? (
            <div className="flex-[1.4]">
              <span className="mb-1 block text-[13.5px] font-medium text-ink">
                Reason <span className="font-normal text-ink-4">· optional</span>
              </span>
              <span className="mb-2 block text-[12px] text-ink-3">So it reads as a real block.</span>
              <div className="flex flex-wrap gap-[7px]">
                {FOCUS_REASONS.map((option) => {
                  const on = reason === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setReason(option)}
                      aria-pressed={on}
                      className={cn(
                        "rounded-pill border px-[13px] py-[6px] text-[12.5px] transition-colors duration-calm",
                        on
                          ? "border-accent bg-accent text-white"
                          : "border-hairline bg-paper text-ink-2 hover:border-hairline-strong hover:text-ink"
                      )}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <label className="block">
          <span className="mb-1 block text-[13.5px] font-medium text-ink">Your note</span>
          <span className="mb-2 block text-[12px] leading-[1.5] text-ink-3">
            In your own words.{" "}
            <span className="text-accent-ink">[Name]</span> fills in each person's first name, and
            close contacts get your casual note while professional ones get the calmer one. Nothing
            sends without you tapping send.
          </span>
          <textarea
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
              setNoteEdited(true);
            }}
            rows={3}
            className="w-full resize-y rounded-[9px] border border-hairline bg-paper px-3 py-[10px] text-[13.5px] leading-[1.5] text-ink outline-none transition-colors duration-calm focus:border-accent"
          />
        </label>

        <div>
          <span className="mb-2 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
            Who it covers
          </span>
          <span className="mb-2 block text-[12px] text-ink-3">
            Unknown numbers and businesses are never acknowledged.
          </span>
          <div className="flex flex-col gap-2">
            {AUDIENCE_OPTIONS.map((option) => {
              const on = audience === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setAudience(option.value)}
                  className={cn(
                    "grid grid-cols-[18px_1fr] items-start gap-3 rounded-[12px] border px-4 py-[13px] text-left transition-colors duration-calm",
                    on
                      ? "border-accent bg-accent-soft"
                      : "border-hairline bg-paper hover:border-hairline-strong"
                  )}
                >
                  <span
                    className={cn(
                      "mt-[1px] grid h-[18px] w-[18px] place-items-center rounded-full border",
                      on ? "border-accent" : "border-hairline-strong"
                    )}
                  >
                    {on ? <span className="h-[8px] w-[8px] rounded-full bg-accent" /> : null}
                  </span>
                  <span>
                    <span className="block text-[14px] font-medium text-ink">{option.name}</span>
                    <span className="block text-[12.5px] text-ink-3">{option.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </FocusSheet>
  );
}
