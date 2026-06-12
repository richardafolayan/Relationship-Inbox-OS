// Composer-source state for the thread page reply box.
//
// `composerSource` tracks where the current composer text came from so the
// reply box can frame an AI predraft differently from a draft or operator
// text: a "predraft" source paints an accent border plus soft ring and shows
// the "AI predraft / review before sending" badge with its Discard button.
//
// The thread page does NOT remount across /thread/A -> /thread/B (same App
// Router dynamic segment), so the source has to be reset by hand whenever the
// composer text is cleared. It already resets on a thread switch, on Discard,
// and on Delete-draft. It must ALSO reset when a send or a schedule empties
// the composer: otherwise the operator sends an AI predraft, the textarea goes
// empty, but `composerSource` stays "predraft" and the accent frame plus badge
// keep framing a now-empty input until they start typing (which flips the
// source to "user") or navigate away.
//
// These are pure so the reset decision and the badge predicate can be unit
// tested without mounting the page.

export type ComposerSource = "empty" | "draft" | "predraft" | "user";

// The composer source after the text has been cleared by a successful send or
// schedule. An empty composer is never a predraft/draft/user surface, so the
// only correct source is "empty".
export function composerSourceAfterClear(): ComposerSource {
  return "empty";
}

// Whether the AI-predraft frame (accent border + ring) and badge should show.
// Only true when the source is still "predraft" AND there is text to frame: an
// empty composer must never wear the predraft chrome, regardless of a stale
// source value.
export function showsPredraftFrame(source: ComposerSource, composerText: string): boolean {
  return source === "predraft" && composerText.trim().length > 0;
}
