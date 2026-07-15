# Database, migrations, and storage

This is the canonical data reference. The Prisma schema itself remains the
field-level authority:
[`packages/core/prisma/schema.prisma`](../../packages/core/prisma/schema.prisma).

## Database location and connection

The pilot uses SQLite. The runner resolves the database in this order:

1. blank or absent `DATABASE_URL`: `<project-root>/data/inbox-os.sqlite`;
2. relative `file:` URL: re-anchored to the project root;
3. absolute `file:` URL: used as written;
4. other URL: passed to Prisma, although the committed datasource provider is
   `sqlite` and the verified pilot path is a local file URL.

[`db.ts`](../../apps/runner/src/db.ts) applies `journal_mode=WAL` through a
short-lived direct connection before normal Prisma work. Failure to set WAL is
non-fatal and affects concurrency performance, not schema validity.

The runner is the intended database writer. Do not edit the live file while
the app is running.

## Schema map

| Prisma model / table | Purpose and important fields | Keys and relations |
| --- | --- | --- |
| `Platform` / `platforms` | Connection status, last scan/error, and first connected time for each enum platform | Unique `name` |
| `Person` / `people` | Platform identity, auto/manual display name and profile URL provenance, avatar, notes, groups/tags JSON, enrichment state, birthday, favorite time | One-to-many threads/jobs; optional enrichment; display-name index |
| `PersonEnrichment` / `person_enrichments` | Structured LinkedIn profile fields, JSON lists, cached relationship summary, and starters | Unique `personId`, cascade from Person |
| `EnrichmentJob` / `enrichment_jobs` | Persistent pending/running/done/failed profile work, attempts, next retry, trigger, safe error | Person relation; status/time and person indexes |
| `Thread` / `threads` | Platform identity, reply state, timestamps, risk, summaries, reply brief, open loops, memory, group flags, suggested replies cache, archive/snooze/reminder, category, close verdict, reconnect score | Unique `(platform, platformThreadId)`; Person relation; cascade messages/drafts/send requests; hot-path indexes |
| `Message` / `messages` | Stable platform key, direction, timestamp, text, sender, raw/attachment JSON, automation provenance, app-level reply parent | Unique `(threadId, platformMessageKey)`; Thread relation; thread/time, reply-parent, and global time/direction indexes |
| `MessageAudioTranscription` / `message_audio_transcriptions` | One selected transcription per message, dedup fingerprint, state, provider/model, safe error, selected tier, refinement, and `needsAiRefresh` | Unique `messageId` and `audioFingerprint`; cascade from Message |
| `MessageAudioTranscriptionAttempt` / `message_audio_transcription_attempts` | Immutable-per-model tier attempt, status, raw transcript, duration, and safe error | Unique `(transcriptionId, tier, model)`; cascade from parent transcription |
| `Draft` / `drafts` | Persisted editable thread draft text | Thread relation and thread index |
| `AuditLog` / `audit_logs` | Timestamped stage/action/status, structured details JSON, artifact paths, indexed thread ID | Indexes for recent platform/action reads and thread receipts |
| `Setting` / `settings` | JSON settings by unique key, including `app_settings`, selector overrides, demo seed manifest, and `operator_profile_v1` | Unique `key` |
| `SendRequest` / `send_requests` | Durable immediate/scheduled send state, client ID, text, schedule, receipt/error, staged attachments, reply parent | Unique `clientSendId`; Thread relation; status/schedule indexes |

## JSON columns

SQLite JSON-shaped fields are stored as strings. Parse through existing safe
helpers and preserve forward-compatible defaults.

- `Person.tagsJson`: relationship groups/tags.
- `PersonEnrichment.*Json`: profile lists, recent activity, mutual names,
  starters.
- `Thread.openLoopsJson`, `dismissedOpenLoopsJson`, `toneNotesJson`,
  `rememberJson`, `replyBriefJson`, `suggestedRepliesJson`: derived thread state.
- `Message.rawJson`, `attachmentsJson`: adapter metadata and normalized media.
- `MessageAudioTranscription.refinementJson`: sanitized refiner diagnostics.
- `AuditLog.detailsJson`: structured receipts with private-detail controls.
- `Setting.valueJson`: version-tolerant application/operator settings.
- `SendRequest.receiptJson`, `errorJson`, `attachmentsJson`: queue result and
  staged-send state.

Do not query inner JSON fields on hot paths when a dedicated indexed column
exists. `AuditLog.threadId` was added specifically to avoid scanning
`detailsJson`.

## Schema synchronization and migrations

There is no committed Prisma migration directory or ordered migration history
in the verified baseline. Current install, launch, and update paths use:

```bash
npm run db:generate
npm run db:push
```

`start-app.mjs` hashes the schema and runs these preparation steps when the
schema changed or the database/client is missing. `db:push` is suitable for
the current additive pilot workflow. It is not a substitute for a planned
destructive or data-transforming migration.

