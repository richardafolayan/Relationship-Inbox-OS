/**
 * Optional text-only refinement of local Whisper transcripts.
 *
 * The pipeline first produces one-to-three local-whisper attempts per
 * voice note (fast → standard → max). When the operator opts in to
 * refinement (env: AUDIO_TRANSCRIPTION_REFINEMENT_ENABLED=true), this
 * service sends ONLY the resulting text — never the audio bytes — to a
 * cheap chat model (default gpt-5-nano) along with nearby thread
 * messages, and asks it to correct likely ASR mistakes. Output is
 * post-parse sanitised so a runaway refinement can't quietly replace a
 * good local transcript with hallucinated content.
 *
 * Cost-safety invariants enforced by the orchestrator (not this file):
 *   1. Refinement never runs unless at least the `standard` local tier
 *      has succeeded.
 *   2. Refinement never receives audio. Audio transcription is the
 *      local-whisper provider's job; this service is text→text only.
 *   3. The OpenAI client is constructed only when an `OPENAI_API_KEY`
 *      is present — the runner passes `client=null` otherwise and
 *      `refine` short-circuits with a stable skip reason.
 */

import type OpenAI from "openai";

/** Tier name, mirrors transcription-service.ts. */
export type RefinementTier = "fast" | "standard" | "max";

export interface RefinementAttempt {
  tier: RefinementTier;
  /** ggml model basename for local tiers, e.g. "ggml-small.en.bin". */
  model: string;
  transcript: string;
  /** Wall-clock duration of the local attempt, when known. */
  durationMs?: number | null;
}

export interface RefinementNearbyMessage {
  /** "IN" = from contact, "OUT" = from operator. */
  direction: "IN" | "OUT";
  /**
   * ISO timestamp or short formatted time. The model only uses this for
   * sequencing, not for arithmetic, so the format is flexible.
   */
  timestamp: string;
  /** Whatever short text we have for this message. */
  text: string;
}

export interface RefinementContext {
  messageId: string;
  threadId: string;
  /** Direction of the voice note itself. */
  direction: "IN" | "OUT";
  /** Speaker role of the voice note. */
  speakerRole: "contact" | "operator";
  /** All local attempts that produced non-empty transcripts. */
  attempts: RefinementAttempt[];
  /** Thread context. The orchestrator already filtered system events. */
  nearbyMessages: RefinementNearbyMessage[];
}

export interface RefinementSuccess {
  /** The refiner's corrected transcript, after sanitisation. */
  correctedTranscript: string;
  confidence: "low" | "medium" | "high";
  changesMade: Array<{ from: string; to: string; reason: string }>;
  uncertainPhrases: string[];
  /** Echoed model id (e.g. "gpt-5-nano"). */
  model: string;
  /**
   * The full sanitised payload re-stringified, for storage on
   * `MessageAudioTranscription.refinementJson` so we can debug later
   * without re-issuing the call.
   */
  rawJson: string;
}

export type RefinementOutcome =
  | { kind: "ok"; result: RefinementSuccess }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; errorMessage: string };

export interface TextRefinementService {
  refine(context: RefinementContext): Promise<RefinementOutcome>;
}

/**
 * Minimal subset of the OpenAI client we actually use. Stated as an
 * interface so tests can pass a plain object instead of mocking the
 * whole SDK surface.
 */
export interface ChatCompletionsClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        response_format?: { type: "json_object" };
      }): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

export interface RefinementServiceConfig {
  model: string;
  timeoutMs: number;
  /** Optional override of the system prompt, useful for tests. */
  systemPromptOverride?: string;
}

/**
 * Build the refinement service. Returns `null` from `refine` (via a
 * stable skip reason) when `client` is null so the caller never has to
 * gate on auth state itself.
 */
