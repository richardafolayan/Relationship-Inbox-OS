# Message lifecycle

This is the canonical trace for incoming messages, persistence, AI processing,
presentation, and replies. Platform-specific capability differences are in
the [adapter reference](../developer/platform-adapters.md).

## Incoming message to inbox

1. **A trigger requests a scan.** The trigger can be a user action through
   `POST /control/scan`, the one-second scheduler deciding a platform is due,
   the iMessage `chat.db` watcher, the WhatsApp incoming-message callback, or
   a targeted post-action rescan.
2. **The scan queue accepts or rejects the job.**
   [`scan-queue.ts`](../../apps/runner/src/services/scan-queue.ts) serializes
   jobs, prevents overlapping LinkedIn work, applies retry cooldowns and
   adaptive backoff, and emits `SCAN_STARTED`.
3. **The adapter discovers candidates.** The queue resolves an incremental
   plan where the adapter supports it. iMessage compares an opaque database
   watermark and can return only changed chats. LinkedIn uses its streaming
   inbox path and update/full scope rules. Other adapters return unread and
   recent thread stubs.
4. **The adapter reads messages.** A candidate is opened only after identity
   and skip checks. `fetchThreadMessages` returns `NormalizedMessage` values
   in the shared contract.
5. **Identity is resolved before persistence.** LinkedIn prefers stable
   profile URL over display name. Threads are unique by platform and platform
   thread ID. iMessage can later merge sibling handle threads for presentation,
   but the persisted platform threads remain distinct.
6. **Person, thread, and messages are written.** The queue creates or updates
   `Person` and `Thread`, then upserts `Message` rows by the compound
   `(threadId, platformMessageKey)` key. Incoming rows are batched in Prisma
   transactions. Outgoing rows are reconciled against send-time rows to avoid
   duplicate bubbles.
7. **Audio work is queued after message persistence.** Voice, audio, and video
   attachments cause a fire-and-forget transcription request. The stable audio
   fingerprint prevents repeated work. The scan never waits for transcription.
8. **Derived thread state is recomputed.** Message timestamps determine
   `needsReply`, latest preview, and risk. A changed inbound hash can trigger
   the combined summary and reply-brief call, first classification, and the
   open/closed classifier. Provider failure preserves prior derived state or
   uses the caller's safe fallback.
9. **The final thread update is committed.** The runner persists summaries,
   open loops, memory, reply brief, category, close status, risk, and current
   message metadata. A new inbound clears snooze and can resurface an archived
   thread.
10. **The runner announces the change.** `THREAD_UPDATED`, scan progress, and
    scan completion events enter the bounded event bus and invalidate the
    inbox cache. Audit receipts record the job, platform, stage, and outcome.
11. **The dashboard refreshes.** The browser receives the event through the
    Next events proxy and refreshes relevant cached data. Visible polling of
    `/health` and `/data/inbox` is the recovery path if an event was missed.
    Inbox rows can paint before slower platform-card and audit-log context;
    only the first 80 matching rows mount until the user asks to show more.

## Persistence rules

- Platform message keys are preferred. A stable hash is used only when an
  adapter cannot provide one.
- iMessage reads a deeper message window than browser platforms and filters
  known non-content system events before they influence reply state.
- Send-time and scan-time outbound rows can have different platform keys.
  Reconciliation compares normalized content and a bounded time window, and
  also checks iMessage sibling threads.
- Retroactively failed iMessage outbound rows are removed when `chat.db`
  reports that the recipient did not receive them.
- AI state is cached by versioned hashes. Prompt or output-shape changes must
  bump the relevant version token to refresh stored results.

The schema and indexes are described in
[database and storage](../developer/data-and-storage.md).

## Thread and inbox presentation

`GET /data/inbox` loads active, non-snoozed threads and shapes them for Today,
Inbox, Reconnect, and the command palette. iMessage sibling chats for the same
person are folded to one visible row using the same canonical-sibling rules as
the thread endpoint.

`GET /data/thread/:threadId` returns message pages, the draft, send state,
reply brief, relationship memory, provider-source metadata, and supported
message actions. The dashboard presents the conversation and composer as the
primary surface. AI help is a secondary panel controlled by the operator's
help level.

## Reply send lifecycle

1. The user presses Send or explicitly schedules a reply. No background
   service invents or submits a reply on its own.
2. The dashboard creates a client send ID and posts text, optional attachments,
   optional poll data, schedule, and app-level reply parent.
3. The runner validates the thread, presenter/read-only gates, identity, and
   platform capability. Uploaded files are staged below `data/`.
4. Immediate sends create a durable `SendRequest` in `PENDING`. Scheduled
   sends create `SCHEDULED`; the promoter atomically moves due rows to
   `PENDING`.
5. The API returns queue acknowledgement before the external adapter call.
   The send worker claims and drains pending rows serially.
6. The adapter dispatches and verifies as far as that platform permits.
   LinkedIn verifies the sent bubble, iMessage polls `chat.db`, WhatsApp uses
   the library result and send guard, and beta browser adapters verify their
   thread context before sending.
7. On success, one outbound `Message` row is persisted, the thread is updated,
   the draft/reminder state is cleared as appropriate, and `MESSAGE_SENT` plus
   `THREAD_UPDATED` events are emitted.
8. On failure, `SendRequest` becomes `FAILED`, its safe error details remain
   available to the UI, and `MESSAGE_SEND_FAILED` is emitted. The user decides
   whether to verify on-platform and retry.
9. After a runner restart, an unclaimed pending row can resume. A claimed row
   with an uncertain external result is never sent again automatically; it is
   marked `FAILED` with `INTERRUPTED` so the operator verifies before resending.

The durable queue behavior is recorded in
[ADR 0004](../adr/0004-durable-user-triggered-send.md).

## Transcription refresh lifecycle

Transcription attempts persist separately from messages. A better local tier
or optional text refinement may replace the selected transcript but never a
failed higher tier. If a thread was already summarized, the transcription row
sets `needsAiRefresh`; reassessment is operator-triggered rather than silently
spending provider tokens.
