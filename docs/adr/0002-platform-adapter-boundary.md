# ADR 0002: Normalized platform adapter boundary

Status: Accepted

## Context

LinkedIn and beta social platforms use browser automation, iMessage reads
SQLite and sends through AppleScript, and WhatsApp uses `whatsapp-web.js`.
Their native identifiers, events, and capabilities differ.

## Decision

Expose connection, candidate discovery, message normalization, send, open,
and close through `PlatformAdapter`. Keep reactions, edits, polls, incremental
watermarks, and retracted-send collection optional. Persist only shared
`ThreadStub`, `NormalizedMessage`, attachment, and receipt shapes.

Cross-cutting persistence repairs use a platform-neutral reconciler registry.
The composition root injects a reconciler for a platform, while the shared scan
service sees only blocked and quarantined message keys. Migration scheme values
remain opaque strings outside the platform implementation.

`ThreadStub.recipientVerificationLabel` carries the last platform-reported
conversation label when a platform needs recipient verification. It is stored
separately from the user-facing `Person.displayName`, so an operator rename does
not become platform identity evidence.

Browser sends bind the exact composer element before recipient verification.
After humanized delays, the final route, recipient, composer, and control
ownership checks run in the same synchronous browser task as each composer
mutation and the Send click. It binds a send-control handle before measuring
locality, then measures and clicks that same handle. A send control must have
an exact Send semantic or share the composer's form, and must also be uniquely
and horizontally associated with the composer.

Candidate discovery exposes a typed optional collection-boundary capability.
A bounded Instagram network and DOM snapshot remains useful for ingest, but it
cannot publish platform-wide freshness unless every collection view proves the
inbox is empty. Empty evidence must be scoped and structural, with no thread,
loading, error, or failed network signal. Current DOM candidates, with unread
rows first, take priority before network and DOM identities are deduplicated and
the distinct-thread limit is applied.

Unsupported operations fail clearly and callers check optional capabilities
before offering them.

## Consequences

- Scan and send services stay platform-neutral.
- Platform-specific correctness and verification remain inside the adapter.
- Platform-specific data repair remains behind an injected generic capability.
- Humanized browser delays cannot create a gap between ownership checks and an
  external browser mutation.
- A bounded candidate window cannot become an authoritative freshness claim.
- UI controls must be capability-aware.
- A new platform needs an adapter, selector/config wiring where relevant, and
  focused identity, parse, send, and failure tests.

## Verification

- [`packages/core/src/adapters.ts`](../../packages/core/src/adapters.ts)
- [`packages/core/src/types.ts`](../../packages/core/src/types.ts)
- [`apps/runner/src/services/platform-factory.ts`](../../apps/runner/src/services/platform-factory.ts)
- [`apps/runner/src/services/message-identity-reconciliation.ts`](../../apps/runner/src/services/message-identity-reconciliation.ts)
- [Platform adapter reference](../developer/platform-adapters.md)
