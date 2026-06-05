interface ThreadBriefBandProps {
  /** brief.on_you — what this reply needs to do. */
  onYou?: string | null;
  /** brief.where_it_stands — the situation / why it matters. */
  whereItStands?: string | null;
  /** Active open loops (already filtered for dismissed). */
  openLoops: string[];
}

// A compact, always-visible reply-readiness strip pinned under the thread
// header. It mirrors the essentials of the right-rail Reply Brief — what the
// reply needs to do, why it matters, what's still open — so the operator can
// understand the thread WITHOUT opening the AI rail or rereading the
// conversation. The full Reply Brief (follow-ups, tone steer, draft coverage,
// already-covered) stays in the rail for depth.
//
// Deliberately not a card: it lives inside the glassy header band, separated
// by a single hairline, text only. No nested cards, no icons, no fills.
export function ThreadBriefBand({ onYou, whereItStands, openLoops }: ThreadBriefBandProps) {
  const job = (onYou ?? "").trim();
  const context = (whereItStands ?? "").trim();
  const loops = openLoops.filter((loop) => loop.trim().length > 0);

  if (!job && !context && loops.length === 0) return null;

  // Lead with the reply job; fall back to the situation when no specific ask
  // was extracted. Never show the same sentence twice.
  const lead = job || context;
  const showContext = context.length > 0 && context !== lead;
  const shownLoops = loops.slice(0, 3);
  const extraLoops = loops.length - shownLoops.length;

  return (
    <div data-testid="thread-brief-band" className="mt-2 border-t border-hairline pt-2.5">
      {lead ? (
        <p className="m-0 flex items-baseline gap-2 text-[13.5px] leading-[1.5] text-ink">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            {job ? "Reply job" : "Where it stands"}
          </span>
          <span className="min-w-0 text-balance">{lead}</span>
        </p>
      ) : null}

      {showContext ? (
        <p className="m-0 mt-1 line-clamp-1 text-[12.5px] leading-[1.45] text-ink-3">{context}</p>
      ) : null}

      {shownLoops.length > 0 ? (
        <p className="m-0 mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-[3px] text-[12.5px] leading-[1.4]">
          <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
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
    </div>
  );
}
