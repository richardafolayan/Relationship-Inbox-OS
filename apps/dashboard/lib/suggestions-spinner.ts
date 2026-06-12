// Suggested-replies spinner decision for the thread page.
//
// The thread page arms a 30s safety ceiling on the "Generating suggestions…"
// spinner: when the runner reports `suggestedRepliesStatus === "generating"`
// with no chips yet, a timer flips a local `suggestionsTimedOut` flag so a
// missed SUGGESTED_REPLIES_UPDATED event (or a hung AI call) can't pin the
// spinner forever — after the ceiling we fall back to the static chips.
//
// `computeRepliesGenerating` is the single decision that drives the spinner:
// show it only while the server still says "generating" AND we have not given
// up locally. It is pure so the cross-thread reset behaviour can be unit
// tested — the flag is thread-local and MUST be cleared on navigation, or a
// timeout from a previous thread suppresses a still-generating next thread's
// spinner (it renders static fallback chips instead).
export function computeRepliesGenerating(
  serverSaysGenerating: boolean,
  suggestionsTimedOut: boolean
): boolean {
  return serverSaysGenerating && !suggestionsTimedOut;
}
