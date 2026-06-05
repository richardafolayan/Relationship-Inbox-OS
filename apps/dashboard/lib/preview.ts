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

// AI ask-summaries (whatTheyWant) were historically hard-capped at exactly 120
// code points by a blind slice, which could land mid-word and store
// "...current skills fo". The runner now cuts on word boundaries
// (truncateAtWord), but summaries written before that fix are already in the
// DB. Repair them on render: a blind cut produces a string of EXACTLY the cap
// length, so only a value whose length is exactly 120 AND which does not
// already end on a sentence boundary is treated as bisected. We trim the
// dangling partial word so it reads cleanly ("...current skills"). Everything
// else (any other length, or a clean ending) is returned untouched, so normal
// summaries are never altered. (119, 121, etc. are NOT cuts — the slice always
// yields exactly the cap.) Follow-up to the always-fit Today summaries (#474).
const HARD_CUT_LENGTH = 120;

export function cleanAskSummary(raw: string | null | undefined): string {
  if (!raw) return "";
  const text = raw.trim();
  if (!text) return "";
  // A blind cut yields a string of EXACTLY the cap length; any other length
  // ended naturally and must be left alone.
  if (Array.from(text).length !== HARD_CUT_LENGTH) return text;
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
