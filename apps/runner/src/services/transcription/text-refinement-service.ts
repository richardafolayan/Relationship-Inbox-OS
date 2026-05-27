/**
 * Patch-based text refinement of local Whisper transcripts.
 *
 * Design (#386): the refiner is a *reviewer*, not a generator. It does
 * NOT emit a whole transcript; it emits a short list of substring
 * patches to apply against the highest-tier local transcript. The
 * orchestrator (transcription-service.ts) verifies each patch's `from`
 * exists in the base, drops low-confidence patches, and runs three
 * post-apply guards (duplicate, shrink, drift) before selecting the
 * patched text. Anything the model doesn't justify in a patch can't
 * appear in the output.
 *
 * Cost-safety invariants enforced by the orchestrator (not this file):
 *   1. Refinement never runs unless at least the `standard` local tier
 *      has succeeded.
 *   2. Refinement never receives audio. This service is text-to-text.
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
  /**
   * All local attempts that produced non-empty transcripts. The first
   * entry is the lowest-tier attempt; the LAST entry is the
   * highest-tier and is treated as the authoritative base by the
   * orchestrator. The refiner sees all of them — lower tiers are
   * evidence only, never content sources.
   */
  attempts: RefinementAttempt[];
  /** Thread context. The orchestrator already filtered system events. */
  nearbyMessages: RefinementNearbyMessage[];
}

/**
 * Patch type classification. Stored on the row so we can audit later
 * which categories of correction the operator opted in to.
 */
export type PatchType =
  | "asr_word_error"
  | "name_fix"
  | "obvious_context_fix"
  | "casing_only";

export type PatchConfidence = "low" | "medium" | "high";

export interface RefinementPatch {
  /** Exact substring of the base (highest-tier) transcript. */
  from: string;
  /** Replacement text. */
  to: string;
  type: PatchType;
  confidence: PatchConfidence;
  /** One short sentence justifying the patch. */
  evidence: string;
}

export interface RefinementSuccess {
  /** Echoed model id (e.g. "gpt-5-nano"). */
  model: string;
  /** Echo of which local model the refiner treated as the base. */
  baseModel: string;
  /** Sanitised patch list (low-confidence and malformed already dropped). */
  corrections: RefinementPatch[];
  /** Phrases the refiner is uncertain about but didn't propose a patch for. */
  uncertainPhrases: string[];
  /**
   * Optional self-reject signal from the refiner. When set, the
   * orchestrator skips patch application and keeps the base verbatim.
   * Surfaced for debugging only — the orchestrator's own guards are
   * the authoritative gate.
   */
  rejectReason: string | null;
  /**
   * Full sanitised payload re-stringified, stored on
   * `MessageAudioTranscription.refinementJson` so we can audit what
   * the refiner returned without re-issuing the call.
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
 * Build the patch-based refinement service. When `client` is null the
 * service short-circuits to a stable `refinement_no_client` skip.
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
        return { kind: "failed", errorMessage: shortenError(error) };
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

/**
 * System prompt: the refiner is a patch reviewer. Concrete green-light
 * examples are included so the model knows the kind of single-word
 * fix it's expected to make, while the absolute preservation rules
 * keep it from drifting back into "improving" prose.
 */
const DEFAULT_SYSTEM_PROMPT = `You are reviewing a transcript produced by Whisper. You will be given several competing Whisper transcripts of the same voice note. The HIGHEST-TIER transcript is the base. You are not rewriting it. You are not improving style. You are not removing filler. You are not merging lower-tier text into it.

Your only job is to propose exact substring replacements (patches) for likely ASR errors in the base transcript.

Return JSON patches only. If there are no safe corrections, return an empty corrections array.

A correction is safe only if ALL of these hold:
- the base substring is probably an ASR mistake
- the replacement is strongly supported by another transcript, by nearby conversation context, or by the phrase itself
- the correction does not remove filler, hesitation, repetition, slang, or rough speech
- the correction does not add facts not present in the transcripts or context

Do not correct grammar. Do not polish punctuation. Do not shorten. Do not summarise. Do not merge content from lower-tier transcripts into the base unless context strongly supports it as a missing word the highest-tier dropped.

CONCRETE EXAMPLES of safe corrections you SHOULD propose when the context supports them:
- "future" -> "food shop" (when the surrounding sentence is clearly about meal planning or shopping for ingredients)
- "good just" -> "God just" (when the surrounding context is about theology)
- "this place is getting long" -> "this voice note is getting long" (at the end of a voice note, referring to the recording itself)
- "ill" -> "I'll", "im" -> "I'm" — only when context makes the intent obvious
- name spelling fixes, when a nearby message uses the correct spelling

What you MUST NOT do:
- Return a whole new transcript.
- Merge in clauses from lower-tier transcripts that the highest-tier doesn't have.
- Change tense, person, or sentence structure.
- "Tidy up" run-on sentences.
- Remove duplicates the speaker actually said.

OUTPUT FORMAT (JSON only):
{
  "baseModel": string,
  "corrections": Array<{
    "from": string,
    "to": string,
    "type": "asr_word_error" | "name_fix" | "obvious_context_fix" | "casing_only",
    "confidence": "low" | "medium" | "high",
    "evidence": string
  }>,
  "uncertainPhrases": string[],
  "rejectReason": string | null
}

Each "from" MUST be an exact substring of the highest-tier transcript. The application code will verify this before applying. If you cannot find a safe substring boundary for a correction, omit it.

If after reviewing the transcripts you don't see any safe corrections, return:
{
  "baseModel": "<echo>",
  "corrections": [],
  "uncertainPhrases": [],
  "rejectReason": null
}`;

/**
 * Build the user prompt. The highest-tier attempt is labelled
 * explicitly as the BASE; lower tiers are labelled as evidence.
 * Exposed for tests so they can assert the shape.
 */
export function buildUserPrompt(context: RefinementContext): string {
  const lines: string[] = [];
  lines.push(`Voice message metadata:`);
  lines.push(`- direction: ${context.direction}`);
  lines.push(`- speaker: ${context.speakerRole}`);
  lines.push(``);

  // The orchestrator orders attempts low → high; pull the last as
  // the base. If only one attempt exists it's both base and only.
  const last = context.attempts[context.attempts.length - 1];
  const others = context.attempts.slice(0, -1);
  if (!last) {
    // Defensive: refine() short-circuits on empty attempts, but
    // keep this branch for tests that build a context by hand.
    lines.push(`No local transcripts available.`);
    return lines.join("\n");
  }

  lines.push(`BASE (highest-tier — this is the authoritative transcript; propose patches against this exact text):`);
  lines.push(`--- tier=${last.tier} model=${last.model}`);
  lines.push(last.transcript.trim());
  lines.push(``);

  if (others.length > 0) {
    lines.push(`OTHER ATTEMPTS (evidence only — do NOT merge their content into the base):`);
    for (const attempt of others) {
      lines.push(`--- tier=${attempt.tier} model=${attempt.model}`);
      lines.push(attempt.transcript.trim());
    }
    lines.push(``);
  }

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
  lines.push(
    `Return JSON only. Each "from" must be an exact substring of the BASE transcript. If you have no safe corrections, return an empty corrections array.`
  );
  return lines.join("\n");
}

type Parsed =
  | { kind: "ok"; result: Omit<RefinementSuccess, "model"> }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; errorMessage: string };

