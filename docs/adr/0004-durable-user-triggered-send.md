# ADR 0004: Durable, user-triggered send

Status: Accepted

## Context

External sends can take longer than the dashboard proxy timeout, can fail
after apparent acceptance, and must never be duplicated after a crash.

## Decision

Require an explicit user send or schedule action. Persist every request under
a unique client send ID, acknowledge the queue insertion quickly, and drain
requests serially outside the HTTP request. Claim a row before dispatch.
After a crash, resume only unclaimed rows; convert claimed, uncertain rows to
`FAILED/INTERRUPTED` for human verification.

## Consequences

- Closing the dashboard does not lose an accepted send request.
- The UI can show honest pending, sent, failed, and uncertain states.
- External adapters do not need to pretend they support wire-level idempotency.
- Retrying an interrupted or failed send remains a user decision.

## Verification

- [`apps/runner/src/services/send.ts`](../../apps/runner/src/services/send.ts)
- [`apps/runner/src/services/send-queue.ts`](../../apps/runner/src/services/send-queue.ts)
- [`apps/runner/src/services/scheduled-send-promoter.ts`](../../apps/runner/src/services/scheduled-send-promoter.ts)
- [`tests/runner-send-claim-crash-safety.test.mjs`](../../tests/runner-send-claim-crash-safety.test.mjs)
- [`tests/runner-scheduled-send-race-safety.test.mjs`](../../tests/runner-scheduled-send-race-safety.test.mjs)
