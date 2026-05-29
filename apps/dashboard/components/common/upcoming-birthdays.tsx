"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ageOnNextBirthday, birthdayCountdownLabel } from "@inbox-os/core/birthday";
import { apiGet } from "@/lib/api";
import type { BirthdaysResponse, UpcomingBirthday } from "@/lib/types";
import { PersonAvatar } from "@/components/common/person-avatar";

// Upcoming contact birthdays, read from the operator's macOS Contacts via
// the runner. A gentle prompt to reach out - it renders nothing when no
// birthday falls inside the runner's horizon, so a quiet fortnight adds no
// noise to the Today page.

function BirthdayRow({ birthday }: { birthday: UpcomingBirthday }) {
  const age = ageOnNextBirthday(birthday.birthYear, birthday.monthDay);
  const isToday = birthday.daysUntil <= 0;
  const body = (
    <span className="group flex items-center gap-3 rounded-[8px] px-2 py-[9px] transition-colors duration-calm hover:bg-paper-2">
      <PersonAvatar
        name={birthday.personName}
        avatarUrl={birthday.personAvatarUrl}
        size={28}
        className="text-[11px]"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">
          {birthday.personName}
        </span>
        {age !== null ? (
          <span className="block font-mono text-[11px] tracking-[0.02em] text-ink-3">
            turns {age}
          </span>
        ) : null}
      </span>
      <span
        className={`font-mono text-[12px] ${
          isToday ? "font-medium text-accent-ink" : "text-ink-3"
        }`}
      >
        {birthdayCountdownLabel(birthday.daysUntil)}
      </span>
    </span>
  );
  return birthday.threadId ? (
    <Link href={`/thread/${birthday.threadId}`} className="block">
      {body}
    </Link>
  ) : (
    <span className="block">{body}</span>
  );
}

export function UpcomingBirthdays() {
  const [items, setItems] = useState<UpcomingBirthday[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void apiGet<BirthdaysResponse>("/runner/data/birthdays")
        .then((res) => {
          if (!cancelled) setItems(res.upcoming);
        })
        .catch(() => {
          // Older runner without the endpoint, or a transient failure:
          // treat as "no birthdays" so the card simply stays hidden.
          if (!cancelled) setItems([]);
        });
    };
    load();
    const onResync = () => load();
    window.addEventListener("runner-resync", onResync);
    return () => {
      cancelled = true;
      window.removeEventListener("runner-resync", onResync);
    };
  }, []);

  if (!items || items.length === 0) return null;

  // Collapse the same human appearing under more than one Person row (a
  // known iMessage duplicate-contact artifact) so a birthday lists once.
  const seen = new Set<string>();
  const deduped = items.filter((birthday) => {
    const key = `${birthday.personName.trim().toLowerCase()}|${birthday.monthDay}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    // Open titled section (no card box) so it sits on the page beside
    // Tonight's progress, matching the dissolved-cards redesign.
    <section>
      <p className="mb-[18px] flex items-center gap-[8px] font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
        <span className="inline-block h-[6px] w-[6px] rounded-full bg-accent" />
        Upcoming birthdays
      </p>
      <div className="flex flex-col gap-[2px]">
        {deduped.map((birthday) => (
          <BirthdayRow key={birthday.personId} birthday={birthday} />
        ))}
      </div>
    </section>
  );
}
