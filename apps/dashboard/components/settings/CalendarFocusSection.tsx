"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { apiPost } from "@/lib/api";
import { useFocusWindow } from "@/lib/use-focus-window";
import type {
  CalendarPreviewResponse,
  CalendarSyncSettings,
  FocusAudience
} from "@/lib/types";

// Settings -> Focus -> Calendar auto-focus (issue #786, pilot R-0097).
//
// The operator pastes their calendar's read-only "secret address in iCal
// format" URL; the runner subscribes to that feed and opens a Focus window on
// its own while an event is live. Nothing here sends anything - an auto-opened
// window surfaces the same one-tap acknowledgements a manual one does.
//
// Styling mirrors FocusSettingsSection so it reads as one more focus section.
// URL + keyword debounce like the note templates; the enable toggle and
// audience save immediately. The "check calendar" button fetches the feed once
// so the operator can confirm the address works before relying on it.

const TEXT_DEBOUNCE_MS = 600;

const AUDIENCE_OPTIONS: Array<{ value: FocusAudience; name: string; desc: string }> = [
  {
    value: "favourites",
    name: "Favourites only",
    desc: "Close personal contacts you've starred. The safest default."
  },
  {
    value: "all_personal",
    name: "All personal contacts",
    desc: "Anyone saved as a real person on iMessage. Strangers and businesses are still left alone."
  }
];

function formatClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  let hour = d.getHours();
  const minute = d.getMinutes();
  const meridiem = hour >= 12 ? "pm" : "am";
  hour = hour % 12 || 12;
  return `${hour}:${String(minute).padStart(2, "0")}${meridiem}`;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "result"; data: CalendarPreviewResponse };

