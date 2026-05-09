// Phase 1 hard-gate smoke test for the Gemini provider integration.
//
// Hits Google's OpenAI-compatible endpoint and decides which implementation
// path to take in services/ai.ts. The endpoint is documented for Gemini
// chat completions; whether Gemma flows through it cleanly, and what (if
// any) thinking-disable parameter is required, are the open questions this
// script answers.
//
//   pnpm --filter @inbox-os/runner exec tsx src/scripts/gemini-smoke.ts
//   (or)
//   npm exec --workspace @inbox-os/runner -- tsx src/scripts/gemini-smoke.ts
//
// Phase 1: baseline (no extra parameters). Each prints PASS/FAIL.
//   Mode 1: gemma-4-31b-it + response_format=json_object + strict JSON prompt
//   Mode 2: gemma-4-31b-it, no response_format, prompt-only "respond ONLY with JSON" + fence-stripper
//   Mode 3: gemma-4-31b-it baseline "say hello" — does Gemma return ANY content
//   Mode 4: GEMINI_FALLBACK_MODEL (default gemini-3-flash-preview) baseline
//
// Phase 2 (only runs when M1/M2 fail with thinking-trace pollution but M3 passes):
// thinking-disable variants. Each variant runs Mode 1 (response_format) and
// Mode 2 (prompt-only) with one extra parameter shape; the variant passes
// for a mode iff the response contains no `<thought>` marker AND parses as
// valid JSON of the expected shape.
//   Variant A: extra_body.google.thinking_config.thinking_budget = 0
//   Variant B: extra_body.google.thinking_config.thinking_level = "none" (fallback to "low" if 4xx)
//   Variant C: reasoning_effort = "none"
//
// Outcome decision tree (printed at the end):
//   A: Mode 1 passed in baseline                  → use response_format with Gemma, no flag
//   B: Mode 1 baseline failed but Mode 2 passed   → drop response_format for Gemma, prompt-reinforce
//   D: any variant cleared thinking traces        → ship Gemma with that variant's flag baked in
//   C: Mode 3 failed, OR all variants failed      → fall back to a Gemini model
//        → if Mode 4 passed: switch default to that model, document Gemma as gated
//        → if Mode 4 failed: stop and report
//
// Output format is parsed by humans pasting it into a PR description.

import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findEnvUp(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
const here = dirname(fileURLToPath(import.meta.url));
const envPath = findEnvUp(here);
if (envPath) loadDotenv({ path: envPath });

const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) {
  console.error("[gemini-smoke] GEMINI_API_KEY is not set. Get a key from https://aistudio.google.com/apikey and rerun.");
  process.exit(1);
}

const baseURL = process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/";
const gemmaModel = process.env.GEMINI_MODEL?.trim() || "gemma-4-31b-it";
const fallbackModel = process.env.GEMINI_FALLBACK_MODEL?.trim() || "gemini-3-flash-preview";

console.log(`[gemini-smoke] envPath=${envPath ?? "(none)"}`);
console.log(`[gemini-smoke] baseURL=${baseURL}`);
console.log(`[gemini-smoke] gemma-model=${gemmaModel}`);
console.log(`[gemini-smoke] fallback-model=${fallbackModel}`);
console.log("");

import type OpenAIType from "openai";
const { default: OpenAI } = await import("openai");
const client = new OpenAI({ apiKey, baseURL });

type ModeResult = { pass: boolean; reason: string };
type ChatCreateParams = Parameters<typeof client.chat.completions.create>[0];
// `chat.completions.create` returns the streaming/non-streaming union; we
// never set `stream: true` here, so cast to the non-streaming variant when
// reading `.choices`. Keeping it as a type alias so the cast site is short.
type NonStreamingChatCompletion = OpenAIType.Chat.Completions.ChatCompletion;

const STRICT_JSON_USER =
  'Return strict JSON matching: {"ok": true, "greeting": "hi"}. Echo those two fields back exactly.';
const STRICT_JSON_USER_REINFORCED =
  STRICT_JSON_USER +
  '\n\nRespond ONLY with a single JSON object that matches the schema above. No markdown, no code fences, no commentary.';

