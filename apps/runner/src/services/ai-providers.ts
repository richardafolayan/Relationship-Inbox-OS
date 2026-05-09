/**
 * Provider registry for the AI layer.
 *
 * Adding a new provider that's OpenAI-wire-compatible (Anthropic via the
 * compat shim, Mistral, Together, etc.) is two steps:
 *   1. Extend the `AiProvider` union in `../config.ts` and add the env-var
 *      wiring + client construction in `createAiService`.
 *   2. Add an entry below: id, displayName, classifier (returns a
 *      structured AiErrorClassification), per-provider retry config.
 *
 * The retry/fallback wrapper in `ai.ts` keys off the classification's
 * `retriable` field — that's the contract a new provider needs to uphold
 * for the runtime behaviour to be right (back off on rate limits, fail
 * fast on auth/balance, fall through to the next provider in
 * `fallbackChain` if everything else fails).
 */

import type { AiProvider } from "../config";
import type { AiErrorKind } from "@inbox-os/core";

export type { AiErrorKind } from "@inbox-os/core";

export interface AiErrorClassification {
  kind: AiErrorKind;
  /** Human-readable hint for logs. Single line, no trailing newline. */
  message: string;
  /** Should the same provider be retried with backoff? */
  retriable: boolean;
}

export interface AiProviderEntry {
  id: AiProvider;
  /** Used in user-facing fallback notices on the dashboard. */
  displayName: string;
  classifyError: (error: unknown) => AiErrorClassification;
  /** Total attempts (including the first one). 1 = no retry. */
  maxAttempts: number;
  /** Linear base delay between retries in ms. Jitter is added per attempt. */
  baseBackoffMs: number;
}

/**
 * Z.AI's BigModel-compatible API uses 4-digit codes inside the JSON error
 * body. The OpenAI SDK stringifies the body into `error.message`, so we
 * pattern match the `"code":"NNNN"` field. HTTP 429 alone is ambiguous —
 * three different conditions return 429 — so the body code is what
 * differentiates them.
 *   1113: insufficient balance / no resource package (account-side, not retriable)
 *   1301: invalid api key (auth, not retriable)
 *   1302: per-account rate limit reached (RPM/TPM bucket — retriable)
 *   1305: service temporarily overloaded (Z.AI infra — retriable)
 */
function classifyGlmError(error: unknown): AiErrorClassification {
  const err = error as { code?: string; status?: number; message?: string } | undefined;
  const message = err?.message ?? String(error);
  const code = err?.code;
  const status = err?.status;
  const bodyCodeMatch = /"code"\s*:\s*"?(\d{4})"?/.exec(message);
  const bodyCode = bodyCodeMatch?.[1];

  if (bodyCode === "1113" || /insufficient.*balance|no.*balance|余额不足/i.test(message)) {
    return {
      kind: "balance",
      message:
        "Z.AI account has no balance / no resource package (code 1113). " +
        "Free-tier flash models (e.g. glm-4.7-flash) bypass this. For paid SKUs, top up at " +
        "https://open.bigmodel.cn or https://api.z.ai, then retry.",
      retriable: false
    };
  }
  if (bodyCode === "1302" || /rate.?limit/i.test(message)) {
    return {
      kind: "rate_limit",
      message:
        "Z.AI rate limit reached (code 1302). Free-tier flash models cap RPM/TPM " +
        "per account — back off ~6-8s between calls or batch per-thread AI work into one " +
        "prompt. Retrying with backoff.",
      retriable: true
    };
  }
  if (bodyCode === "1305" || /(temporarily.{0,15})?overload(ed)?/i.test(message)) {
    return {
      kind: "service_overloaded",
      message:
        "Z.AI service is temporarily overloaded (code 1305). This is server-side " +
        "capacity, not your account — common on free-tier flash during peak hours. Retrying " +
        "with backoff; if it doesn't clear we'll fall back to the next provider.",
      retriable: true
    };
  }
  if (bodyCode === "1301" || status === 401 || code === "invalid_api_key") {
    return {
      kind: "auth",
      message: "Z_AI_API_KEY is missing or invalid. Set it in .env and restart the runner, or recheck the dashboard provider toggle.",
      retriable: false
    };
  }
  if (code === "model_not_found" || /model.*(not found|does not exist|invalid)/i.test(message)) {
    return {
      kind: "model_not_found",
      message: `GLM model not available (${message}). Set Z_AI_MODEL to a valid id (e.g. glm-4.7-flash, glm-4.5-flash) and confirm against the pricing page — flash variants are free-tier and not always shown in /v4/models.`,
      retriable: false
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      message: `Z.AI returned 429 (rate-limit / quota / overload — body did not carry a recognised code). Treating as retriable. Raw: ${message.slice(0, 240)}`,
      retriable: true
    };
  }
  return {
    kind: "unknown",
    message: `${message}.`,
    retriable: true
  };
}

