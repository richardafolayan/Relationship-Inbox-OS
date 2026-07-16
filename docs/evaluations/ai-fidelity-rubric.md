# AI fidelity evaluation rubric

This rubric and its synthetic fixtures were written before any #808 prompt
changes. The evaluator uses the same seven cases for the configured Google
provider and OpenAI GPT-5 Nano. It pins each provider so a fallback cannot be
mistaken for the provider under test.

The fixtures contain no copied private messages, real contact histories, API
keys, or user-specific identity assumptions. Names, topics, dates and voice
profiles are invented for evaluation.

## Coverage set

| Case | Required coverage |
| --- | --- |
| `short-scheduling-two-asks` | short conversation, new reply, action items |
| `long-old-context-new-contract` | long conversation, interruptions, old context, new reply, already answered points, action items |
| `multi-topic-unresolved-promise` | multi-topic conversation, unresolved promise, action items, new reply |
| `ambiguous-outcome` | ambiguous conversation, short conversation, uncertainty |
| `emotional-no-advice` | emotional conversation, boundary preservation, identity, different user voice |
| `casual-lowercase-no-stops` | different user voice, strict punctuation, short conversation, action item |
| `formal-source-table-no-exclamation` | already answered points, different user voice, strict punctuation, action item |

The fixture module fails its regression test if any required category is no
longer represented.

## Score meanings

All quality dimensions are reported from 0 to 100, where 100 is best. A score
of 100 is only a perfect score on this defined set. It is not a claim about all
possible conversations.

- **Factual accuracy:** starts at 100 and falls when a fixture's explicit
  contradiction traps appear, such as changing Manchester to London or adding
  a surgery date that was never supplied.
- **Hallucinations:** 100 means no defined fabricated fact or fabricated action
  appeared. This is separate from accuracy so invented homework is counted as
  a hallucination even when the prose around it is otherwise accurate.
- **Important omissions:** recall of the fixture's pre-written important facts
  in the summary, where-things-stand output, substance bullets or action rail.
- **Conversation state:** exact `needs_reply`, an expected range for required
  actions, and explicit preservation of uncertainty where the evidence is
  ambiguous.
- **Action item recall:** recall of every explicit live action and exclusion of
  resolved, answered or withdrawn actions.
- **Reply coverage:** mean coverage of the pre-written reply beats across every
  suggested reply. One complete option cannot hide two incomplete options.
- **Suggested reply usefulness:** correct number of non-empty replies, maximum
  280 characters, no model meta-talk, distinct variants, and grounding in at
  least one expected reply beat.
- **User identity accuracy:** absence of the fixture's ownership-flip traps,
  such as claiming the contact's job, parent or visa situation as the user's.
- **Voice fidelity:** compliance with mechanically derivable user rules,
  absence of explicitly avoided phrases, and at least one natural voice anchor
  across the set when the fixture supplies anchors.
- **Punctuation and formatting compliance:** deterministic checks for the
  fixture's punctuation rules plus the product-wide ban on em dashes, en
  dashes, semicolons and colons, valid unique labels, and reply length.

Pattern groups use multiple accepted phrasings. A fact passes if any accepted
pattern matches. Forbidden groups fail if any forbidden pattern matches. The
patterns and rationales live beside each synthetic conversation in
`apps/runner/src/evaluation/ai-fidelity-fixtures.ts`.

## Operational measurements

Each summary and suggested-reply call records:

- exact provider and model
- every attempt and whether it succeeded
- end-to-end latency
- provider-call latency
- prompt, completion, cached-prompt and total tokens when returned by the API
- estimated cost only when explicit per-million-token rates are supplied via
  `AI_EVAL_OPENAI_INPUT_USD_PER_MILLION`,
  `AI_EVAL_OPENAI_OUTPUT_USD_PER_MILLION`,
  `AI_EVAL_GEMINI_INPUT_USD_PER_MILLION`, and
  `AI_EVAL_GEMINI_OUTPUT_USD_PER_MILLION`

Cost remains `null` when rates or provider token data are unavailable. The
evaluator does not silently hardcode a price that may go stale.

## Pass criteria

The focused #808 target is:

- no regression in factual accuracy, hallucinations or identity accuracy
- 100 on deterministic punctuation and formatting compliance
- improvement in important omissions, state, action recall and reply coverage
  relative to the captured baseline
- no provider result accepted from a fallback provider
- both providers complete the identical case list

Latency, token usage and cost are reported rather than folded into the quality
score. A slower result is visible without being mislabeled as a factual error.

## Local-thread review boundary

Representative local-thread review is a separate, non-committing check. It may
read selected local threads and call the configured provider, but it must not
print, save or commit message bodies, names, generated prose or raw prompts.
Only aggregate counts, rule violations, provider/model, latency and token totals
may leave the temporary review process. Sending remains user-triggered and is
outside the evaluator.
