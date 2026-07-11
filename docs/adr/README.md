# Architecture decision records

These records describe decisions visible in the verified baseline. They do not
approve behavior that exists only on an unmerged workstream branch.

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](0001-local-first-split-runtime.md) | Accepted | Local-first split dashboard, runner, core, and desktop runtime |
| [0002](0002-platform-adapter-boundary.md) | Accepted | Normalize platform behavior behind one adapter contract |
| [0003](0003-sqlite-schema-synchronization.md) | Accepted with limitation | SQLite and guarded schema push, with no committed migration history |
| [0004](0004-durable-user-triggered-send.md) | Accepted | User-triggered replies through a durable asynchronous queue |
| [0005](0005-ai-routing-and-voice-controls.md) | Accepted | OpenAI-compatible provider routing plus deterministic output controls |
| [0006](0006-events-and-polling-recovery.md) | Accepted | Replayable local events with polling recovery |
| [0007](0007-forward-only-pilot-updates.md) | Accepted | Checksummed, data-preserving, forward-only pilot updates |

New ADRs use the next four-digit number and contain Context, Decision,
Consequences, and Verification sections. Amend an ADR only to correct the
record; supersede it when the decision changes.