`npm run db:migrate` runs `prisma migrate dev` and is a developer convenience.
Because no migration history is committed, do not present it as the pilot
upgrade path.

### Safe schema-change procedure

1. Stop the app and back up the active data root's `inbox-os.sqlite`, `-wal`,
   and `-shm` files.
2. Decide whether the change is additive. For rename, type change, data
   rewrite, or destructive change, write an explicit migration/rollback plan
   before modifying the schema.
3. Update the Prisma schema and generate the client.
4. Apply against a disposable copy first.
5. Add a focused schema/data regression test.
6. Run lint, the full test suite, and a fresh-start plus existing-data launch.
7. Update this page and the relevant ADR if the migration policy changes.

Never run an admin reset or delete the database as a substitute for migrating
pilot data.

## Runtime storage locations

Paths below are relative to the active project root unless stated otherwise.

| Location | Contents | Retention / safety |
| --- | --- | --- |
| `data/inbox-os.sqlite`, `-wal`, `-shm` | Primary database and SQLite runtime files | User data. Back up together while stopped; never prune as an artifact. |
| `data/profiles/linkedin`, `instagram`, `tiktok` | App-managed browser sessions | User sign-in state. Reset only for a confirmed session problem. |
| `data/profiles/whatsapp` | `whatsapp-web.js` LocalAuth session | User sign-in state. Removing requires a new QR link. |
| `data/profiles/__managed_person_profiles` and personal mirror root | Managed personal Chrome mirrors and metadata | Recreated from configured Chrome source; can be large and sensitive. |
| `data/models` | Transformers transcription model cache | Re-downloadable, large, retained across updates. |
| `data/imessage-voice-snapshots` | Preserved iMessage voice files | Private media, retained for playback/transcription. |
| `data/linkedin-voice-messages` | Captured LinkedIn voice files | Private media. |
| `data/whatsapp-media` | Inbound and mirrored outbound WhatsApp media | Private media. |
| `data/outgoing-attachments`, `data/dictation-uploads` | Staged user-selected send/dictation files | Temporary; normal request/send cleanup removes them. Investigate before manual deletion during a pending send. |
| `data/screenshots`, `data/dom_dumps` | Adapter failure/selector artifacts | Diagnostic, may contain private content. Use cleanup policy and never attach automatically to feedback. |
| `data/repair` | Repair-script artifacts | Review the producing script before removal. |
| `data/contacts.vcf` | Optional contact-name override | User-maintained sensitive data. |
| `data/app-prepare-stamps.json` | Build/schema content hashes | Recreated; deleting forces preparation. |
| `data/pending-update.json` | One-shot staged update intent | Cleared before apply to avoid loops. Do not recreate by hand. |
| `logs/runs` or `apps/runner/logs/runs` | Optional scan run traces, depending on runner cwd or `RUN_TRACE_DIR` | Diagnostic, may contain PII when explicitly enabled. |
| `logs/*.log` | Update/restart logs in the installation | Preserve across updates; safe to rotate after diagnosis. |
| `release-dist` | Local ZIP, manifest, checksum, `.app`, and DMG outputs | Rebuildable and gitignored. Contains distribution artifacts, never user data by design. |

### External macOS locations

| Location | Purpose |
| --- | --- |
| `~/RelationshipInboxOS` | Default source installation and its data/logs |
| `~/Applications/Tovi.app` | Lightweight launcher created by the source installer |
| `~/.rios-node` | App-managed Node 22 for the source installer |
| `~/Library/Messages/chat.db` plus WAL/SHM | Apple Messages database, read-only by this app |
| `~/Library/Application Support/AddressBook` | Contacts databases, read-only by this app |
| `~/Library/Application Support/Google/Chrome` | Personal Chrome source profile, mirrored rather than run in place |
| `~/Library/Logs/RelationshipInboxOS` | Installer/source-launcher logs |
| `~/Library/Application Support/Relationship Inbox OS` | Packaged `.env`, `data/`, and process/migration state |
| `~/Library/Logs/RelationshipInboxOS` | Packaged desktop and child-process logs |
| Sibling `.rios-backup-<timestamp>` directories | Source updater rollback copies, newest two retained by default |

The packaged app reads code from
`Tovi.app/Contents/Resources/app` but does not write runtime
state there. On first packaged launch, if `~/RelationshipInboxOS/data` exists
and the new database does not, the user can import the legacy data and `.env`,
start fresh, or quit. Import copies data and preserves the source directory.

## Backup and restore

The operational steps are in the
[operator runbook](../operations/runbook.md#back-up-and-restore-local-state).
Backups contain private messages, profiles, media, transcripts, and keys when
`.env` is included. Store them with the same care as the source accounts.
