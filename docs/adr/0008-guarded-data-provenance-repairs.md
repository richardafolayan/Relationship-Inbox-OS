# ADR 0008: Guarded data provenance repairs

Status: Accepted

## Context

Two pilot upgrades need to change stored data rather than only add schema.
Older send requests do not carry trustworthy source provenance, and Instagram
messages created before stable platform identities can use window-relative
occurrence keys. Treating either predecessor value as current truth can permit
an unsafe send or collapse two real messages.

The pilot still uses Prisma schema synchronization without an ordered migration
history, as recorded in ADR 0003. These repairs therefore need their own
detection, transaction, recovery, and verification rules.

## Decision

The launcher owns the one-time send-source repair. Before Prisma synchronization,
it opens the existing SQLite file, validates any durable repair marker, and uses
an immediate transaction to add the source column when needed, relabel every
pre-marker request as `legacy_unknown`, and write the exact versioned marker.
A fresh database receives the same marker after schema creation and before launch
succeeds. A missing, malformed, or inconsistent marker fails closed. The Prisma
schema has no default that can silently label an unknown request as manual.

Instagram occurrence keys are migration hints only. A scan may rekey a legacy
message when an exact source timestamp or a timestamp-disambiguated automation
receipt proves that it is the same physical message. The receipt must have
exact outgoing-layout provenance, and matching considers every same-signature
receipt rather than trusting its window-relative occurrence. Multiple matches,
a canonical and verified legacy twin, or potentially matching malformed
provenance quarantines that mapping without stopping unrelated writes. A legacy
first-seen observation that predates a current exact source timestamp beyond a
clock-skew margin proves that the messages are distinct. A changed source or
target during transactional apply rolls the transaction back and quarantines
the affected planned mappings at the scan boundary.

When identity cannot be proved, the scan preserves the legacy row and skips only
an unresolved canonical write that does not already exist. Other messages in
the thread continue to persist. The scan reports parsed, persisted, and
quarantined counts separately, marks the platform `DEGRADED`, retains the last
fully fresh `lastScanAt`, and does not advance its incremental watermark. A
per-thread check returns and emits `freshnessComplete: false`, so the dashboard
cannot turn a quarantined result into "No new messages". A source-change event
is not labelled `MESSAGES_PERSISTED` when every parsed message was blocked. A
later scan may resolve the mapping if stronger evidence appears.

A verified Instagram rekey preserves the Message ID and changes the message key
and any embedded audio fingerprint in one database transaction. Message rekeys
and transcription creation share a per-message in-process lock. Transcription
persistence reads the current message key inside that lock, so work started
before a rekey cannot later store the predecessor fingerprint.

The shared scan queue does not import this Instagram repair. A generic
reconciler registry is wired at the runner composition root, and only the
Instagram reconciler interprets its migration scheme or queries predecessor
rows.

The launcher database backup remains the recovery boundary for the one-time
send-source repair. SQLite transaction rollback covers a failed repair. A failed
Instagram rekey rolls back without deleting either message, and a quarantined
mapping performs no message mutation.

## Consequences

- Historical requests never gain invented user-triggered provenance.
- The repair marker makes predecessor detection durable and idempotent.
- Stable Instagram identities can replace verified legacy keys without changing
  reply references or orphaning transcription state.
- Unprovable Instagram history can remain on its predecessor key until evidence
  or a future manual repair exists, but it cannot stop unrelated thread updates
  or produce a false full-freshness claim. Product surfaces retain the last
  known fully fresh scan time and show the degraded-platform warning.
- The message identity lock coordinates one runner process. The runner remains a
  singleton for a pilot data directory.

## Verification

- [`scripts/lib/repair-schema-data.mjs`](../../scripts/lib/repair-schema-data.mjs)
- [`scripts/start-app.mjs`](../../scripts/start-app.mjs)
- [`apps/runner/src/services/instagram-message-key-upgrade.ts`](../../apps/runner/src/services/instagram-message-key-upgrade.ts)
- [`apps/runner/src/services/message-identity-reconciliation.ts`](../../apps/runner/src/services/message-identity-reconciliation.ts)
- [`apps/runner/src/services/message-identity-lock.ts`](../../apps/runner/src/services/message-identity-lock.ts)
- [`apps/runner/src/services/transcription/transcription-service.ts`](../../apps/runner/src/services/transcription/transcription-service.ts)
- [`tests/runner-send-source-upgrade.test.mjs`](../../tests/runner-send-source-upgrade.test.mjs)
- [`tests/runner-instagram-message-key-upgrade.test.mjs`](../../tests/runner-instagram-message-key-upgrade.test.mjs)
- [`tests/runner-transcription-service.test.mjs`](../../tests/runner-transcription-service.test.mjs)
