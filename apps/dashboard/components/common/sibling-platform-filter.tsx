"use client";

import React from "react";

export type SiblingPlatformFilterValue =
  | "all"
  | "LINKEDIN"
  | "INSTAGRAM"
  | "IMESSAGE"
  | "WHATSAPP"
  | "GOOGLE_MESSAGES";

interface SiblingPlatformFilterProps {
  value: SiblingPlatformFilterValue;
  siblings: ReadonlyArray<{ platform: string }>;
  onChange: (value: SiblingPlatformFilterValue) => void;
}

export function SiblingPlatformFilter({
  value,
  siblings,
  onChange
}: SiblingPlatformFilterProps) {
  const has = (platform: SiblingPlatformFilterValue) =>
    siblings.some((row) => row.platform === platform);

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as SiblingPlatformFilterValue)}
      className="rounded border border-hairline bg-paper px-1 py-[2px] font-mono text-[10px] uppercase tracking-[0.06em] text-ink-2 focus:border-ink-3 focus:outline-none"
      aria-label="Filter sibling threads by platform"
    >
      <option value="all">All</option>
      <option value="LINKEDIN">LinkedIn</option>
      {has("INSTAGRAM") ? <option value="INSTAGRAM">Instagram</option> : null}
      <option value="IMESSAGE">iMessage</option>
      {has("GOOGLE_MESSAGES") ? (
        <option value="GOOGLE_MESSAGES">Google Messages</option>
      ) : null}
      {has("WHATSAPP") ? <option value="WHATSAPP">WhatsApp</option> : null}
    </select>
  );
}
