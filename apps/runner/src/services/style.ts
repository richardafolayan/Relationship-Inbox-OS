import type { StyleProfile } from "../types/runtime";

/**
 * Writing-style analysis (issue #299 / R-0017).
 *
 * Pilot feedback asked for AI drafts to adapt to how the operator
 * actually writes — and to how each contact writes — rather than
 * relying only on a self-described profile in Settings. This module
 * turns a set of raw message texts into a `StyleProfile`: the concrete,
 * measurable signals the feedback named — message length, emoji use,
 * full-stop frequency, capitalisation — and renders that profile as a
 * prompt fragment the draft prompts inject.
 *
 * Everything here is a pure, deterministic function of the input texts:
 * no persona is hardcoded (the style is observed at runtime) and the
 * same texts always yield the same profile, so the rendered fragment is
 * safe to fold into the suggested-replies cache key.
 */

// Minimum non-empty messages before a profile is emitted. Below this the
// rate-based signals (full stops, capitalisation) are too noisy to be
// worth surfacing — callers treat null as "not enough history, fall back
// to the voice prompt + self-profile".
const MIN_SAMPLES = 2;

// Matches a whole emoji as one unit — a base pictograph plus an optional
// skin-tone modifier or variation selector (U+FE0F), plus any ZWJ-joined
// (U+200D) continuation — so a skin-toned or gendered emoji counts once
// rather than as several code points.
const EMOJI_SEQUENCE =
  /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\u{FE0F})?(?:\u{200D}\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\u{FE0F})?)*/gu;

// A full stop used as sentence punctuation: a "." right after an
// alphanumeric (or closing bracket) and followed by whitespace or the
// end of the message. Excludes "..." ellipses (the char before the dot
// is itself a dot) and decimals like "3.5" (a digit follows the dot).
const FULL_STOP = /[A-Za-z0-9)][.](?:\s|$)/;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function lengthLabel(avgWords: number): StyleProfile["lengthLabel"] {
  if (avgWords < 4) return "very short";
  if (avgWords < 12) return "short";
  if (avgWords < 28) return "medium";
  return "longer";
}

/**
 * Measure writing style from a set of message texts (one speaker's
 * messages — caller filters by direction). Order does not matter: every
 * metric is an aggregate. Returns null when there are too few samples.
 */
export function analyzeStyle(texts: ReadonlyArray<string>): StyleProfile | null {
  const cleaned = texts
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter((text) => text.length > 0);
  if (cleaned.length < MIN_SAMPLES) return null;

  let totalWords = 0;
  let totalEmoji = 0;
  let fullStopMessages = 0;
  let letterStartMessages = 0;
  let lowercaseStartMessages = 0;
  const emojiCounts = new Map<string, number>();

  for (const text of cleaned) {
    totalWords += text.split(/\s+/).filter(Boolean).length;

    const emojis = text.match(EMOJI_SEQUENCE) ?? [];
    totalEmoji += emojis.length;
    for (const emoji of emojis) {
      emojiCounts.set(emoji, (emojiCounts.get(emoji) ?? 0) + 1);
    }

    if (FULL_STOP.test(text)) fullStopMessages += 1;

    // First Latin letter anywhere in the message — captures the leading
    // letter even when the message opens with an emoji or digit. Other
    // scripts have no case, so they are excluded from the denominator.
    const firstLetter = text.match(/[A-Za-z]/)?.[0];
    if (firstLetter) {
      letterStartMessages += 1;
      if (firstLetter >= "a" && firstLetter <= "z") lowercaseStartMessages += 1;
    }
  }

  const sampleCount = cleaned.length;
  const avgWords = round1(totalWords / sampleCount);
  const topEmojis = [...emojiCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([emoji]) => emoji);

  return {
    sampleCount,
    avgWords,
    lengthLabel: lengthLabel(avgWords),
    emojiPerMessage: round2(totalEmoji / sampleCount),
    topEmojis,
    fullStopRate: round2(fullStopMessages / sampleCount),
    lowercaseRate: letterStartMessages > 0 ? round2(lowercaseStartMessages / letterStartMessages) : 0
  };
}

function lengthClause(profile: StyleProfile): string {
  switch (profile.lengthLabel) {
    case "very short":
      return "very short, terse messages";
    case "short":
      return "short messages";
    case "medium":
      return "medium-length messages";
    case "longer":
      return "longer, multi-sentence messages";
  }
}

