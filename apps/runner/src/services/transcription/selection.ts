/**
 * Pure transcript selector for the progressive pipeline.
 *
 * The transcription service writes one row per tier into
 * `MessageAudioTranscriptionAttempt` plus a single
 * `MessageAudioTranscription.transcript` that the rest of the app
 * reads. The selection rule is:
 *
 *   1. If GPT-5-nano refinement produced a sanitised
 *      `correctedTranscript`, pick that.
 *   2. Otherwise pick the highest-tier successful local attempt:
 *      max → standard → fast.
 *   3. Never pick a failed, skipped, or empty attempt.
 *   4. Never downgrade from a higher tier to a lower one — the
 *      orchestrator calls this after each new attempt; if the new
 *      attempt is lower-tier or empty the selector returns the
 *      previous selection unchanged.
 *
 * Extracted as a pure function so the never-downgrade rule is
 * unit-testable independently of prisma and the OpenAI client.
 */

export type AttemptTier = "fast" | "standard" | "max" | "refinement";

export interface Attempt {
  tier: AttemptTier;
  model: string;
  provider: string; // "local-whisper" | "openai-text-refiner"
  status: string; // "transcribed" | "failed" | "skipped" | "pending"
  transcript: string | null;
}

export interface SelectedTranscript {
  tier: AttemptTier;
  model: string;
  provider: string;
  transcript: string;
}

export const TIER_RANK: Record<AttemptTier, number> = {
  fast: 1,
  standard: 2,
  max: 3,
  refinement: 4
};

/**
 * Pick the best transcript out of an attempt list. Returns `null` when
 * no attempt is usable.
 *
 * Refinement, when present and valid, always wins. Otherwise the
 * highest-tier successful local attempt wins.
 */
export function selectBestTranscript(attempts: Attempt[]): SelectedTranscript | null {
  let best: SelectedTranscript | null = null;
  let bestRank = -1;
  for (const a of attempts) {
    if (a.status !== "transcribed") continue;
    const text = a.transcript?.trim();
    if (!text) continue;
    const rank = TIER_RANK[a.tier];
    if (rank === undefined) continue;
    if (rank > bestRank) {
      bestRank = rank;
      best = {
        tier: a.tier,
        model: a.model,
        provider: a.provider,
        transcript: text
      };
    }
  }
  return best;
}

/**
 * Decide whether a new candidate selection should replace the current
 * one. Used by the orchestrator to avoid writing to
 * `MessageAudioTranscription.transcript` when the new attempt would be
 * a downgrade.
 *
 * Returns the chosen selection, or null when neither is usable.
 */
export function pickHigherTier(
  current: SelectedTranscript | null,
  candidate: SelectedTranscript | null
): SelectedTranscript | null {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentRank = TIER_RANK[current.tier] ?? -1;
  const candidateRank = TIER_RANK[candidate.tier] ?? -1;
  return candidateRank > currentRank ? candidate : current;
}
