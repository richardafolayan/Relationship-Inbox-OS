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

Unsupported operations fail clearly and callers check optional capabilities
before offering them.

## Consequences

- Scan and send services stay platform-neutral.
- Platform-specific correctness and verification remain inside the adapter.
- UI controls must be capability-aware.
- A new platform needs an adapter, selector/config wiring where relevant, and
  focused identity, parse, send, and failure tests.

## Verification

- [`packages/core/src/adapters.ts`](../../packages/core/src/adapters.ts)
- [`packages/core/src/types.ts`](../../packages/core/src/types.ts)
- [`apps/runner/src/services/platform-factory.ts`](../../apps/runner/src/services/platform-factory.ts)
- [Platform adapter reference](../developer/platform-adapters.md)
