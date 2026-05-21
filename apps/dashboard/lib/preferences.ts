// Dashboard-local user preferences, persisted in localStorage. Mirrors the
// existing auto-scan / quiet-hours pattern in app/settings/page.tsx — these
// are device-local UI preferences, not runner settings.

export const FULL_AI_REPLIES_KEY = "inbox_full_ai_replies";

/**
 * Whether full AI reply drafting is enabled.
 *
 * Default OFF on purpose. The product leads with replying in your own words,
 * supported by summaries and things-to-address; complete AI drafts are an
 * opt-in aid. See docs/strategy/current-product-direction.md. Returns false
 * outside the browser.
 */
export function readFullAiReplies(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FULL_AI_REPLIES_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persist the full-AI-replies preference. No-op outside the browser. */
export function writeFullAiReplies(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FULL_AI_REPLIES_KEY, enabled ? "1" : "0");
  } catch {
    // Non-fatal: a failed persist just means the preference won't survive a
    // reload. The feature still works for the current session.
  }
}
