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

export const providerRegistry: Record<AiProvider, AiProviderEntry> = {
  openai: openaiEntry,
  glm: glmEntry
};

/**
 * Default fallback chain. When the active provider exhausts retries OR
 * returns a non-retriable error, walk this chain (skipping the active
 * provider). Adding a new provider that should NOT be in the fallback
 * path: leave it out here.
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