export function CalendarFocusSection() {
  const { profile, calendarSync, saveCalendarSync } = useFocusWindow();
  const [local, setLocal] = useState<CalendarSyncSettings>(calendarSync);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const hydrated = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Single source of truth for what should be saved. Every edit updates it, and
  // both the debounced text saves and the immediate toggle/audience saves send
  // THIS value - so a slow debounced URL save can never land last and revert a
  // toggle made after it (an immediate save also cancels the pending debounce).
  const latest = useRef<CalendarSyncSettings>(calendarSync);

  // Own local editor state once the real profile lands, so a background
  // profile refresh can't clobber an in-progress edit.
  useEffect(() => {
    if (profile && !hydrated.current) {
      setLocal(calendarSync);
      latest.current = calendarSync;
      hydrated.current = true;
    }
  }, [profile, calendarSync]);

  const persistNow = async () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setStatus("saving");
    try {
      await saveCalendarSync(latest.current);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const persistDebounced = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void persistNow();
    }, TEXT_DEBOUNCE_MS);
  };

  // Flush any pending debounced save on unmount so a fast tab switch doesn't
  // drop the last keystrokes.
  useEffect(
    () => () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        void saveCalendarSync(latest.current);
      }
    },
    [saveCalendarSync]
  );

  // Update both the rendered state and the save source of truth together.
  const apply = (next: CalendarSyncSettings) => {
    setLocal(next);
    latest.current = next;
  };

  const flush = () => void persistNow();

  const setUrl = (url: string) => {
    apply({ ...latest.current, url });
    setCheck({ kind: "idle" });
    persistDebounced();
  };

  const setKeyword = (keyword: string) => {
    apply({ ...latest.current, keyword });
    persistDebounced();
  };

  const toggleEnabled = () => {
    apply({ ...latest.current, enabled: !latest.current.enabled });
    void persistNow();
  };

  const chooseAudience = (audience: FocusAudience) => {
    apply({ ...latest.current, audience });
    void persistNow();
  };

  const runCheck = async () => {
    await persistNow(); // make sure the latest URL is saved before we test it
    setCheck({ kind: "checking" });
    try {
      const data = await apiPost<CalendarPreviewResponse>("/runner/control/calendar/preview", {
        url: latest.current.url,
        keyword: latest.current.keyword
      });
      setCheck({ kind: "result", data });
    } catch {
      setCheck({
        kind: "result",
        data: { ok: false, error: "Could not reach the calendar. Check the address and try again." }
      });
    }
  };

  const checkLine = renderCheckLine(check);

  return (
    <section className="mb-9">
      <div className="mb-3 flex items-baseline gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
          Calendar auto-focus
        </p>
        {status === "saving" ? (
          <span className="font-mono text-[10px] text-ink-3">saving...</span>
        ) : status === "saved" ? (
          <span className="font-mono text-[10px] text-ink-3">saved</span>
        ) : status === "error" ? (
          <span className="text-[11px] text-ink-2">Couldn't save. Try again.</span>
        ) : null}
      </div>

      <div className="rounded-card border border-hairline bg-paper p-6">
        <p className="m-0 mb-[18px] max-w-[64ch] text-[13.5px] leading-[1.5] text-ink-2">
          Connect a calendar and focus starts on its own while you are in an event, then ends when it
          does. Open your calendar's settings and copy its{" "}
          <span className="text-accent-ink">secret address in iCal format</span> (Google Calendar,
          Apple Calendar and Outlook all offer one). It is read only, and nothing is ever sent for
          you.
        </p>

        <label className="mb-1 block text-[13.5px] font-medium text-ink">
          Secret iCal address
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            type="url"
            inputMode="url"
            spellCheck={false}
            autoComplete="off"
            value={local.url}
            placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
            onChange={(event) => setUrl(event.target.value)}
            onBlur={flush}
            className="w-full flex-1 rounded-[9px] border border-hairline bg-paper px-3 py-[10px] font-mono text-[12.5px] leading-[1.5] text-ink outline-none transition-colors duration-calm focus:border-accent"
          />
          <button
            type="button"
            onClick={runCheck}
            disabled={!local.url.trim() || check.kind === "checking"}
            className={cn(
              "shrink-0 rounded-[9px] border px-4 py-[10px] text-[13px] font-medium transition-colors duration-calm",
              !local.url.trim() || check.kind === "checking"
                ? "cursor-not-allowed border-hairline text-ink-3"
                : "border-accent text-accent-ink hover:bg-accent-soft"
            )}
          >
            {check.kind === "checking" ? "Checking..." : "Check calendar"}
          </button>
        </div>
        {checkLine ? <p className={cn("mt-2 text-[12.5px] leading-[1.5]", checkLine.tone)}>{checkLine.text}</p> : null}

        <div className="mt-5 border-t border-hairline">
          <ToggleRow
            name="Start focus from my calendar"
            desc="While this is on, focus turns on by itself during your events and off when they end. Turn it off any time to go back to starting focus by hand."
            on={local.enabled}
            onChange={toggleEnabled}
          />
        </div>

        <div className="mt-5">
          <label className="mb-1 block text-[13.5px] font-medium text-ink">
            Only these events (optional)
          </label>
          <p className="mb-2 text-[12px] text-ink-3">
            Leave empty to focus during every busy event. Add a word (like "focus" or "deep work")
            to only start focus for events whose title contains it. All-day events and anything
            marked free are always ignored.
          </p>
          <input
            type="text"
            spellCheck={false}
            value={local.keyword}
            placeholder="Every busy event"
            onChange={(event) => setKeyword(event.target.value)}
            onBlur={flush}
            className="w-full rounded-[9px] border border-hairline bg-paper px-3 py-[10px] text-[13.5px] leading-[1.5] text-ink outline-none transition-colors duration-calm focus:border-accent"
          />
        </div>

        <div className="mt-6">
          <p className="mb-[10px] font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-3">
            Who an auto-started window covers
          </p>
          <p className="m-0 mb-2 max-w-[64ch] text-[12px] leading-[1.5] text-ink-3">
            The same choice as a window you start by hand. Unknown numbers and spam are never
            acknowledged.
          </p>
          <div className="flex flex-col gap-2">
            {AUDIENCE_OPTIONS.map((option) => {
              const on = local.audience === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => chooseAudience(option.value)}
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
    </section>
  );
}

function renderCheckLine(check: CheckState): { text: string; tone: string } | null {
  if (check.kind !== "result") return null;
  const { data } = check;
  if (!data.ok) {
    return { text: data.error ?? "Could not read that calendar.", tone: "text-ink-2" };
  }
  if (data.active) {
    const until = formatClock(data.active.endMs);
    const title = data.active.title || "an event";
    return {
      text: `Connected. You're in "${title}" now, so focus would run until ${until}.`,
      tone: "text-ink-2"
    };
  }
  if (data.next) {
    const at = formatClock(data.next.startMs);
    const title = data.next.title || "an event";
    return { text: `Connected. Nothing on now. Next up: "${title}" at ${at}.`, tone: "text-ink-2" };
  }
  return {
    text: "Connected. No busy events found that match right now.",
    tone: "text-ink-3"
  };
}

function ToggleRow({
  name,
  desc,
  on,
  onChange
}: {
  name: string;
  desc: string;
  on: boolean;
  onChange: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onChange}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onChange();
        }
      }}
      className="grid cursor-pointer grid-cols-[1fr_auto] items-center gap-6 rounded-[6px] px-1 py-[16px] transition-colors duration-calm hover:bg-paper-2/60 focus:bg-paper-2/60 focus:outline-none"
    >
      <div>
        <p className="m-0 mb-[4px] text-[14.5px] font-medium text-ink">{name}</p>
        <p
          className="m-0 max-w-[54ch] text-[12.5px] leading-[1.5] text-ink-3"
          style={{ textWrap: "pretty" }}
        >
          {desc}
        </p>
      </div>
      <div className="flex items-center gap-[10px]" onClick={(event) => event.stopPropagation()}>
        <span className="font-mono text-[11px] text-ink-3">{on ? "On" : "Off"}</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={name}
          onClick={onChange}
          className={cn(
            "relative h-[20px] w-[36px] shrink-0 cursor-pointer rounded-pill transition-colors duration-calm",
            on ? "bg-accent" : "bg-hairline-strong"
          )}
        >
          <span
            aria-hidden
            className={cn(
              "absolute left-0 top-[2px] h-[16px] w-[16px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)] transition-transform duration-calm",
              on ? "translate-x-[18px]" : "translate-x-[2px]"
            )}
          />
        </button>
      </div>
    </div>
  );
}