/**
 * Parse + sanitise the refiner's JSON response. The orchestrator does
 * the harder guards (duplicate-introduction, drift detection) AFTER
 * applying patches, because those need to see the base text. This
 * function only validates structure and drops obviously-malformed
 * patches (missing `from`, etc.).
 */
export function parseAndSanitise(rawContent: string, context: RefinementContext): Parsed {
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

  const baseModel =
    typeof obj.baseModel === "string" && obj.baseModel.trim().length > 0
      ? obj.baseModel.trim()
      : (context.attempts[context.attempts.length - 1]?.model ?? "");

  const rejectReason =
    typeof obj.rejectReason === "string" && obj.rejectReason.trim().length > 0
      ? stripDashes(obj.rejectReason.trim()).slice(0, 200)
      : null;

  // Patches: validate shape, drop malformed entries, cap at 20.
  const corrections: RefinementPatch[] = [];
  const rawCorrections = Array.isArray(obj.corrections) ? obj.corrections : [];
  for (const entry of rawCorrections) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const from = typeof e.from === "string" ? e.from : "";
    const to = typeof e.to === "string" ? e.to : "";
    if (from.length === 0) continue;
    // Drop patches whose `from` and `to` are identical — no-op.
    if (from === to) continue;
    // Validate against allowed enums; default to safest values.
    const type = (
      e.type === "name_fix" || e.type === "obvious_context_fix" || e.type === "casing_only"
        ? e.type
        : "asr_word_error"
    ) as PatchType;
    const confidence = (
      e.confidence === "low" || e.confidence === "high" ? e.confidence : "medium"
    ) as PatchConfidence;
    const evidence =
      typeof e.evidence === "string"
        ? stripDashes(e.evidence.trim()).slice(0, 300)
        : "";
    corrections.push({
      from: from.slice(0, 500),
      to: stripDashes(to.slice(0, 500)),
      type,
      confidence,
      evidence
    });
    if (corrections.length >= 20) break;
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
    baseModel,
    corrections,
    uncertainPhrases,
    rejectReason,
    rawJson: JSON.stringify({
      baseModel,
      corrections,
      uncertainPhrases,
      rejectReason
    })
  };
  return { kind: "ok", result: sanitised };
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
