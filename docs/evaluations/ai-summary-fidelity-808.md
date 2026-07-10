# Issue 808 AI summary fidelity evaluation

Base: `origin/v1/strip-back-pr1` at
`fcf51204a5642e5ca123c075e921e33f5e1ae2d1`.

The expected facts, forbidden claims, state rules, action items, reply beats,
identity traps and voice rules were written before prompt changes. The full
scoring contract is in [`ai-fidelity-rubric.md`](./ai-fidelity-rubric.md).

## Evaluation set

Seven synthetic cases cover:

- short and long conversations
- multi-topic conversations
- ambiguous and emotional conversations
- interruptions and old context
- new replies
- unresolved promises
- already answered points
- action items
- different user voice rules
- strict punctuation rules

No fixture was copied from a local conversation. No private message content,
contact name, generated local prose or raw prompt is committed in this report.

## Provider boundary

Both providers received the same seven cases and were pinned so a fallback
could not be counted as the provider under test.

| Provider | Exact model | Baseline availability | Final availability |
| --- | --- | ---: | ---: |
| Google Gemini API | `gemma-4-31b-it` | 7/7 | 7/7 successful quality cases, assembled from successful pinned reruns |
| OpenAI | `gpt-5-nano` | 0/7 | 0/7 |

The repository's Google provider is named `gemini`, but the configured pilot
model is Gemma 4. The exact model is recorded to avoid presenting a Gemma result
as a Gemini-branded model result.

GPT-5 Nano returned `insufficient_quota` for every summary and suggested-reply
call at baseline and final. The evaluator therefore reports its quality scores
as unavailable. It does not score the local fallback as if GPT-5 Nano produced
it. A paid-credit rerun is still required for a real cross-provider quality
comparison.

## Quality scores

Higher is better. A 100 means perfect only for that named dimension on this
seven-case synthetic set.

| Dimension | Google baseline | Google final | Change |
| --- | ---: | ---: | ---: |
| Factual accuracy | 95.2 | 100.0 | +4.8 |
| Hallucination safety | 97.6 | 100.0 | +2.4 |
| Important omissions | 100.0 | 100.0 | 0.0 |
| Conversation state | 100.0 | 100.0 | 0.0 |
| Action item recall | 100.0 | 100.0 | 0.0 |
| Reply coverage | 89.7 | 92.9 | +3.2 |
| Suggested reply usefulness | 100.0 | 100.0 | 0.0 |
| User identity accuracy | 100.0 | 100.0 | 0.0 |
| Voice fidelity | 95.2 | 100.0 | +4.8 |
| Punctuation and formatting | 97.1 | 100.0 | +2.9 |

This is not a 100 percent result. Reply coverage is 92.9. In one casual case,
a terse variant did not repeat every grounding detail even though it remained
sendable and mechanically compliant.

## Latency, tokens and cost

| Measurement | Google baseline | Google final | Change |
| --- | ---: | ---: | ---: |
| Mean operation latency | 13,947.8 ms | 15,577.7 ms | +1,629.9 ms |
| p50 operation latency | 12,684.4 ms | 16,069.4 ms | +3,385.0 ms |
| p95 operation latency | 23,130.5 ms | 35,445.6 ms | +12,315.1 ms |
| Prompt tokens | 91,235 | 93,578 | +2,343 |
| Completion tokens | 4,052 | 4,105 | +53 |
| Total tokens | 95,287 | 97,683 | +2,396 (2.5%) |
| Provider-call errors inside selected quality runs | 1/15 | 4/18 | +3 errors |
| Estimated cost | unavailable | unavailable | n/a |

The final latency regression is real and is not hidden by the quality gains.
All four final selected-run errors were `service_overloaded` responses recovered
by a later configured retry. Two additional complete final attempts each had two
case-level Google failures after all three retries returned HTTP 500. Successful
per-case pinned reruns were used to complete the seven-case quality matrix; the
failed attempts remain reliability evidence rather than being treated as model
quality failures.

Cost is `null` because the compatibility responses did not provide billed cost
and no explicit per-million-token rates were supplied. The evaluator accepts
explicit rates through `AI_EVAL_OPENAI_*` and `AI_EVAL_GEMINI_*` environment
variables rather than hardcoding prices that can become stale.

## Changes supported by the evaluation

- The summary and suggested-reply prompts now state that unnamed and uncertain
  outcomes must remain unnamed and uncertain.
- A deterministic evidence check replaces unsupported domain or outcome claims
  on genuinely ambiguous conversations. It does not rewrite conversations that
  explicitly name the domain.
- Suggested-reply guidance now says each alternative should cover every live
  required point, rather than distributing coverage across three fragments.
- Explicit mechanical user rules are derived from the configured profile,
  included in the prompt, validated after generation and repaired in code.
  Supported rules are no full stops, no exclamation marks, no question marks,
  no emoji and all-lowercase writing.
- The same deterministic repair runs on suggested replies and compose-in-voice.
- Provider calls now expose attempt-level model, latency and token observations
  to the evaluator without changing the user-facing AI contract.
- No change sends a message. Sending remains user-triggered.

## Representative local-thread review

A read-only aggregate review ran against the local database. The script selected
10 threads without printing or saving ids, names, messages, summaries, replies
or prompts:

- 2 short
- 2 long
- 2 pending
- 2 already replied
- 2 multi-action

Results:

- 10/10 had a summary and what-they-want value
- 10/10 had valid reply-brief and open-loop JSON
- 10/10 had no em/en dash violation in visible AI fields
- 10/10 had no banned coaching language
- 5 threads had cached suggested replies
- 5/5 cached sets had valid JSON, reply count, labels, length and configured
  mechanical-rule compliance

The other five threads had no cached suggestion set; absence was not counted as
invalid JSON. The aggregate report was written only to `/tmp`, with
`privateContentEmitted: false`.

## Commands

```text
npm run test:all
node --env-file=<local-env> --import tsx apps/runner/src/scripts/evaluate-ai-fidelity.ts --phase baseline --providers gemini,openai --output /tmp/rios-808-baseline.json
node --env-file=<local-env> --import tsx apps/runner/src/scripts/evaluate-ai-fidelity.ts --phase final --providers gemini,openai --output /tmp/rios-808-final.json
node --import tsx apps/runner/src/scripts/review-local-ai-fidelity.ts --db <local-db> --limit 10 --output /tmp/rios-808-local-review.json
```

## Known risks and required follow-up

- Add OpenAI credit and rerun all seven cases before using this work to choose
  between GPT-5 Nano and the Google provider.
- Google `gemma-4-31b-it` had repeated HTTP 500/503 responses. Provider
  reliability and the latency regression need a separate decision; retries
  recovered some calls but did not recover every full-pass call.
- Reply coverage is not perfect. The remaining terse-casual failure should stay
  in the regression set.
- Mechanical-rule detection recognises explicit English profile statements. It
  does not claim to understand every possible natural-language phrasing.
- The local review validates existing cached live outputs structurally. It does
  not commit or externally judge private message content.
