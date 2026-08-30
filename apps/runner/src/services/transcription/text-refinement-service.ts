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

/** Category for a single proposed substring correction. */
export type RefinementPatchType =
  | "asr_word_error"
  | "name_fix"
  | "obvious_context_fix"
  | "casing_only";

/**
 * One proposed substring replacement against the authoritative base
 * transcript. The model only ever proposes these; the app verifies
 * each `from` exists in the base and splices the approved ones in
 * deterministically (see {@link parseAndSanitise}).
 */
export interface RefinementCorrection {
  /** Exact substring of the base transcript to replace. */
  from: string;
  /** Replacement text. */
  to: string;
  type: RefinementPatchType;
  confidence: "low" | "medium" | "high";
  /** One short sentence justifying the patch. */
  evidence: string;
}

export interface TextRefinementService {
  refine(
    context: RefinementContext,
    shouldContinue?: () => boolean
  ): Promise<RefinementOutcome>;
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
  canDispatch?: () => Promise<boolean>;
  config: RefinementServiceConfig;
}): TextRefinementService {
  const { client, config } = input;

  return {
    async refine(context, shouldContinue = () => true) {
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
        if (!shouldContinue()) {
          return { kind: "skipped", reason: "refinement_not_allowed" };
        }
        const dispatchAllowed = input.canDispatch
          ? await input.canDispatch()
          : true;
        if (!dispatchAllowed || !shouldContinue()) {
          return { kind: "skipped", reason: "refinement_not_allowed" };
        }
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

const DEFAULT_SYSTEM_PROMPT = `You are reviewing a transcript produced by Whisper. The highest-tier transcript is the base. Do not rewrite it. Do not improve style. Do not remove filler. Do not merge lower-tier text into it.

Your job is only to propose exact substring replacements for likely ASR errors.

Return JSON patches only. If there are no safe corrections, return an empty corrections array.

A correction is safe only if:
- the base substring is probably an ASR mistake
- the replacement is strongly supported by another transcript, nearby conversation context, or the phrase itself
- the correction does not remove filler, hesitation, repetition, slang, or rough speech
- the correction does not add new facts

Do not correct grammar. Do not polish punctuation. Do not shorten. Do not summarise.

Each "from" MUST be copied verbatim from the BASE transcript (character for character, including its existing casing and punctuation) so the app can locate it. If you cannot anchor a fix to an exact base substring, do not propose it. Keep each "from" tight: the few words around the mistake, not a whole sentence.

Green-light examples (only when the surrounding context supports them):
- "future" -> "food shop" when the talk is about meal planning
- "good just" -> "God just" when the talk is about theology
- "this place is getting long" -> "this voice note is getting long" at the end of a voice note about itself
- obvious homophone fixes and name-spelling fixes the context makes clear

If the transcript is too garbled to patch safely, set "rejectReason" to a short explanation and return an empty corrections array.

OUTPUT FORMAT - output JSON only, with exactly this shape:
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
}`;

/**
 * Build the user prompt. Exposed for tests so they can assert the
 * model sees the attempts + context in the expected shape.
 */
export function buildUserPrompt(context: RefinementContext): string {
  const base = pickBaseAttempt(context.attempts);
  const lines: string[] = [];
  lines.push(`Voice message metadata:`);
  lines.push(`- direction: ${context.direction}`);
  lines.push(`- speaker: ${context.speakerRole}`);
  lines.push(``);
  if (base) {
    lines.push(
      `BASE transcript (model=${base.model}, tier=${base.tier}). This is the authoritative text. Anchor every "from" to an exact substring of THIS text:`
    );
    lines.push(base.transcript.trim());
    lines.push(``);
  }
  const others = context.attempts.filter((a) => a !== base);
  if (others.length > 0) {
    lines.push(`Lower-tier transcripts (EVIDENCE ONLY, never copy from these directly):`);
    for (const attempt of others) {
      lines.push(`--- tier=${attempt.tier} model=${attempt.model}`);
      lines.push(attempt.transcript.trim());
    }
    lines.push(``);
  }
  if (context.nearbyMessages.length > 0) {
    lines.push(`Nearby thread messages (context only):`);
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
  lines.push(`Return JSON patches only. If there are no safe corrections, return an empty corrections array.`);
  return lines.join("\n");
}

type Parsed =
  | { kind: "ok"; result: Omit<RefinementSuccess, "model"> }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; errorMessage: string };

const TIER_RANK: Record<RefinementTier, number> = { fast: 1, standard: 2, max: 3 };

/**
 * Pick the authoritative base attempt: highest tier wins, ties broken
 * by the later entry (the orchestrator appends best-last). Null for an
 * empty attempt list.
 */
export function pickBaseAttempt(
  attempts: ReadonlyArray<RefinementAttempt>
): RefinementAttempt | null {
  let best: RefinementAttempt | null = null;
  for (const a of attempts) {
    if (!best || TIER_RANK[a.tier] >= TIER_RANK[best.tier]) best = a;
  }
  return best;
}

const PATCH_TYPES: readonly RefinementPatchType[] = [
  "asr_word_error",
  "name_fix",
  "obvious_context_fix",
  "casing_only"
];

interface AppliedPatch {
  from: string;
  to: string;
  type: RefinementPatchType;
  confidence: "medium" | "high";
  evidence: string;
  /** Span consumed in the base transcript. */
  baseStart: number;
  baseEnd: number;
}

/**
 * Post-parse sanitiser for the PATCH-based refinement contract.
 *
 * The model proposes substring corrections against the highest-tier
 * local transcript (the base). The app, not the model, builds the
 * final string by splicing accepted patches into the base, so the
 * output can only ever differ from the base inside an explicitly
 * approved patch region. Cross-tier merging and silent rewrites are
 * therefore impossible by construction; the guards below catch the
 * residual hazards (a replacement that introduces a duplicate, a net
 * shrink, or a bug in application).
 *
 * Every rejection path returns `kind:"skipped"` (the orchestrator
 * keeps the base verbatim and persists an audit row); `kind:"ok"` is
 * returned only when at least one safe patch survived every guard.
 * Exposed for tests so they can hit each branch with a hand-crafted
 * JSON payload.
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

  const baseAttempt = pickBaseAttempt(context.attempts);
  const base = baseAttempt?.transcript?.trim() ?? "";
  if (base.length === 0) {
    return { kind: "skipped", reason: "refinement_no_base" };
  }

  // The refiner may self-reject the whole pass (e.g. transcript too
  // garbled to patch safely).
  if (typeof obj.rejectReason === "string" && obj.rejectReason.trim().length > 0) {
    return { kind: "skipped", reason: "refinement_self_rejected" };
  }

  const rawCorrections = Array.isArray(obj.corrections) ? obj.corrections : [];
  if (rawCorrections.length === 0) {
    // Nothing to do: the base stands verbatim. The orchestrator still
    // persists a skipped audit row and keeps selectedTier at max.
    return { kind: "skipped", reason: "refinement_no_corrections" };
  }

  const accepted: AppliedPatch[] = [];
  const dropped: Array<{ from: string; reason: string }> = [];
  const consumed: Array<[number, number]> = [];

  for (const entry of rawCorrections) {
    if (!entry || typeof entry !== "object") {
      dropped.push({ from: "", reason: "malformed" });
      continue;
    }
    const c = entry as Record<string, unknown>;
    const from = typeof c.from === "string" ? c.from : "";
    const to = typeof c.to === "string" ? stripDashes(c.to.slice(0, 400)) : "";
    const confidence =
      c.confidence === "high" ? "high" : c.confidence === "medium" ? "medium" : "low";
    const type: RefinementPatchType = PATCH_TYPES.includes(c.type as RefinementPatchType)
      ? (c.type as RefinementPatchType)
      : "asr_word_error";
    const evidence = stripDashes(String(c.evidence ?? "").slice(0, 200));

    if (from.length === 0) {
      dropped.push({ from, reason: "empty_from" });
      continue;
    }
    if (confidence === "low") {
      // Low-confidence patches are dropped, never applied.
      dropped.push({ from, reason: "low_confidence" });
      continue;
    }
    if (from === to) {
      dropped.push({ from, reason: "noop" });
      continue;
    }
    const at = firstFreeOccurrence(base, from, consumed);
    if (at === -1) {
      // `from` is not a verbatim substring of the base (or only
      // overlaps an already-patched span). Cannot anchor it safely.
      dropped.push({ from, reason: "patch_from_not_found" });
      continue;
    }
    const end = at + from.length;
    consumed.push([at, end]);
    accepted.push({ from, to, type, confidence, evidence, baseStart: at, baseEnd: end });
  }

  if (accepted.length === 0) {
    return { kind: "skipped", reason: "refinement_all_patches_dropped" };
  }

  accepted.sort((a, b) => a.baseStart - b.baseStart);
  const output = applyAcceptedPatches(base, accepted);

  // Drift guard (belt-and-braces): splicing guarantees the output
  // differs from the base only inside accepted patch spans. Verify the
  // invariant held; any violation means a bug in application, never a
  // model rewrite.
  if (!onlyPatchedRegionsChanged(base, output, accepted)) {
    return { kind: "skipped", reason: "refinement_silent_edits" };
  }

  // Shrink guard (carried over from #384): a net shrink under 88% of
  // the base means patches stripped speech rather than fixing words.
  if (output.length / base.length < 0.88) {
    return { kind: "skipped", reason: "refinement_too_short" };
  }

  // Duplicate guard: a replacement must not introduce a repeated
  // 5-10 word window the base didn't already repeat (the Lanre
  // "looking at different videos online ... looking at different
  // videos online" failure).
  if (introducesDuplicateWindow(base, output)) {
    return { kind: "skipped", reason: "refinement_introduced_duplicate" };
  }

  const confidence: "low" | "medium" | "high" = accepted.some((p) => p.confidence === "medium")
    ? "medium"
    : "high";

  const changesMade = accepted
    .map((p) => ({
      from: stripDashes(p.from.slice(0, 200)),
      to: p.to.slice(0, 200),
      reason: p.evidence
    }))
    .slice(0, 10);

  let uncertainPhrases: string[] = [];
  if (Array.isArray(obj.uncertainPhrases)) {
    uncertainPhrases = obj.uncertainPhrases
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => stripDashes(entry.slice(0, 200)))
      .filter((entry) => entry.length > 0)
      .slice(0, 10);
  }

  const baseModel =
    typeof obj.baseModel === "string" && obj.baseModel.length > 0
      ? obj.baseModel
      : baseAttempt?.model ?? "";

  const sanitised: Omit<RefinementSuccess, "model"> = {
    correctedTranscript: output,
    confidence,
    changesMade,
    uncertainPhrases,
    rawJson: JSON.stringify({
      baseModel,
      corrections: accepted.map((p) => ({
        from: p.from,
        to: p.to,
        type: p.type,
        confidence: p.confidence,
        evidence: p.evidence
      })),
      dropped,
      uncertainPhrases
    })
  };

  return { kind: "ok", result: sanitised };
}

/**
 * Index of the first occurrence of `sub` in `base` whose span does not
 * overlap an already-consumed region. -1 when none exists.
 */
function firstFreeOccurrence(
  base: string,
  sub: string,
  consumed: ReadonlyArray<[number, number]>
): number {
  let from = 0;
  for (;;) {
    const idx = base.indexOf(sub, from);
    if (idx === -1) return -1;
    const end = idx + sub.length;
    const overlaps = consumed.some(([s, e]) => idx < e && s < end);
    if (!overlaps) return idx;
    from = idx + 1;
  }
}

/**
 * Splice accepted patches (sorted by baseStart, non-overlapping spans)
 * into the base. The output differs from the base only inside the
 * patched spans, where each base span is replaced by the patch `to`.
 */
function applyAcceptedPatches(base: string, accepted: ReadonlyArray<AppliedPatch>): string {
  let out = "";
  let cursor = 0;
  for (const p of accepted) {
    out += base.slice(cursor, p.baseStart);
    out += p.to;
    cursor = p.baseEnd;
  }
  out += base.slice(cursor);
  return out;
}

/**
 * Walking diff: confirm `output` equals `base` everywhere EXCEPT inside
 * the accepted patch spans, where it equals each patch's `to`. Patches
 * must be sorted by baseStart and have non-overlapping spans. Exposed
 * for direct testing of the drift guard.
 */
export function onlyPatchedRegionsChanged(
  base: string,
  output: string,
  accepted: ReadonlyArray<{ to: string; baseStart: number; baseEnd: number }>
): boolean {
  let bCur = 0;
  let oCur = 0;
  for (const p of accepted) {
    const gap = p.baseStart - bCur;
    if (gap < 0) return false;
    if (base.slice(bCur, p.baseStart) !== output.slice(oCur, oCur + gap)) return false;
    oCur += gap;
    if (output.slice(oCur, oCur + p.to.length) !== p.to) return false;
    oCur += p.to.length;
    bCur = p.baseEnd;
  }
  return base.slice(bCur) === output.slice(oCur);
}

/**
 * True when `output` contains a repeated 5-10 word window that appears
 * fewer than twice in `base` (i.e. the repetition is newly introduced
 * by a patch). Exposed for direct testing of the duplicate guard.
 */
export function introducesDuplicateWindow(base: string, output: string): boolean {
  const baseTokens = wordTokens(base);
  const outTokens = wordTokens(output);
  for (let n = 5; n <= 10; n += 1) {
    if (outTokens.length < n) break;
    const outCounts = windowCounts(outTokens, n);
    const baseCounts = windowCounts(baseTokens, n);
    for (const [window, count] of outCounts) {
      if (count >= 2 && (baseCounts.get(window) ?? 0) < 2) return true;
    }
  }
  return false;
}

/** Lowercased word tokens (punctuation stripped, all lengths kept). */
function wordTokens(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Count every contiguous n-word window in a token stream. */
function windowCounts(tokens: ReadonlyArray<string>, n: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const window = tokens.slice(i, i + n).join(" ");
    counts.set(window, (counts.get(window) ?? 0) + 1);
  }
  return counts;
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
