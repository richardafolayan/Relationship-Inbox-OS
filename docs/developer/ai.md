# AI processing, providers, routing, and voice controls

AI is an optional runner service. It assists understanding and writing; it
does not own sending. The provider implementation is in
[`ai.ts`](../../apps/runner/src/services/ai.ts) and
[`ai-providers.ts`](../../apps/runner/src/services/ai-providers.ts).

## AI-produced state

| Operation | Trigger | Persistence / fallback |
| --- | --- | --- |
| Summary, current ask, open loops, tone, memory, reply brief | Changed versioned inbound hash during normal scan, or explicit Reassess | Stored on Thread. Previous values or sanitized caller fallback survive provider failure. |
| Outreach/genuine category | First persisted thread without a category, or explicit maintenance path | Stored only on a valid verdict. |
| Open/closed verdict | Changed last-inbound cache key when help level allows classification | Stored with reason; null/old value survives outage. |
| Suggested replies/predraft | Full-drafts user flow and cache miss | Cached on Thread with provider source where surfaced. |
| Draft transform and compose from intent | Explicit user action | Returned as editable text; not sent. |
| Draft coverage | User types against open loops | Ephemeral addressed/partial feedback. |
| Reconnect score | Explicit score refresh for dormant LinkedIn threads | Cached score, reason, and key. |
| Contact summary/starters and person Q&A | Explicit/optional enrichment and person actions | Enrichment cache or ephemeral answer. |
| Voice-profile inference | Explicit user request | Suggestion only; user reviews before save. |
| Focus note phrasing | Explicit user request | Editable result, never saved or sent automatically. |
| Pilot report triage | Configured feedback flow | Uses only typed report text and safe metadata, never message history or screenshot pixels. |

## Effective provider selection

1. The runner constructs clients at startup for keys that exist.
2. Every call reads the persisted `app_settings.aiProvider`. If that field is
   absent, `AI_PROVIDER` supplies the configuration fallback.
3. If the requested provider has a client, it is active.
4. If it has no client, key-presence selection chooses the first configured
   provider in `openai`, `gemini`, `glm` order.
5. If none is configured, the call returns its operation-specific safe
   fallback.

A new settings database currently seeds `aiProvider: openai` from
[`defaultSettings`](../../packages/core/src/defaults.ts), even though
`runnerConfig.aiProvider` defaults to Gemini. Therefore the persisted value,
not the comment or `.env.example` alone, determines a fresh installation's
effective selection. `/data/ai-status` reports the live choice, model, and
configured clients.

## Providers and retry/fallback

| Provider | Default model | Client timeout | Attempts and backoff | Important behavior |
| --- | --- | --- | --- | --- |
| OpenAI | `gpt-5-nano` | 15 seconds | 2 attempts, 2-second linear base plus jitter | Runtime fallback target; GPT model-specific request options are normalized. |
| Gemini API | `gemma-4-31b-it` | 45 seconds | 3 attempts, 5-second base plus jitter | OpenAI-compatible endpoint; Gemma calls add minimal-thinking configuration. 429 and timeout fail through promptly to OpenAI. |
| Z.AI GLM | `glm-4.7-flash` | 15 seconds | 3 attempts, 7-second base plus jitter | Classifies provider body codes for balance, auth, rate, and overload. |

Normal JSON operations try the active provider, then the narrow fallback chain
containing OpenAI, skipping duplicates. Gemini is not a fallback for OpenAI or
GLM calls. A Gemini-active or GLM-active call can fall through to OpenAI.

Provider source records include the actual provider, the selected provider
that failed, stable error kind, and a safe message. All providers exhausted
returns the caller's fallback, not invented success.

### Provider racing

Only explicit Reassess summary generation currently sets `race=true`. It runs
the active provider and one configured secondary in parallel and takes the
first valid parsed result. This can spend against both providers and is not
used for background scans, classifications, coverage checks, or every draft.

## Prompt context and privacy

Context is assembled for the operation rather than sending the whole database.
Depending on the feature it can include recent message text, selected
transcripts, previous summary/open loops, reply brief, contact enrichment,
relationship memory, operator profile, and measured writing style.

System and deleted-placeholder messages are filtered from AI-visible context.
Group prompts label individual senders and tell the model the response is
visible to the whole group.

Provider requests leave the Mac. API keys stay in `.env` and are never added
to feedback. Local transcription audio does not leave; OpenAI audio
transcription and optional text refinement are separate explicit routes.

## Voice controls

### User-controlled profile

`operator_profile_v1` stores:

- display name and self-description;
- interests;
- common and avoided phrases;
- preferred `warm`, `direct`, `casual`, `thoughtful`, or `concise` tone;
- `memory_only`, `writing_support`, or `full_drafts` help level;
- Focus Reply Buffer state, templates, and preferences.

Empty profile fields produce a neutral style. Style inference can suggest only
about, interests, tone, common phrases, and avoided phrases; it never infers
identity or help level and never saves without review.

### Channel and observed style

LinkedIn uses the professional voice tier. iMessage, WhatsApp, Instagram, and
TikTok use the casual tier. Per-thread measurements add average length, emoji,
full-stop, and capitalization behavior for the operator and contact. These
measurements calibrate register without copying the contact or inventing a
persona.

### Grounding and deterministic post-processing

Prompts enforce contact/operator identity, recency, required-point coverage,
uncertainty, and no invented facts. After generation, code:

- replaces em dash and en dash forms;
- replaces semicolons and colons with allowed punctuation;
- enforces configured sentence-start capitalization rules;
- softens casual trailing periods where the observed style calls for it;
- removes operator meta-talk and sanitizes reply-brief shapes;
- validates JSON and falls back when parsing is invalid.

Mechanical rules complement prompts; they do not prove factual accuracy.
Fidelity regressions need representative privacy-safe fixtures and provider
comparison, not a hardcoded example.

## Cache invalidation

- Summary state uses a version token, needs-reply bit, latest inbound time, and
  cleaned text hash. Change prompt/output semantics only with a version bump.
- Suggested replies include the relevant AI inputs and voice/contact
  fingerprints.
- Enrichment summaries/starters include contact and self-profile fingerprints.
- Open/closed and reconnect fields use their own narrower cache keys.
- A higher-quality transcript sets `needsAiRefresh`; Reassess clears it after
  explicit regeneration.

## Failure diagnosis

Check, in order:

1. `GET /data/ai-status` for selected and configured providers;
2. `.env` key/model/base URL, followed by runner restart;
3. Activity logs and console lines beginning `[ai]` for auth, balance,
   rate-limit, model, timeout, or all-providers-exhausted classification;
4. focused provider tests in [testing](testing.md);
5. the [troubleshooting playbook](../troubleshooting/playbook.md#ai-output-is-missing-slow-or-uses-a-fallback-provider).