export function createTextRefinementService(input: {
  client: ChatCompletionsClient | null;
  config: RefinementServiceConfig;
}): TextRefinementService {
  const { client, config } = input;

  return {
    async refine(context) {
      if (!client) {
        return { kind: "skipped", reason: "refinement_no_client" };
      }
      if (context.attempts.length === 0) {
        // Belt-and-braces: the orchestrator should never call us with an
        // empty attempt list, but if it does we silently skip rather
        // than spend a token call on nothing.
        return { kind: "skipped", reason: "refinement_no_attempts" };
      }

      const systemPrompt = config.systemPromptOverride ?? DEFAULT_SYSTEM_PROMPT;
      const userPrompt = buildUserPrompt(context);

      let response;
      try {
        response = await withTimeout(
          client.chat.completions.create({
            model: config.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            response_format: { type: "json_object" }
          }),
          config.timeoutMs,
          "refinement_timeout"
        );
      } catch (error) {
        if (error instanceof Error && error.message === "refinement_timeout") {
          return { kind: "failed", errorMessage: "refinement_timeout" };
        }
        return {
          kind: "failed",
          errorMessage: shortenError(error)
        };
      }

      const raw = response.choices?.[0]?.message?.content ?? "";
      const parsed = parseAndSanitise(raw, context);
      if (parsed.kind === "skipped" || parsed.kind === "failed") return parsed;
      return {
        kind: "ok",
        result: { ...parsed.result, model: config.model }
      };
    }
  };
}

const DEFAULT_SYSTEM_PROMPT = `You are correcting an automatic speech recognition transcript. You are NOT rewriting the speaker. You are NOT polishing the prose. You are NOT summarising. Your only job is to fix specific likely ASR mistakes.

You will receive multiple competing local Whisper transcripts of the same audio plus nearby conversation context. The HIGHEST-TIER transcript is the most accurate; treat it as the ground truth for what was actually said. Use the others only to spot ambiguous moments where the models disagree.

ABSOLUTE PRESERVATION RULES — these are non-negotiable:
- Preserve all hesitations, filler ("um", "uh", "like", "you know"), repetitions, false starts, run-on sentences, and rough phrasing exactly as the highest-tier transcript has them.
- Preserve the speaker's slang, casualness, and any awkward grammar.
- Preserve any phrase that appears across two or more of the local transcripts — that's strong evidence the speaker actually said it, even if it reads as redundant or repetitive.
- Do NOT collapse repeated phrases for readability. If the speaker said "a serious food shop like I used to do" and that appears in 2+ local transcripts, keep it.
- Do NOT shorten the transcript. Word count should be within a few percent of the highest-tier local transcript.
- Do NOT add punctuation, capitalisation, or sentence breaks beyond what's already there.
- Do NOT add words or facts that don't appear in the local transcripts or nearby messages.

WHAT YOU CAN CHANGE:
- A clear ASR error where one local model heard one word ("future") and another heard a different word ("food shop") and the conversational context makes one of them obviously correct.
- A homophone or near-homophone fix (e.g. "god" vs "good") supported by the surrounding messages.
- A name that one model spelled incorrectly when context makes the right spelling clear.

WHEN IN DOUBT:
- Prefer the highest-tier local transcript verbatim.
- Set confidence to "low" and leave changesMade empty.

OUTPUT FORMAT:
Output JSON only. Required shape:
{
  "correctedTranscript": string,
  "confidence": "low" | "medium" | "high",
  "changesMade": Array<{ "from": string, "to": string, "reason": string }>,
  "uncertainPhrases": string[]
}

Every entry in changesMade must correspond to an actual word-level change you made. If you didn't change anything, return the highest-tier local transcript verbatim and an empty changesMade array.`;

/**
 * Build the user prompt. Exposed for tests so they can assert the
 * model sees the attempts + context in the expected shape.
 */
export function buildUserPrompt(context: RefinementContext): string {
  const lines: string[] = [];
  lines.push(`Voice message metadata:`);
  lines.push(`- direction: ${context.direction}`);
  lines.push(`- speaker: ${context.speakerRole}`);
  lines.push(``);
  lines.push(`Local Whisper transcript attempts (best last):`);
  for (const attempt of context.attempts) {
    lines.push(`--- tier=${attempt.tier} model=${attempt.model}`);
    lines.push(attempt.transcript.trim());
  }
  lines.push(``);
  if (context.nearbyMessages.length > 0) {
    lines.push(`Nearby thread messages:`);
    for (const m of context.nearbyMessages) {
      const who = m.direction === "OUT" ? "operator" : "contact";
      const text = m.text.trim();
      if (text.length === 0) continue;
      lines.push(`[${m.timestamp}] ${who}: ${text}`);
    }
  } else {
    lines.push(`Nearby thread messages: (none)`);
  }
  lines.push(``);
  lines.push(`Return JSON only. Prefer the highest-tier local transcript if uncertain.`);
  return lines.join("\n");
}

