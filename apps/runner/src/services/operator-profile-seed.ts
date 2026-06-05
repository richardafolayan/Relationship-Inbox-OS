// Local operator-profile seeding helpers.
//
// A developer can keep a personal `operator-profile.seed.json` next to the
// runner's package.json (gitignored — see operator-profile.seed.example.json
// for the shape). `scripts/seed-operator-profile.ts` loads it and writes it
// into the `operator_profile_v1` Setting row, but ONLY when the stored
// profile is still empty or a placeholder/test profile.
//
// This keeps personal voice data out of source control and out of the app's
// neutral defaults: new users always start with a blank profile and set up
// their own voice. Nothing here hardcodes any individual.
//
// Framework-free and side-effect-free so it can be unit-tested directly.

import type { AiHelpLevel, OperatorProfile, ReplyStyle } from "../types/runtime";

const REPLY_STYLES: ReplyStyle[] = ["warm", "direct", "casual", "thoughtful", "concise"];
const AI_HELP_LEVELS: AiHelpLevel[] = ["memory_only", "writing_support", "full_drafts"];
const DEFAULT_AI_HELP_LEVEL: AiHelpLevel = "writing_support";

/**
 * Display names that only ever belong to a throwaway test/demo profile.
 * Used to recognise a placeholder profile that is safe to overwrite. This
 * is a heuristic for the local seeder, not product copy.
 */
export const PLACEHOLDER_DISPLAY_NAMES = [
  "sam",
  "test",
  "tester",
  "demo",
  "example",
  "placeholder"
];

export type OperatorProfileClass = "empty" | "placeholder" | "real";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Classify a stored operator profile so the seeder knows whether it is
 * safe to overwrite. A "real" profile is never replaced without `force`.
 */
export function classifyOperatorProfile(profile: OperatorProfile): OperatorProfileClass {
  const filled = [
    profile.displayName,
    profile.about,
    profile.interests,
    profile.commonPhrases,
    profile.avoidedPhrases
  ].map((value) => str(value).trim());

  if (filled.every((value) => value === "") && !str(profile.preferredStyle)) {
    return "empty";
  }

  const name = str(profile.displayName).trim().toLowerCase();
  const about = str(profile.about).toLowerCase();
  const looksLikeTest =
    PLACEHOLDER_DISPLAY_NAMES.includes(name) ||
    /\btest(ing|er)?\b/.test(about) ||
    /\bplaceholder\b/.test(about) ||
    /\bdemo\b/.test(about);

  return looksLikeTest ? "placeholder" : "real";
}

/**
 * Whether the seeder should write the seed profile over `current`.
 * Empty and placeholder profiles are replaced; a real profile is left
 * alone unless the caller explicitly forces it.
 */
export function shouldSeedOperatorProfile(
  current: OperatorProfile,
  options?: { force?: boolean }
): boolean {
  if (options?.force) return true;
  return classifyOperatorProfile(current) !== "real";
}

/**
 * Coerce a hand-edited seed JSON object into a complete, valid
 * OperatorProfile. Unknown / invalid enum values fall back to defaults;
 * `setupCompletedAt` is stamped via `now()` when the seed leaves it blank,
 * so the first-run setup card does not reappear after seeding.
 */
export function normaliseSeedProfile(
  raw: unknown,
  now: () => string = () => new Date().toISOString()
): OperatorProfile {
  const seed = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const preferredStyle = str(seed.preferredStyle);
  const aiHelpLevel = str(seed.aiHelpLevel);
  const setupCompletedAt = str(seed.setupCompletedAt).trim();

  return {
    displayName: str(seed.displayName),
    about: str(seed.about),
    interests: str(seed.interests),
    commonPhrases: str(seed.commonPhrases),
    avoidedPhrases: str(seed.avoidedPhrases),
    preferredStyle: (REPLY_STYLES as string[]).includes(preferredStyle)
      ? (preferredStyle as ReplyStyle)
      : "",
    aiHelpLevel: (AI_HELP_LEVELS as string[]).includes(aiHelpLevel)
      ? (aiHelpLevel as AiHelpLevel)
      : DEFAULT_AI_HELP_LEVEL,
    setupCompletedAt: setupCompletedAt || now()
  };
}
