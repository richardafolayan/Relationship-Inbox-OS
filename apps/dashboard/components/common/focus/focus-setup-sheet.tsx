"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FocusSheet } from "@/components/common/focus/focus-sheet";
import {
  DEFAULT_FOCUS_REASON,
  endsAtIsoFromTime,
  FOCUS_REASONS,
  fillNote,
  formatUntil,
  resyncNoteUntilLabel,
  rollsToTomorrow
} from "@/lib/focus";
import type { UseFocusWindow } from "@/lib/use-focus-window";
import type { ComposeFocusNoteResponse, FocusAudience } from "@/lib/types";

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
    desc: "Saved people on iMessage too. Unknown numbers and cold outreach are still left alone."
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
  // "Help me phrase this": the operator describes what they're doing; the AI
  // phrases the note pair in their voice. Everything lands in the editable
  // fields below — nothing is saved or sent from here.
  const [activity, setActivity] = useState("");
  const [phrasing, setPhrasing] = useState(false);
  const [phraseError, setPhraseError] = useState<string | null>(null);
  const [professionalNote, setProfessionalNote] = useState("");
  const [suggestedTime, setSuggestedTime] = useState<string | null>(null);
  const [autoSendAcknowledgements, setAutoSendAcknowledgements] = useState(false);

  // Seed the form whenever the sheet opens, from the live window (when
  // editing) or the operator's preferences (when starting fresh). A window
  // counts as "edited" only when its note genuinely differs from what the
  // template would produce for its own end time + reason — a note that is
  // just the auto-filled default keeps auto-syncing with the picker.
  useEffect(() => {
    if (!open) return;
    const seedTime = (active ? timeFromIso(focusWindow.endsAt) : null) ?? defaultTime();
    setTime(seedTime);
    setReason(active && focusWindow.reason ? focusWindow.reason : DEFAULT_FOCUS_REASON);
    setAudience(active ? focusWindow.audience : settings.audience);
    setNote(active && focusWindow.note ? focusWindow.note : templates.close);
    const derivedNote = fillNote(templates.close, {
      name: "[Name]",
      until: formatUntil(focusWindow.endsAt),
      reason: settings.reasonLabel ? focusWindow.reason : ""
    });
    setNoteEdited(active && !!focusWindow.note && focusWindow.note !== derivedNote);
    setProfessionalNote(active ? focusWindow.professionalNote ?? "" : "");
    setAutoSendAcknowledgements(
      active ? Boolean(focusWindow.autoSendAcknowledgements) : false
    );
    setActivity("");
    setPhrasing(false);
    setPhraseError(null);
    setSuggestedTime(null);
  }, [open, active, focusWindow.endsAt, focusWindow.reason, focusWindow.audience, focusWindow.note, focusWindow.professionalNote, focusWindow.autoSendAcknowledgements, settings.audience, settings.reasonLabel, templates.close]);

  // Keep the note's [until] in step with the picker until the operator edits
  // the note themselves — then leave their words alone.
  const untilLabel = useMemo(() => formatUntil(endsAtIsoFromTime(time)), [time]);
  useEffect(() => {
    if (!open || noteEdited) return;
    setNote(fillNote(templates.close, { name: "[Name]", until: untilLabel, reason: settings.reasonLabel ? reason : "" }));
  }, [open, noteEdited, untilLabel, templates.close, reason, settings.reasonLabel]);

  // Once the note IS the operator's own words, a time change still must not
  // leave a stale "till 8:31pm" inside it — swap just the old label for the
  // new one and touch nothing else they wrote.
  const prevUntilRef = useRef(untilLabel);
  useEffect(() => {
    const previous = prevUntilRef.current;
    prevUntilRef.current = untilLabel;
    if (!open || !noteEdited) return;
    if (previous && untilLabel && previous !== untilLabel) {
      setNote((current) => resyncNoteUntilLabel(current, previous, untilLabel));
    }
  }, [open, noteEdited, untilLabel]);

  // The picker rolls a time that already passed today to TOMORROW (so "until
  // 6am" works at night). Say so, instead of silently making a ~24h window.
  const endsTomorrow = useMemo(() => rollsToTomorrow(time), [time]);

  // Keep the editable professional field visible once it exists, even if the
  // operator deletes all its text mid-edit (an empty save just falls back to
  // the saved professional template).
  const [showProfessional, setShowProfessional] = useState(false);
  useEffect(() => {
    if (!open) return;
    setShowProfessional((active ? (focusWindow.professionalNote ?? "").trim().length > 0 : false));
  }, [open, active, focusWindow.professionalNote]);

  // The AI may suggest a reason outside the fixed chips ("driving back");
  // surface it as a selected extra chip rather than dropping it.
  const reasonOptions = useMemo(
    () => (reason && !FOCUS_REASONS.includes(reason) ? [reason, ...FOCUS_REASONS] : FOCUS_REASONS),
    [reason]
  );

  // "Help me phrase this". One explicit tap, composes only: the close note
  // fills the editable textarea below, the professional variant gets its own
  // editable field, the reason chip follows the activity, and a stated end
  // time becomes a tappable suggestion (never silently applied — time
  // mistakes are exactly the class of bug this sheet just got fixed for).
  const phrase = async () => {
    const trimmed = activity.trim();
    if (!trimmed || phrasing) return;
    setPhrasing(true);
    setPhraseError(null);
    try {
      const result = await apiPost<ComposeFocusNoteResponse>(
        "/runner/control/focus/compose-note",
        { activity: trimmed }
      );
      if (!result.ok || !result.close || !result.professional) {
        setPhraseError("Couldn't phrase it just now. Try again, or write it yourself below.");
        return;
      }
      setNote(result.close);
      setNoteEdited(true);
      setProfessionalNote(result.professional);
      setShowProfessional(true);
      if (result.reasonLabel) setReason(result.reasonLabel);
      setSuggestedTime(result.untilTime && result.untilTime !== time ? result.untilTime : null);
    } catch {
      setPhraseError("Couldn't phrase it just now. Try again, or write it yourself below.");
    } finally {
      setPhrasing(false);
    }
  };

  const submit = async () => {
    const endsAt = endsAtIsoFromTime(time);
    const payload = {
      endsAt,
      reason: settings.reasonLabel ? reason : "",
      note,
      professionalNote: professionalNote.trim() ? professionalNote : "",
      audience,
      autoSendAcknowledgements
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
        <div className="flex flex-col gap-[14px] sm:flex-row">
          <label className="flex-1">
            <span className="mb-1 block text-[13.5px] font-medium text-ink">Until</span>
            <span className="mb-2 block text-[12px] text-ink-3">When you'll resurface.</span>
            <input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="w-full rounded-[9px] border border-hairline bg-paper px-3 py-[9px] text-[13.5px] text-ink outline-none transition-colors duration-calm focus:border-accent"
            />
            {endsTomorrow ? (
              <span className="mt-[6px] block text-[11.5px] leading-[1.4] text-accent-ink">
                That time has already passed today, so this window runs until {untilLabel} tomorrow.
              </span>
            ) : null}
          </label>
          {settings.reasonLabel ? (
            <div className="flex-[1.4]">
              <span className="mb-1 block text-[13.5px] font-medium text-ink">
                Reason <span className="font-normal text-ink-4">· optional</span>
              </span>
              <span className="mb-2 block text-[12px] text-ink-3">So it reads as a real block.</span>
              <div className="flex flex-wrap gap-[7px]">
                {reasonOptions.map((option) => {
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

        <div className="rounded-[12px] border border-hairline bg-paper-2/40 px-[14px] py-[12px]">
          <span className="mb-1 flex items-center gap-[6px] text-[13.5px] font-medium text-ink">
            <Sparkles className="h-[13px] w-[13px] text-accent" strokeWidth={1.7} />
            Help me phrase this
          </span>
          <span className="mb-2 block text-[12px] leading-[1.5] text-ink-3">
            Say what you're doing in your own words and it drafts the notes in your voice. You can
            edit everything before it's used.
          </span>
          <div className="flex gap-[8px]">
            <input
              type="text"
              value={activity}
              onChange={(event) => setActivity(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void phrase();
                }
              }}
              placeholder="e.g. driving back from London till 9"
              className="min-w-0 flex-1 rounded-[9px] border border-hairline bg-paper px-3 py-[8px] text-[13px] text-ink outline-none transition-colors duration-calm focus:border-accent"
            />
            <button
              type="button"
              onClick={() => void phrase()}
              disabled={phrasing || !activity.trim()}
              className="shrink-0 rounded-pill border border-hairline-strong px-[14px] py-[7px] text-[12.5px] font-medium text-ink-2 transition-colors duration-calm hover:border-accent hover:text-ink disabled:opacity-50"
            >
              {phrasing ? "Phrasing…" : "Phrase it"}
            </button>
          </div>
          {phraseError ? (
            <span className="mt-2 block text-[12px] text-risk-overdue">{phraseError}</span>
          ) : null}
          {suggestedTime ? (
            <button
              type="button"
              onClick={() => {
                setTime(suggestedTime);
                setSuggestedTime(null);
              }}
              className="mt-2 inline-flex items-center gap-[6px] rounded-pill border border-hairline px-[11px] py-[5px] text-[12px] text-accent-ink transition-colors duration-calm hover:border-accent"
            >
              Suggested: until {formatUntil(endsAtIsoFromTime(suggestedTime)) || suggestedTime}, tap
              to set the window
            </button>
          ) : null}
        </div>

        <label className="block">
          <span className="mb-1 block text-[13.5px] font-medium text-ink">Your note</span>
          <span className="mb-2 block text-[12px] leading-[1.5] text-ink-3">
            In your own words.{" "}
            <span className="text-accent-ink">[Name]</span> fills in each person's first name and{" "}
            <span className="text-accent-ink">[until]</span> the time you're back; close contacts
            get your casual note while professional ones get the calmer one. {autoSendAcknowledgements
              ? "The app will send this note once to each covered person who messages during this window."
              : "You will choose when to send it."}
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

        {showProfessional ? (
          <label className="block">
            <span className="mb-1 block text-[13.5px] font-medium text-ink">
              For professional contacts
            </span>
            <span className="mb-2 block text-[12px] leading-[1.5] text-ink-3">
              The calmer version work contacts get this window. Clear it to fall back to your saved
              professional template.
            </span>
            <textarea
              value={professionalNote}
              onChange={(event) => setProfessionalNote(event.target.value)}
              rows={2}
              className="w-full resize-y rounded-[9px] border border-hairline bg-paper px-3 py-[10px] text-[13.5px] leading-[1.5] text-ink outline-none transition-colors duration-calm focus:border-accent"
            />
          </label>
        ) : null}

        <div>
          <span className="mb-2 block font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
            Who it covers
          </span>
          <span className="mb-2 block text-[12px] text-ink-3">
            Unknown numbers and cold outreach are never acknowledged.
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

        <button
          type="button"
          role="switch"
          aria-checked={autoSendAcknowledgements}
          onClick={() => setAutoSendAcknowledgements((current) => !current)}
          className={cn(
            "grid grid-cols-[1fr_auto] items-center gap-4 rounded-[12px] border px-4 py-[14px] text-left transition-colors duration-calm",
            autoSendAcknowledgements
              ? "border-accent bg-accent-soft"
              : "border-hairline bg-paper hover:border-hairline-strong"
          )}
        >
          <span>
            <span className="block text-[14px] font-medium text-ink">
              Send this note automatically
            </span>
            <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-ink-3">
              Once per covered person in this window. Unknown numbers, group chats, and cold
              outreach are always left alone.
            </span>
          </span>
          <span
            aria-hidden
            className={cn(
              "relative h-6 w-11 rounded-full transition-colors duration-calm",
              autoSendAcknowledgements ? "bg-accent" : "bg-hairline-strong"
            )}
          >
            <span
              className={cn(
                "absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-calm",
                autoSendAcknowledgements ? "translate-x-6" : "translate-x-1"
              )}
            />
          </span>
        </button>
      </div>
    </FocusSheet>
  );
}