type Parsed =
  | { kind: "ok"; result: Omit<RefinementSuccess, "model"> }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; errorMessage: string };

/**
 * Post-parse sanitiser. Enforces the cost-safety + hallucination
 * guards described in the system prompt. Exposed for tests so they
 * can hit each branch with a hand-crafted JSON payload.
 */
export function parseAndSanitise(
  rawContent: string,
  context: RefinementContext
): Parsed {
  if (!rawContent || rawContent.trim().length === 0) {
    return { kind: "skipped", reason: "refinement_empty_response" };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch {
    return { kind: "skipped", reason: "refinement_invalid_json" };
  }
  if (!parsedJson || typeof parsedJson !== "object") {
    return { kind: "skipped", reason: "refinement_invalid_json" };
  }
  const obj = parsedJson as Record<string, unknown>;
  const corrected =
    typeof obj.correctedTranscript === "string" ? obj.correctedTranscript.trim() : "";
  if (corrected.length === 0) {
    return { kind: "skipped", reason: "refinement_empty_transcript" };
  }
  // Guard 1: corrected transcript must not be drastically shorter
  // than the best local attempt. With the tightened system prompt the
  // refiner shouldn't shrink at all, so the floor is intentionally
  // strict: ANY shrink under 88% of the highest-tier local is
  // treated as the refiner rewriting style, not fixing ASR. The old
  // "duplicate trimming is fine" exception is removed because we
  // explicitly tell the model in the system prompt NOT to collapse
  // repeated phrases.
  const bestLocal = context.attempts[context.attempts.length - 1]?.transcript?.trim() ?? "";
  if (bestLocal.length > 0) {
    const shrinkRatio = corrected.length / bestLocal.length;
    if (shrinkRatio < 0.88) {
      return { kind: "skipped", reason: "refinement_too_short" };
    }
  }

  // Guard 2: consensus phrase drops. A 3-gram (sequence of three
  // adjacent ≥3-char tokens) that appears in TWO OR MORE local
  // transcripts is strong evidence the speaker actually said it.
  //
  // We don't reject on the *count* of missing consensus grams
  // (homophone fixes legitimately drop 1-2 grams clustered around the
  // changed word). Instead we look for a RUN: ≥4 consecutive
  // positions in the highest-tier local transcript where every
  // consensus 3-gram is missing from the corrected output. A run
  // that long can only come from removing a contiguous chunk of
  // speech the speaker actually said, not from fixing an ASR error.
  //
  // For the Lanre regression — "a serious food shop like i used to
  // do" cut from the corrected text — the missing 3-grams form a run
  // of 7+ positions and the guard fires. A two-word homophone fix
  // produces a missing run of length 2 and slips through cleanly.
  if (context.attempts.length >= 2) {
    const consensusGrams = computeConsensus3grams(context.attempts);
    if (consensusGrams.size > 0) {
      const highestTokens = tokenise(bestLocal);
      const correctedGramsSet = new Set(buildTokenNgrams(tokenise(corrected), 3));
      let currentRun = 0;
      let longestRun = 0;
      for (let i = 0; i + 3 <= highestTokens.length; i += 1) {
        const gram = highestTokens.slice(i, i + 3).join("|");
        if (!consensusGrams.has(gram)) {
          currentRun = 0;
          continue;
        }
        if (correctedGramsSet.has(gram)) {
          currentRun = 0;
        } else {
          currentRun += 1;
          if (currentRun > longestRun) longestRun = currentRun;
        }
      }
      if (longestRun >= 4) {
        return { kind: "skipped", reason: "refinement_dropped_consensus_phrases" };
      }
    }
  }
  // Guard 2: corrected transcript must not introduce content that
  // doesn't appear in ANY local attempt OR the nearby messages. We
  // approximate "doesn't appear" by token-overlap.
  const haystackTokens = new Set<string>();
  for (const attempt of context.attempts) {
    tokenise(attempt.transcript).forEach((t) => haystackTokens.add(t));
  }
  for (const m of context.nearbyMessages) {
    tokenise(m.text).forEach((t) => haystackTokens.add(t));
  }
  if (haystackTokens.size > 0) {
    const correctedTokens = tokenise(corrected);
    const novel = correctedTokens.filter((t) => !haystackTokens.has(t)).length;
    const novelRatio = novel / Math.max(correctedTokens.length, 1);
    if (novelRatio > 0.4) {
      // More than 40% of tokens come from neither the local
      // transcripts nor the nearby messages — that's the signature of
      // a hallucinated rewrite. Drop the refinement and let the
      // selector keep the local transcript.
      return { kind: "skipped", reason: "refinement_hallucinated" };
    }
  }

  const confidence: "low" | "medium" | "high" =
    obj.confidence === "high" ? "high" : obj.confidence === "low" ? "low" : "medium";

  // Cap arrays so a chatty model can't bloat the row size.
  let changesMade: Array<{ from: string; to: string; reason: string }> = [];
  if (Array.isArray(obj.changesMade)) {
    changesMade = obj.changesMade
      .filter(
        (entry): entry is { from: unknown; to: unknown; reason: unknown } =>
          entry !== null && typeof entry === "object"
      )
      .map((entry) => ({
        from: stripDashes(String(entry.from ?? "").slice(0, 200)),
        to: stripDashes(String(entry.to ?? "").slice(0, 200)),
        reason: stripDashes(String(entry.reason ?? "").slice(0, 200))
      }))
      .filter((entry) => entry.from.length > 0 || entry.to.length > 0)
      .slice(0, 10);
  }
  let uncertainPhrases: string[] = [];
  if (Array.isArray(obj.uncertainPhrases)) {
    uncertainPhrases = obj.uncertainPhrases
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => stripDashes(entry.slice(0, 200)))
      .filter((entry) => entry.length > 0)
      .slice(0, 10);
  }

  const sanitised: Omit<RefinementSuccess, "model"> = {
    correctedTranscript: stripDashes(corrected),
    confidence,
    changesMade,
    uncertainPhrases,
    rawJson: JSON.stringify({
      correctedTranscript: stripDashes(corrected),
      confidence,
      changesMade,
      uncertainPhrases
    })
  };

  return { kind: "ok", result: sanitised };
}

