# ADR 0005: AI routing and deterministic voice controls

Status: Accepted

## Context

The app supports three OpenAI-wire-compatible services with different
availability and model behavior. Generated text must remain grounded and
follow mechanical voice constraints even when a model occasionally ignores a
prompt instruction.

## Decision

Construct provider clients once at runner startup, resolve the persisted
provider choice per call, fall back by configured key when the selected client
is absent, and use provider-specific bounded retries. Runtime fallback is
narrow: the active provider may fall through to OpenAI. Race two configured
providers only for explicitly selected, slow, user-visible operations.

Build prompts from the operator profile, per-thread observed style, channel
tier, and grounded thread context. Apply deterministic punctuation and
sentence-start controls after generation. Keep full drafts opt-in.

## Consequences

- Provider switches stored in Settings take effect without restarting, but a
  newly added API key still needs a runner restart because clients are created
  at boot.
- Gemini and GLM can reuse the OpenAI SDK through compatible endpoints.
- Provider fallback can change which model produced a visible result, so
  source metadata is returned where the UI needs to disclose it.
- Raced operations can spend against two providers and must remain rare.

## Verification

- [`apps/runner/src/services/ai-providers.ts`](../../apps/runner/src/services/ai-providers.ts)
- [`apps/runner/src/services/ai.ts`](../../apps/runner/src/services/ai.ts)
- [`apps/runner/src/services/ai-race.ts`](../../apps/runner/src/services/ai-race.ts)
- [`apps/runner/src/services/style.ts`](../../apps/runner/src/services/style.ts)
- [AI processing reference](../developer/ai.md)