/**
 * Typed shape for the various error envelopes Google's OpenAI-compatibility
 * layer emits. Errors arrive in three shapes depending on which layer threw:
 *   - OpenAI SDK shape: `{ status, code, message }`
 *   - Google REST shape: `{ error: { code, status, message } }` (string status
 *     like "INVALID_ARGUMENT" or "RESOURCE_EXHAUSTED")
 *   - SDK-wrapped REST shape: `{ response: { status, data: { error: ... } } }`
 * This interface lets us narrow without `any` casts at the call site.
 */
type ErrorLike = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
  error?: {
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
  response?: {
    status?: unknown;
    data?: {
      error?: {
        code?: unknown;
        status?: unknown;
        message?: unknown;
      };
    };
  };
};

function asErrorLike(err: unknown): ErrorLike {
  return typeof err === "object" && err !== null ? (err as ErrorLike) : {};
}

/**
 * Google Gemini API errors via the OpenAI-compat endpoint. Reads nested
 * Google REST shapes (`error.code`, `error.status`, `response.data.error.*`)
 * as well as the OpenAI-SDK-shaped fallback. Default model is gemma-4-31b-it
 * with thinking_level=MINIMAL applied automatically; the model_not_found
 * hint points operators at the env var so they can swap if needed.
 */
function classifyGeminiError(error: unknown): AiErrorClassification {
  const e = asErrorLike(error);
  const rawStatus = e.status ?? e.response?.status ?? e.error?.code ?? e.code;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const message =
    typeof e.message === "string"
      ? e.message
      : typeof e.error?.message === "string"
        ? e.error.message
        : typeof e.response?.data?.error?.message === "string"
          ? e.response.data.error.message
          : "";
  const googleStatus =
    typeof e.error?.status === "string"
      ? e.error.status
      : typeof e.response?.data?.error?.status === "string"
        ? e.response.data.error.status
        : "";
  const code = e.code;

  if (status === 401 || /api.?key.*invalid|unauthorized/i.test(message)) {
    return {
      kind: "auth",
      message:
        "GEMINI_API_KEY is missing or invalid. Get a key from https://aistudio.google.com/apikey, " +
        "set it in .env, and restart the runner.",
      retriable: false
    };
  }
  if (status === 403 && /quota|billing/i.test(message)) {
    return {
      kind: "balance",
      message:
        "Gemini API quota exhausted (HTTP 403). Check usage at " +
        "https://aistudio.google.com/ and adjust limits or billing.",
      retriable: false
    };
  }
  if (status === 429 || googleStatus === "RESOURCE_EXHAUSTED") {
    return {
      kind: "rate_limit",
      message: "Gemini API rate limit reached. Retrying with backoff.",
      retriable: true
    };
  }
  if (typeof status === "number" && status >= 500 && status <= 504) {
    return {
      kind: "service_overloaded",
      message: `Gemini API returned ${status}. Treating as transient and retrying with backoff.`,
      retriable: true
    };
  }
  if (
    code === "model_not_found" ||
    /model.*(not found|does not exist|invalid)/i.test(message) ||
    googleStatus === "NOT_FOUND"
  ) {
    return {
      kind: "model_not_found",
      message:
        `Gemini model not available (${message || googleStatus || "no detail"}). Set GEMINI_MODEL ` +
        "to a valid id. Smoke-confirmed working choices: gemma-4-31b-it (default, " +
        "uses thinking_level=MINIMAL automatically) and gemini-3-flash-preview. See " +
        "apps/runner/src/scripts/gemini-smoke.ts for the value space.",
      retriable: false
    };
  }
  return {
    kind: "unknown",
    message: `${message || googleStatus || "no detail"}.`,
    retriable: true
  };
}