/** Tokenise on word boundaries and lowercase. */
function tokenise(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3); // ignore very short filler / stopwords
}

/**
 * Build all overlapping n-grams from a token stream as
 * pipe-separated strings (so they're cheap to put in a Set).
 * Returns an empty array when the input is shorter than `n`.
 */
function buildTokenNgrams(tokens: string[], n: number): string[] {
  if (tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) {
    out.push(tokens.slice(i, i + n).join("|"));
  }
  return out;
}

/**
 * Find every 3-gram that appears in TWO OR MORE of the local
 * transcripts. These are the speaker's actual phrases — at least
 * two independent ASR models agreed on them — so the refiner must
 * preserve them. Dropping these is the signature of a stylistic
 * rewrite, which is what the sanitiser rejects.
 */
function computeConsensus3grams(
  attempts: ReadonlyArray<{ transcript: string }>
): Set<string> {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    const tokens = tokenise(attempt.transcript);
    const seenInThisAttempt = new Set<string>();
    for (const gram of buildTokenNgrams(tokens, 3)) {
      // Count each gram at most once per attempt so a transcript that
      // genuinely repeats a phrase doesn't inflate the consensus
      // count by itself.
      if (seenInThisAttempt.has(gram)) continue;
      seenInThisAttempt.add(gram);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [gram, count] of counts) {
    if (count >= 2) out.add(gram);
  }
  return out;
}

/**
 * Strip em / en dashes (project rule: no em dashes in user-facing
 * copy). Replace with a comma + space so the prose still reads.
 */
function stripDashes(input: string): string {
  return input.replace(/[—–]/g, ", ");
}

function shortenError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutLabel: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutLabel)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
