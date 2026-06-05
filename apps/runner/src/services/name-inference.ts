/**
 * Heuristic contact-name inference for platforms that store contacts as
 * phone numbers / emails (iMessage today). We scan outbound messages for
 * greetings that address the contact by first name ("Hi Marianne", "Hey
 * Tom"), and inbound messages for sign-offs ("...love, Marianne").
 *
 * This is intentionally a regex pass, not an AI call: it's free, runs
 * during scan, and is right often enough to be useful. The operator gets
 * the result as a "Maybe …" suggestion they can confirm, edit, or reject —
 * so a wrong guess costs them one click, not a pollution of the DB.
 */

interface InferenceMessage {
  direction: "IN" | "OUT";
  text: string;
}

// Common-word false positives the regex would otherwise grab. All
// lowercased for comparison.
const STOPWORDS = new Set([
  "yes", "no", "ok", "okay", "yeah", "yo", "hi", "hey", "hello", "sup", "thanks",
  "thank", "cheers", "bye", "love", "yep", "nope", "lol", "lmao", "haha", "ye",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "amen", "amennn", "yh", "yhh", "yhhh", "rn", "tbh", "imo", "btw", "idk", "tn", "tmr", "atm",
  "yee", "good", "great", "fine", "alright", "cool", "nice", "wait", "wut", "what",
  "soon", "later", "today", "tomorrow", "back", "home", "kk"
]);

/**
 * Patterns that capture a likely first name. All anchored or word-boundary
 * gated so we don't match mid-word.
 */
const OUTBOUND_PATTERNS: RegExp[] = [
  // "Hi/Hey/Hello/Yo Marianne[ Smith]" at message start (case-insensitive)
  /^\s*(?:hi+|hey+|hello+|yo+|sup|thanks|thank you|cheers|bye)\s+([A-Z][a-z]{1,15})(?:\s+([A-Z][a-z]{1,15}))?\b/i,
  // "Marianne, hi/hey..."
  /^\s*([A-Z][a-z]{1,15})\s*,\s*(?:hi+|hey+|hello+|yo+)\b/i,
  // "Happy birthday Marianne"
  /\b(?:happy|merry)\s+(?:birthday|new year|christmas|easter)\s+([A-Z][a-z]{1,15})\b/i
];

const INBOUND_PATTERNS: RegExp[] = [
  // sign-off: "- Marianne" or "— Marianne" at end
  /[-—]\s*([A-Z][a-z]{1,15})\s*[\.!]?\s*$/,
  // sign-off: "love, Marianne" / "love Marianne x"
  /\blove,?\s+([A-Z][a-z]{1,15})\b/i
];

function isPlausibleFirstName(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  const lower = candidate.toLowerCase();
  if (STOPWORDS.has(lower)) return false;
  if (candidate.length < 2 || candidate.length > 16) return false;
  // Reject all-uppercase (likely an acronym).
  if (candidate === candidate.toUpperCase()) return false;
  return /^[A-Z][a-z]+$/.test(candidate);
}

/**
 * Walk the messages and tally candidate names. Returns the most-frequent
 * candidate, or null if no clear winner. Requires at least 2 hits OR a
 * single hit from a high-confidence outbound pattern (greeting at start of
 * message).
 */
export function inferContactName(messages: InferenceMessage[]): string | null {
  const tally = new Map<string, { count: number; sources: Set<string> }>();
  const bump = (name: string, source: string) => {
    const entry = tally.get(name) ?? { count: 0, sources: new Set<string>() };
    entry.count += 1;
    entry.sources.add(source);
    tally.set(name, entry);
  };

  for (const msg of messages) {
    if (!msg.text) continue;
    const text = msg.text;
    const patterns = msg.direction === "OUT" ? OUTBOUND_PATTERNS : INBOUND_PATTERNS;
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      const candidate = match[1];
      if (isPlausibleFirstName(candidate)) {
        bump(candidate, msg.direction);
      }
    }
  }

  if (tally.size === 0) return null;
  // Sort by count desc, then by name length desc (prefer longer / more specific).
  const sorted = [...tally.entries()].sort((a, b) =>
    b[1].count - a[1].count || b[0].length - a[0].length
  );
  const [winner, info] = sorted[0]!;
  // High-confidence: at least 2 occurrences, or any occurrence from
  // outbound (we addressed them by name).
  if (info.count >= 2 || info.sources.has("OUT")) {
    return winner;
  }
  return null;
}

/**
 * Phone-number / email displayName recognizer. Used to gate inference: we
 * never overwrite a real name (LinkedIn provides those directly).
 */
export function looksLikeUnresolvedHandle(displayName: string): boolean {
  const trimmed = displayName.trim();
  if (!trimmed) return true;
  // Phone-shaped: starts with + or contains 7+ digits, may have spaces/dashes.
  if (/^\+?[\d\s().-]{7,}$/.test(trimmed)) return true;
  // Email-shaped.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  return false;
}

/**
 * "No usable personal name on file" check, used to gate the prompt's
 * Recipient line (see ai.ts contactNameContext). True when the displayName
 * is blank, a bare phone/email handle, OR a comma-joined list where EVERY
 * segment is a bare handle — iMessage group chats with no saved contacts key
 * by handle ("+447…, +447…"), which looksLikeUnresolvedHandle misses because
 * the comma/second-plus break its single-handle regex.
 *
 * Deliberately separate from looksLikeUnresolvedHandle (which gates 1:1 name
 * inference and must NOT fire on multi-handle group strings it can't resolve
 * to one person). A group that carries real names ("Israel, Teni, Keisha")
 * is NOT nameless — `every` is false there, so the model may use those names.
 */
export function looksLikeNamelessRecipient(displayName: string | null | undefined): boolean {
  const trimmed = (displayName ?? "").trim();
  if (!trimmed) return true;
  const segments = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return true;
  return segments.every((segment) => looksLikeUnresolvedHandle(segment));
}
