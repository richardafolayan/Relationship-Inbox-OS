"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { type RememberItem, prepareRememberItems } from "@/lib/thread-remember";

interface ThingsToRememberProps {
  /** AI-extracted durable facts for this thread (ThreadResponse.remember). */
  remember: RememberItem[];
}

// A quiet, read-only memory aid in the thread context rail. The AI re-derives
// these durable facts (exams, trips, life events) from the transcript on
// every scan, so there is no local edit state — when the conversation finally
// gives a date, the next scan fills it in. Dated items show soonest-first;
// anything coming up within a fortnight gets the accent emphasis. The whole
// section hides itself when there is nothing to show.
export function ThingsToRemember({ remember }: ThingsToRememberProps) {
  const items = useMemo(() => prepareRememberItems(remember, new Date()), [remember]);

  if (items.length === 0) return null;

  return (
    <section data-testid="things-to-remember">
      <p className="mb-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">
        Things to remember
      </p>
      <p className="mb-3 text-[12px] leading-[1.5] text-ink-3">
        Dates and life events worth keeping in mind for this person.
      </p>

      <ul className="m-0 list-none space-y-[7px] p-0">
        {items.map((item, index) => {
          const upcoming = item.status === "today" || item.status === "soon";
          return (
            <li
              key={`${item.note}:${item.date ?? "none"}:${index}`}
              className="flex items-start gap-[8px]"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full",
                  upcoming ? "bg-accent" : "bg-hairline-strong"
                )}
              />
              <span className="min-w-0 flex-1 text-[13px] leading-[1.5] text-ink-2">
                {item.note}
              </span>
              <span
                className={cn(
                  "mt-[1px] shrink-0 font-mono text-[10px] uppercase tracking-[0.05em]",
                  item.label
                    ? upcoming
                      ? "text-accent"
                      : "text-ink-3"
                    : "text-ink-4"
                )}
              >
                {item.label || "no date yet"}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