function classifyOpenAiError(error: unknown): AiErrorClassification {
  const err = error as { code?: string; status?: number; message?: string } | undefined;
  const message = err?.message ?? String(error);
  const code = err?.code;
  const status = err?.status;

  if (code === "insufficient_quota") {
    return {
      kind: "balance",
      message:
        "OpenAI account is out of credits (insufficient_quota). " +
        "Top up at https://platform.openai.com/settings/organization/billing/overview, then retry.",
      retriable: false
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      message: `OpenAI rate limit reached (429). Retrying with backoff.`,
      retriable: true
    };
  }
  if (code === "model_not_found" || /model.*(not found|does not exist)/i.test(message)) {
    return {
      kind: "model_not_found",
      message: `Model not available to this account (${message}). Set OPENAI_MODEL to one your account has access to (e.g. gpt-5-nano, gpt-5.4-mini, gpt-5.4, o1, o3-mini).`,
      retriable: false
    };
  }
  if (status === 401 || code === "invalid_api_key") {
    return {
      kind: "auth",
      message: "OPENAI_API_KEY is missing or invalid. Set it in .env and restart the runner.",
      retriable: false
    };
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return {
      kind: "service_overloaded",
      message: `OpenAI returned ${status}. Treating as transient server-side issue and retrying with backoff.`,
      retriable: true
    };
  }
  return {
    kind: "unknown",
    message: `${message}.`,
    retriable: true
  };
}

const glmEntry: AiProviderEntry = {
  id: "glm",
  displayName: "Z.AI GLM",
  classifyError: classifyGlmError,
  // Free-tier flash regularly returns 1305 in bursts. Three attempts with
  // ~7s base delay covers most transient overload windows without making
  // the user wait an absurd amount of time before falling back.
  maxAttempts: 3,
  baseBackoffMs: 7000
};

const openaiEntry: AiProviderEntry = {
  id: "openai",
  displayName: "OpenAI",
  classifyError: classifyOpenAiError,
  // OpenAI is more reliable; fewer retries needed. Mostly here as the
  // fallback target so we don't make the user wait long if it's also slow.
  maxAttempts: 2,
  baseBackoffMs: 2000
};

const geminiEntry: AiProviderEntry = {
  id: "gemini",
  displayName: "Gemini API",
  classifyError: classifyGeminiError,
  // Conservative starting position for an unproven provider. Three attempts
  // with ~5s base delay sit between OpenAI's 2s (reliable) and GLM's 7s
  // (noisy). Tune up only after observability shows the failure shape.
  maxAttempts: 3,
  baseBackoffMs: 5000
};

export const providerRegistry: Record<AiProvider, AiProviderEntry> = {
  openai: openaiEntry,
  glm: glmEntry,
  gemini: geminiEntry
};

/**
 * Default fallback chain. When the active provider exhausts retries OR
 * returns a non-retriable error, the runtime walks this chain (skipping
 * the active provider). The resolution loop in services/ai.ts:modelJson
 * does the actual walking, so this is just the ordered list.
 *
 * Gemini is intentionally NOT in the fallback chain initially — it's a
 * fresh integration and we don't want to mask Gemma/Gemini outages by
 * silently absorbing them into requests originally aimed at OpenAI or
 * GLM. Operators who pick Gemini as active still fall through to OpenAI
 * on Gemini failures (active = gemini → chain = ["gemini", "openai"]).
 * Revisit including gemini here after a few weeks of observed reliability.
 */
export const fallbackChain: AiProvider[] = ["openai"];

/**
 * Backwards-compatible facade for the old `classifyLlmError(error,
 * provider) => string` signature. Keeps the existing test suite + log
 * lines intact while the structured classification is what drives the
 * retry/fallback runtime.
 */
export function classifyLlmError(error: unknown, provider: AiProvider): string {
  const cls = providerRegistry[provider].classifyError(error);
  return `Reason: ${cls.message}`;
}
