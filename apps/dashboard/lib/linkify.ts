// URL detection for message bubbles. Pure string helpers - no React, no
// imports - so tests/dashboard-linkify.test.mjs can import this file
// directly through the tsx loader (same pattern as lib/preview.ts).

export type TextSegment =
  | { type: "text"; value: string }
  | { type: "url"; value: string; href: string };

// Candidates start with an explicit scheme or "www." - bare domains
// ("tiktok.com/x") are left alone on purpose: in chat text they are more
// often shorthand than tappable intent, and false positives turn ordinary
// sentences into links.
const URL_CANDIDATE_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;

// Sentence punctuation that commonly trails a pasted link ("see x.com/y.")
// and should not be part of the href.
const TRAILING_CHAR_RE = /[.,!?;:'"]$/;
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

function trimTrailingPunctuation(candidate: string): string {
  let out = candidate;
  while (out.length > 0) {
    const last = out.charAt(out.length - 1);
    if (TRAILING_CHAR_RE.test(last)) {
      out = out.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener) {
      // Keep balanced closers - Wikipedia-style URLs end in ")" that is
      // part of the path. Only strip when the closer is unmatched.
      const opens = out.split(opener).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) {
        out = out.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return out;
}

function toHref(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

/** Is the candidate substantial enough to treat as a link? */
function isPlausibleUrl(candidate: string): boolean {
  const rest = candidate.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  // Needs some host-ish substance ("https://" alone, "www." alone -> no).
  return rest.length >= 3 && /[a-z0-9]/i.test(rest);
}

/**
 * Split message text into plain-text and URL segments, in order. Always
 * returns at least one segment; texts without URLs come back as a single
 * text segment.
 */
export function splitTextSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_CANDIDATE_RE)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const candidate = trimTrailingPunctuation(match[0]);
    if (!candidate || !isPlausibleUrl(candidate)) continue;
    if (start > cursor) segments.push({ type: "text", value: text.slice(cursor, start) });
    segments.push({ type: "url", value: candidate, href: toHref(candidate) });
    cursor = start + candidate.length;
  }
  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments.length > 0 ? segments : [{ type: "text", value: text }];
}

/** All link hrefs in a text, in order of appearance. */
export function extractUrls(text: string): string[] {
  return splitTextSegments(text)
    .filter((segment): segment is Extract<TextSegment, { type: "url" }> => segment.type === "url")
    .map((segment) => segment.href);
}

/**
 * If the trimmed message is exactly one URL and nothing else, return its
 * href - the bubble renders as a preview card instead of bare link text
 * (matches what iMessage does with link-only messages).
 */
export function urlOnlyMessage(text: string): string | null {
  const segments = splitTextSegments(text.trim());
  const only = segments.length === 1 ? segments[0] : undefined;
  return only && only.type === "url" ? only.href : null;
}

/** Hostname for display ("www." stripped); falls back to the input. */
export function displayHost(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}
