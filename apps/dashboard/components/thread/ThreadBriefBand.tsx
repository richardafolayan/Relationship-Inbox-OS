"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

interface ThreadBriefBandProps {
  /** brief.on_you — what this reply needs to do. */
  onYou?: string | null;
  /** brief.where_it_stands — the situation / why it matters. */
  whereItStands?: string | null;
  /** Active open loops (already filtered for dismissed). */
  openLoops: string[];
}

// Compact reply-readiness strip under the thread header. Mirrors the
// essentials of the right-rail Reply Brief so the operator can understand
// the thread without opening the AI rail. On mobile it stays a short fixed
// row (Reply job + To address); deeper context is behind a disclosure so
// the brief never steals half the phone screen (#896).
export function ThreadBriefBand({ onYou, whereItStands, openLoops }: ThreadBriefBandProps) {
  const [expanded, setExpanded] = useState(false);

  const job = (onYou ?? "").trim();
  const context = (whereItStands ?? "").trim();
  const loops = openLoops.filter((loop) => loop.trim().length > 0);

  if (!job && !context && loops.length === 0) return null;

  const lead = job || context;
  const showContext = context.length > 0 && context !== lead;
  const shownLoops = loops.slice(0, 3);
  const extraLoops = loops.length - shownLoops.length;
  // Lead and loops are line-clamped when collapsed; never clamp without a
  // mobile expand control (long onYou + few loops previously hid More).
  const hasDisclosure = Boolean(lead) || loops.length > 0 || showContext;

  return (
    <div
      data-testid="thread-brief-band"
      className={`pt-1.5 sm:pt-2 ${
        expanded ? "max-h-[30dvh] overflow-y-auto overscroll-contain" : ""
      }`}
    >
      {lead ? (
        <p className="m-0 flex items-baseline gap-2 text-[12px] leading-[1.35] text-ink sm:text-[13.5px] sm:leading-[1.5]">
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 sm:text-[10px]">
            {job ? "Reply job" : "Where it stands"}
          </span>
          <span className={`min-w-0 sm:text-balance ${expanded ? "" : "line-clamp-2"}`}>{lead}</span>
        </p>
      ) : null}

      {shownLoops.length > 0 ? (
        <p
          className={`m-0 mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-[3px] text-[12px] leading-[1.35] sm:mt-1.5 sm:text-[12.5px] sm:leading-[1.4] ${
            expanded ? "" : "line-clamp-2 sm:line-clamp-none"
          }`}
        >
          <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-3 sm:text-[10px]">
            To address
          </span>
          {shownLoops.map((loop, index) => (
            <span key={`${loop}-${index}`} className="text-ink-2">
              {loop}
              {index < shownLoops.length - 1 ? "," : ""}
            </span>
          ))}
          {extraLoops > 0 ? <span className="text-ink-3">+{extraLoops} more</span> : null}
        </p>
      ) : null}

      {showContext ? (
        <p
          className={`m-0 mt-1 text-[12px] leading-[1.4] text-ink-3 sm:text-[12.5px] sm:leading-[1.45] ${
            expanded ? "block" : "hidden sm:block"
          }`}
        >
          {context}
        </p>
      ) : null}

      {hasDisclosure ? (
        <button
          type="button"
          data-testid="thread-brief-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:text-ink sm:hidden"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform duration-calm ${expanded ? "rotate-180" : ""}`}
            strokeWidth={1.8}
          />
          {expanded ? "Less" : "More context"}
        </button>
      ) : null}
    </div>
  );
}
