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

const DEFAULT_SYSTEM_PROMPT = `You are correcting an automatic speech recognition transcript. You are not rewriting the speaker. Preserve the speaker's words, slang, hesitations, filler, tone, and rough phrasing. Only correct likely transcription errors when the competing transcripts or surrounding conversation make the correction strongly supported.

Rules:
- Do not summarise.
- Do not make the transcript sound polished.
- Do not remove meaningful filler if it changes the speaker's style.
- Do not add facts not present in the transcripts/context.
- Preserve uncertainty.
- Prefer the local transcript if unsure.
- Use nearby conversation context only to resolve likely ASR mistakes, names, and obvious homophones.
- Keep British English spelling where relevant.
- Output JSON only.

Required JSON shape:
{
  "correctedTranscript": string,
  "confidence": "low" | "medium" | "high",
  "changesMade": Array<{ "from": string, "to": string, "reason": string }>,
  "uncertainPhrases": string[]
}`;

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
  // than the best local attempt. The exception is when the local
  // attempt has heavy repetition that the refiner has trimmed —
  // approximated by checking that >70% of corrected tokens appear in
  // the local one AND the corrected text is still substantial
  // (at least 40% of the local length OR at least 50 chars). Without
  // that floor a single-word corrected transcript that happens to
  // appear in the local would slip through.
  const bestLocal = context.attempts[context.attempts.length - 1]?.transcript?.trim() ?? "";
  if (bestLocal.length > 0) {
    const correctedLength = corrected.length;
    const bestLocalLength = bestLocal.length;
    const shrinkRatio = correctedLength / bestLocalLength;
    if (shrinkRatio < 0.75) {
      const correctedSubstantial =
        correctedLength >= 50 || shrinkRatio >= 0.4;
      const localTokens = new Set(tokenise(bestLocal));
      const correctedTokens = tokenise(corrected);
      const overlap = correctedTokens.filter((t) => localTokens.has(t)).length;
      const overlapRatio = overlap / Math.max(correctedTokens.length, 1);
      if (!correctedSubstantial || overlapRatio < 0.7) {
        return { kind: "skipped", reason: "refinement_too_short" };
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