function stripJsonFences(content: string): string {
  return content.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

function describeError(err: unknown): string {
  const e = err as { status?: number; message?: string; error?: { message?: string } } | undefined;
  return `status=${e?.status ?? "?"} message=${e?.message ?? e?.error?.message ?? String(err).slice(0, 240)}`;
}

function isStatus(err: unknown, status: number): boolean {
  const e = err as { status?: number } | undefined;
  return e?.status === status;
}

function evaluateJsonResponse(raw: string | null | undefined, allowFenceStrip: boolean): ModeResult {
  if (!raw || raw.trim().length === 0) {
    return { pass: false, reason: "empty content" };
  }
  if (raw.includes("<thought>")) {
    return { pass: false, reason: `thinking trace present; head=${raw.slice(0, 160)}` };
  }
  const cleaned = allowFenceStrip ? stripJsonFences(raw) : raw;
  try {
    const parsed = JSON.parse(cleaned) as { ok?: unknown; greeting?: unknown };
    if (parsed.ok === true && typeof parsed.greeting === "string") {
      return { pass: true, reason: `valid JSON: ${cleaned.slice(0, 120)}` };
    }
    return { pass: false, reason: `JSON parsed but shape mismatch: ${cleaned.slice(0, 240)}` };
  } catch {
    return { pass: false, reason: `JSON.parse failed; cleaned=${cleaned.slice(0, 240)}` };
  }
}

// ── Phase 1: baseline modes ────────────────────────────────────────────────

async function modeBaseline(
  mode: "json-format" | "prompt-only" | "hello",
  model: string
): Promise<ModeResult> {
  try {
    const params: ChatCreateParams = (() => {
      if (mode === "json-format") {
        return {
          model,
          response_format: { type: "json_object" as const },
          messages: [
            { role: "system", content: "You return strict JSON. No prose, no fences." },
            { role: "user", content: STRICT_JSON_USER }
          ]
        };
      }
      if (mode === "prompt-only") {
        return {
          model,
          messages: [
            { role: "system", content: "You return strict JSON. No prose, no fences." },
            { role: "user", content: STRICT_JSON_USER_REINFORCED }
          ]
        };
      }
      return {
        model,
        messages: [{ role: "user", content: "Say hello in one short sentence." }]
      };
    })();
    const response = (await client.chat.completions.create(params)) as NonStreamingChatCompletion;
    const choice = response.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (mode === "hello") {
      if (!content) {
        return { pass: false, reason: `empty content; raw=${JSON.stringify(choice).slice(0, 240)}` };
      }
      return { pass: true, reason: `returned content: ${content.slice(0, 120)}` };
    }
    return evaluateJsonResponse(content, mode === "prompt-only");
  } catch (err) {
    return { pass: false, reason: describeError(err) };
  }
}

const m1 = await modeBaseline("json-format", gemmaModel);
console.log(`Mode 1 (response_format, baseline):     ${m1.pass ? "PASS" : "FAIL"} — ${m1.reason}`);
const m2 = await modeBaseline("prompt-only", gemmaModel);
console.log(`Mode 2 (prompt-only, baseline):         ${m2.pass ? "PASS" : "FAIL"} — ${m2.reason}`);
const m3 = await modeBaseline("hello", gemmaModel);
console.log(`Mode 3 (gemma-baseline):                ${m3.pass ? "PASS" : "FAIL"} — ${m3.reason}`);
const m4 = await modeBaseline("hello", fallbackModel);
console.log(`Mode 4 (fallback-baseline):             ${m4.pass ? "PASS" : "FAIL"} — ${m4.reason}`);
console.log("");

// ── Phase 2: thinking-disable variants (only when needed) ──────────────────

type Variant = {
  id: "A" | "B" | "C" | "D";
  label: string;
  // A description that goes into the summary line (e.g. final value used).
  outcomeNote: string;
  build: (mode: "json-format" | "prompt-only") => ChatCreateParams;
};

type ExtraBodyShape = {
  extra_body?: {
    google?: {
      thinking_config?: {
        thinking_budget?: number;
        // Gemma 4's documented value space is narrow: "MINIMAL" / "HIGH"
        // (Outcome D smoke result). "low" / "minimal" appear to be tolerated
        // but Variant B (legacy) keeps the old "none"/"low" probe paths.
        thinking_level?: "none" | "low" | "MINIMAL" | "HIGH" | "minimal";
      };
    };
  };
  reasoning_effort?: "none" | "low" | "minimal";
};

function buildBaseRequest(model: string, mode: "json-format" | "prompt-only"): ChatCreateParams {
  if (mode === "json-format") {
    return {
      model,
      response_format: { type: "json_object" as const },
      messages: [
        { role: "system", content: "You return strict JSON. No prose, no fences." },
        { role: "user", content: STRICT_JSON_USER }
      ]
    };
  }
  return {
    model,
    messages: [
      { role: "system", content: "You return strict JSON. No prose, no fences." },
      { role: "user", content: STRICT_JSON_USER_REINFORCED }
    ]
  };
}

function withExtras(base: ChatCreateParams, extras: ExtraBodyShape): ChatCreateParams {
  return { ...base, ...extras } as ChatCreateParams;
}

async function runVariant(
  variantBuild: (mode: "json-format" | "prompt-only") => ChatCreateParams,
  mode: "json-format" | "prompt-only"
): Promise<ModeResult> {
  try {
    const response = (await client.chat.completions.create(
      variantBuild(mode)
    )) as NonStreamingChatCompletion;
    const content = response.choices?.[0]?.message?.content?.trim();
    return evaluateJsonResponse(content, mode === "prompt-only");
  } catch (err) {
    return { pass: false, reason: describeError(err) };
  }
}

// Run variants only when the failure mode is thinking-trace pollution.
const needsVariants = m3.pass && (!m1.pass || !m2.pass);
type VariantOutcome = {
  id: "A" | "B" | "C" | "D";
  label: string;
  outcomeNote: string;
  modeJsonFormat: ModeResult;
  modePromptOnly: ModeResult;
  passed: boolean; // true if EITHER mode test cleared thinking traces and parsed
};
const variantOutcomes: VariantOutcome[] = [];

if (needsVariants) {
  console.log("─── Phase 2: thinking-disable variants ───");

  // Variant A — thinking_budget: 0
  {
    const variant: Variant = {
      id: "A",
      label: "thinking_budget: 0",
      outcomeNote: "extra_body.google.thinking_config.thinking_budget=0",
      build: (mode) =>
        withExtras(buildBaseRequest(gemmaModel, mode), {
          extra_body: { google: { thinking_config: { thinking_budget: 0 } } }
        })
    };
    const j = await runVariant(variant.build, "json-format");
    const p = await runVariant(variant.build, "prompt-only");
    console.log(`  variant-A json-format: ${j.pass ? "PASS" : "FAIL"} — ${j.reason}`);
    console.log(`  variant-A prompt-only: ${p.pass ? "PASS" : "FAIL"} — ${p.reason}`);
    variantOutcomes.push({
      id: variant.id,
      label: variant.label,
      outcomeNote: variant.outcomeNote,
      modeJsonFormat: j,
      modePromptOnly: p,
      passed: j.pass || p.pass
    });
  }

  // Variant B — thinking_level: "none", fall back to "low" if 4xx on the first attempt
  {
    let valueUsed: "none" | "low" = "none";
    const buildLevel = (level: "none" | "low") =>
      (mode: "json-format" | "prompt-only") =>
        withExtras(buildBaseRequest(gemmaModel, mode), {
          extra_body: { google: { thinking_config: { thinking_level: level } } }
        });
    let j = await runVariant(buildLevel("none"), "json-format");
    let p = await runVariant(buildLevel("none"), "prompt-only");
    // If both attempts came back as 4xx (likely "invalid value"), retry with "low".
    const looks4xxRejection = (r: ModeResult) => /status=400|status=422|invalid/i.test(r.reason);
    if (looks4xxRejection(j) && looks4xxRejection(p)) {
      valueUsed = "low";
      j = await runVariant(buildLevel("low"), "json-format");
      p = await runVariant(buildLevel("low"), "prompt-only");
    }
    const variant: Variant = {
      id: "B",
      label: `thinking_level: "${valueUsed}"`,
      outcomeNote: `extra_body.google.thinking_config.thinking_level="${valueUsed}"`,
      build: buildLevel(valueUsed)
    };
    console.log(`  variant-B json-format: ${j.pass ? "PASS" : "FAIL"} (value="${valueUsed}") — ${j.reason}`);
    console.log(`  variant-B prompt-only: ${p.pass ? "PASS" : "FAIL"} (value="${valueUsed}") — ${p.reason}`);
    variantOutcomes.push({
      id: variant.id,
      label: variant.label,
      outcomeNote: variant.outcomeNote,
      modeJsonFormat: j,
      modePromptOnly: p,
      passed: j.pass || p.pass
    });
  }

  // Variant C — reasoning_effort: "none"
  {
    const variant: Variant = {
      id: "C",
      label: "reasoning_effort: none",
      outcomeNote: 'reasoning_effort="none"',
      build: (mode) =>
        withExtras(buildBaseRequest(gemmaModel, mode), { reasoning_effort: "none" })
    };
    const j = await runVariant(variant.build, "json-format");
    const p = await runVariant(variant.build, "prompt-only");
    console.log(`  variant-C json-format: ${j.pass ? "PASS" : "FAIL"} — ${j.reason}`);
    console.log(`  variant-C prompt-only: ${p.pass ? "PASS" : "FAIL"} — ${p.reason}`);
    variantOutcomes.push({
      id: variant.id,
      label: variant.label,
      outcomeNote: variant.outcomeNote,
      modeJsonFormat: j,
      modePromptOnly: p,
      passed: j.pass || p.pass
    });
  }

  // Variant D — thinking_level: "MINIMAL". Pi-mono evidence + community
  // reports note that Gemma 4 uses `thinking_level` and only accepts a
  // narrow set of values (MINIMAL / HIGH). LOW / MEDIUM / numeric budgets
  // get rejected with HTTP 400 — that's why the previous variants failed.
  // This is the live verification of the helper that ships in
  // services/ai.ts:geminiExtraBody for Outcome D.
  {
    const variant: Variant = {
      id: "D",
      label: 'thinking_level: "MINIMAL"',
      outcomeNote: 'extra_body.google.thinking_config.thinking_level="MINIMAL"',
      build: (mode) =>
        withExtras(buildBaseRequest(gemmaModel, mode), {
          extra_body: { google: { thinking_config: { thinking_level: "MINIMAL" } } }
        })
    };
    const j = await runVariant(variant.build, "json-format");
    const p = await runVariant(variant.build, "prompt-only");
    console.log(`  variant-D json-format: ${j.pass ? "PASS" : "FAIL"} — ${j.reason}`);
    console.log(`  variant-D prompt-only: ${p.pass ? "PASS" : "FAIL"} — ${p.reason}`);
    variantOutcomes.push({
      id: variant.id,
      label: variant.label,
      outcomeNote: variant.outcomeNote,
      modeJsonFormat: j,
      modePromptOnly: p,
      passed: j.pass || p.pass
    });
  }
  console.log("");
}

// ── Outcome computation ────────────────────────────────────────────────────

let outcome: "A" | "B" | "C" | "D";
let recommendedModel: string;
let recommendedThinkingDisable: string;
let recommendedJsonResponseFormat: boolean;

if (m1.pass) {
  outcome = "A";
  recommendedModel = gemmaModel;
  recommendedThinkingDisable = "none";
  recommendedJsonResponseFormat = true;
} else if (m3.pass && m2.pass) {
  outcome = "B";
  recommendedModel = gemmaModel;
  recommendedThinkingDisable = "none";
  recommendedJsonResponseFormat = false;
} else if (needsVariants && variantOutcomes.some((v) => v.passed)) {
  outcome = "D";
  recommendedModel = gemmaModel;
  // Prefer a variant whose Mode 1 (response_format) cleared — keeps the rest
  // of the call path simple. Otherwise take whichever variant's Mode 2 cleared.
  const m1Winner = variantOutcomes.find((v) => v.modeJsonFormat.pass);
  const m2Winner = variantOutcomes.find((v) => v.modePromptOnly.pass);
  const winner = m1Winner ?? m2Winner!;
  recommendedThinkingDisable = winner.outcomeNote;
  recommendedJsonResponseFormat = Boolean(m1Winner);
} else {
  outcome = "C";
  recommendedModel = m4.pass ? fallbackModel : "<stop-and-report>";
  recommendedThinkingDisable = "none";
  recommendedJsonResponseFormat = true;
}

console.log("─── Summary (paste into PR description) ───");
console.log(`[gemini-smoke] gemma-model=${gemmaModel}`);
console.log(`[gemini-smoke] mode-1 (response_format):        ${m1.pass ? "PASS" : "FAIL"}`);
console.log(`[gemini-smoke] mode-2 (prompt-only):            ${m2.pass ? "PASS" : "FAIL"}`);
console.log(`[gemini-smoke] mode-3 (gemma-baseline):         ${m3.pass ? "PASS" : "FAIL"}`);
console.log(`[gemini-smoke] fallback-model=${fallbackModel}`);
console.log(`[gemini-smoke] mode-4 (fallback-baseline):      ${m4.pass ? "PASS" : "FAIL"}`);
if (needsVariants) {
  for (const v of variantOutcomes) {
    console.log(
      `[gemini-smoke] variant-${v.id} (${v.label}): json-format=${v.modeJsonFormat.pass ? "PASS" : "FAIL"} prompt-only=${v.modePromptOnly.pass ? "PASS" : "FAIL"}`
    );
  }
}
console.log(`[gemini-smoke] recommended outcome:             ${outcome}`);
console.log(`[gemini-smoke] recommended GEMINI_MODEL:        ${recommendedModel}`);
console.log(`[gemini-smoke] recommended thinking-disable:    ${recommendedThinkingDisable}`);
console.log(`[gemini-smoke] recommended response_format:     ${recommendedJsonResponseFormat ? "use" : "drop"}`);

process.exit(outcome === "C" && !m4.pass ? 2 : 0);
