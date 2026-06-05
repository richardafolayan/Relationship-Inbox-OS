// The runner stores literal placeholders like `[system event]` and
// `[non-text message]` for messages that have no readable body (LinkedIn
// connection events, attachments-only sends, etc.). They're useful inside
// the thread view, where they collapse into a centred "automated reply"
// caption, but in inbox previews / hero cards they leak through as raw
// brackets that confuse the operator (issue #90).
const PLACEHOLDER_LABELS: Record<string, string> = {
  "[system event]": "Automated update",
  "[non-text message]": "Sent an attachment"
};

export function normalizePreview(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return PLACEHOLDER_LABELS[trimmed] ?? raw;
}

export function isPreviewPlaceholder(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return Object.prototype.hasOwnProperty.call(PLACEHOLDER_LABELS, raw.trim());
}

// AI ask-summaries (whatTheyWant) were historically hard-capped at a fixed
// code-point count (120 for the AI value, the last-message fallback too),
// which could land mid-word and store "...current skills fo". The runner now
// cuts on word boundaries (truncateAtWord), but summaries written before that
// fix are already in the DB. Repair them on render: when a value sits exactly
// at a known hard-cut length AND does not already end on a sentence boundary,
// it was almost certainly bisected, so trim the dangling partial word and it
// reads cleanly ("...current skills"). Everything else is returned untouched,
// so normal summaries (shorter, or cleanly ended) are never altered. Issue:
// follow-up to the always-fit Today summaries change (#474).
const HARD_CUT_LENGTHS = new Set([119, 120, 139, 140]);

export function cleanAskSummary(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = raw.trim();
  if (!text) return "";
  if (!HARD_CUT_LENGTHS.has(Array.from(text).length)) return text;
  // Ends on sentence punctuation or a closing mark: not a mid-word cut.
  if (/[.!?…"')\]:;]$/u.test(text)) return text;
  // Drop the trailing partial word; keep at least a substantial lead so we
  // never gut a short string that merely happens to hit the length.
  const lead = text.match(/^(.*\S)\s+\S+$/u)?.[1];
  if (!lead || Array.from(lead).length < 40) return text;
  return lead.replace(/[\s,;:-]+$/u, "").trim();
}

// AI-generated contact summaries occasionally narrate the prompt back at
// the operator ("The operator profile is not available, so no commonality
// can be identified."). The runner now strips this server-side, but old
// summaries are already in the DB - clean them on render too. See #95.
export function cleanContactSummary(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const sentences = raw.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    if (!lower.includes("operator")) return true;
    return !/(not available|unavailable|missing|unknown|no commonality|cannot be identified|can't be identified|isn't provided|is not provided|no operator profile)/.test(
      lower
    );
  });
  const cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}
