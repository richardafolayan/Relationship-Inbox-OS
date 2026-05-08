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

// AI-generated contact summaries occasionally narrate the prompt back at
// the operator ("The operator profile is not available, so no commonality
// can be identified."). The runner now strips this server-side, but old
// summaries are already in the DB — clean them on render too. See #95.
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