// `who` selects verb agreement — "operator" is singular, "they" plural.
function fullStopClause(rate: number, who: "operator" | "contact"): string {
  const operator = who === "operator";
  if (rate < 0.15) {
    return operator
      ? "the operator almost never ends a sentence with a full stop"
      : "they almost never end a sentence with a full stop";
  }
  if (rate < 0.55) {
    return operator
      ? "the operator uses full stops some of the time, not on every message"
      : "they use full stops some of the time, not on every message";
  }
  return operator
    ? "the operator generally closes sentences with full stops"
    : "they generally close sentences with full stops";
}

function emojiPalette(profile: StyleProfile): string {
  return profile.topEmojis.join(" ");
}

/**
 * Render the operator's observed style as a draft-prompt fragment.
 * Empty string when the profile is null so callers can concatenate it
 * unconditionally. Scoped to the four dimensions the feedback named —
 * it does not override the voice prompt's personality, vocabulary, or
 * hard rules (em-dash stripping, sentence-start capitals).
 */
export function describeOperatorStyle(profile: StyleProfile | null | undefined): string {
  if (!profile) return "";
  const lines = [
    `Observed operator style — measured from the operator's own ${profile.sampleCount} most recent messages to THIS contact. Calibrate message length, full-stop use, capitalisation, and emoji to match it. This is how the operator actually writes to this person, so prefer it over generic voice defaults on those four dimensions:`,
    `- Length: the operator writes ${lengthClause(profile)}, around ${profile.avgWords} words on average.`,
    `- Full stops: ${fullStopClause(profile.fullStopRate, "operator")}.`
  ];
  if (profile.lowercaseRate > 0.6) {
    lines.push(
      "- Capitalisation: the operator writes informally in lowercase, including a lowercase \"i\". Keep mid-sentence words and the pronoun lowercase, do not over-capitalise."
    );
  } else if (profile.lowercaseRate > 0.25) {
    lines.push("- Capitalisation: the operator often skips capitals and writes loosely. Keep it relaxed, do not over-capitalise.");
  } else {
    lines.push("- Capitalisation: the operator capitalises normally.");
  }
  if (profile.emojiPerMessage < 0.05 || profile.topEmojis.length === 0) {
    lines.push("- Emoji: the operator does not use emoji here, so do not add any.");
  } else if (profile.emojiPerMessage < 0.4) {
    lines.push(`- Emoji: the operator uses emoji sparingly, drawn from ${emojiPalette(profile)}. At most one, often none.`);
  } else if (profile.emojiPerMessage < 1.2) {
    lines.push(`- Emoji: the operator uses emoji regularly, drawn from ${emojiPalette(profile)}. Stay within that palette.`);
  } else {
    lines.push(`- Emoji: the operator uses emoji heavily, drawn from ${emojiPalette(profile)}. Stay within that palette.`);
  }
  return lines.join("\n");
}

/**
 * Render the contact's observed style as a draft-prompt fragment. Used
 * to reinforce the system prompt's reciprocity rule with concrete
 * numbers — mirror their length and formality, do not overshoot.
 */
export function describeContactStyle(profile: StyleProfile | null | undefined): string {
  if (!profile) return "";
  const lines = [
    `Observed contact style — measured from the contact's own ${profile.sampleCount} most recent messages. Mirror their length and formality, match it rather than overshoot:`,
    `- Length: they write ${lengthClause(profile)}, around ${profile.avgWords} words on average.`,
    `- Full stops: ${fullStopClause(profile.fullStopRate, "contact")}.`
  ];
  if (profile.lowercaseRate > 0.6) {
    lines.push("- Capitalisation: they write informally in lowercase.");
  } else if (profile.lowercaseRate > 0.25) {
    lines.push("- Capitalisation: they often skip capitals.");
  } else {
    lines.push("- Capitalisation: they capitalise normally.");
  }
  if (profile.emojiPerMessage < 0.05 || profile.topEmojis.length === 0) {
    lines.push("- Emoji: they do not use emoji here.");
  } else if (profile.emojiPerMessage < 0.4) {
    lines.push(`- Emoji: they use emoji sparingly (${emojiPalette(profile)}).`);
  } else {
    lines.push(`- Emoji: they use emoji regularly (${emojiPalette(profile)}).`);
  }
  return lines.join("\n");
}

/**
 * Stable fingerprint of both style profiles for cache-key inclusion.
 * Built from the rendered fragments themselves, so the suggested-replies
 * cache invalidates exactly when the style guidance the model sees would
 * change — and not on message edits that leave every bucket unmoved.
 */
export function styleFingerprint(
  operatorStyle: StyleProfile | null | undefined,
  contactStyle: StyleProfile | null | undefined
): string {
  return `${describeOperatorStyle(operatorStyle)}##${describeContactStyle(contactStyle)}`;
}
