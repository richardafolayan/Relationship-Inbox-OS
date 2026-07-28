"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

interface ThreadBriefBandProps {
  /** brief.on_you — what this reply needs to do. */
  onYou?: string | null;
  /** brief.where_it_stands — the situation / why it matters. */
  whereItStands?: string | null;
  /** Active open loops (already filtered for dismissed). */
  openLoops: string[];
  /**
   * Thread identity for resetting local expand state when the operator
   * switches threads without remounting via key.
   */
  threadId?: string | null;
}

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function overflowsClamped(el: HTMLElement | null): boolean {
  if (!el) return false;
  // line-clamp sets max-height + overflow hidden; scrollHeight is full wrap.
  return el.scrollHeight > el.clientHeight + 1;
}

// Compact reply-readiness strip under the thread header. Mirrors the
// essentials of the right-rail Reply Brief so the operator can understand
// the thread without opening the AI rail. On mobile it stays a short fixed
// row (Reply job + To address); deeper context is behind a disclosure so
// the brief never steals half the phone screen (#896).
export function ThreadBriefBand({
  onYou,
  whereItStands,
  openLoops,
  threadId
}: ThreadBriefBandProps) {
  const [expanded, setExpanded] = useState(false);
  const [leadOverflows, setLeadOverflows] = useState(false);
  const [loopsOverflows, setLoopsOverflows] = useState(false);
  const leadRef = useRef<HTMLSpanElement | null>(null);
  const loopsRef = useRef<HTMLParagraphElement | null>(null);

  const job = (onYou ?? "").trim();
  const context = (whereItStands ?? "").trim();
  const loops = openLoops.filter((loop) => loop.trim().length > 0);

  useEffect(() => {
    setExpanded(false);
  }, [threadId]);

  useIsoLayoutEffect(() => {
    // Overflow is only meaningful while clamp is applied. Keep the last
    // measurement while expanded so the Less control stays available.
    if (expanded) return;

    const measure = () => {
      setLeadOverflows(overflowsClamped(leadRef.current));
      setLoopsOverflows(overflowsClamped(loopsRef.current));
    };

    measure();

    const observed: HTMLElement[] = [];
    if (leadRef.current) observed.push(leadRef.current);
    if (loopsRef.current) observed.push(loopsRef.current);
    if (observed.length === 0) return;

    const observer = new ResizeObserver(() => {
      measure();
    });
    for (const el of observed) observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, job, context, loops.join("\0")]);

  if (!job && !context && loops.length === 0) return null;

  const lead = job || context;
  const showContext = context.length > 0 && context !== lead;
  const shownLoops = loops.slice(0, 3);
  const extraLoops = loops.length - shownLoops.length;
  // Disclosure only when expand actually reveals something: hidden context,
  // or lead/loops that overflow their two-line mobile clamp (measured).
  const hasDisclosure = showContext || leadOverflows || loopsOverflows;

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
          <span
            ref={leadRef}
            className={`min-w-0 sm:text-balance ${
              expanded ? "" : "phone-clamp-2"
            }`}
          >
            {lead}
          </span>
        </p>
      ) : null}

      {shownLoops.length > 0 ? (
        <p
          ref={loopsRef}
          className={`m-0 mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-[3px] text-[12px] leading-[1.35] sm:mt-1.5 sm:text-[12.5px] sm:leading-[1.4] ${
            expanded ? "" : "phone-clamp-2"
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
            expanded ? "block" : "desktop-ui-block"
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
          className="phone-ui-flex mt-1 items-center gap-1 font-mono text-[10px] uppercase tracking-[0.06em] text-ink-3 transition-colors duration-calm hover:text-ink"
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
