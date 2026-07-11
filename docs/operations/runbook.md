# Operator runbook

Use this for normal operation, health checks, backup, recovery, and bounded
maintenance. Symptom-led diagnosis is in the
[troubleshooting playbook](../troubleshooting/playbook.md). Build and release
work is in the [release runbook](releases.md).

## Safety rules

- Never test a send, reaction, edit, poll, or feedback submission against a
  real person without explicit intent.
- Stop the app before copying or replacing the SQLite database or browser
  profiles.
- Treat `.env`, database backups, profiles, screenshots, DOM dumps, media, and
  PII-enabled traces as private.
- Do not reset a platform session because a selector failed; preserve evidence
  and confirm the failure class first.
- Do not use `db push`, admin reset, or database deletion to hide an unknown
  data problem.
- Keep `DEV_LOG_PII` and `RUN_TRACE_PII` off for routine operation.

## Start, stop, and restart

### Source pilot install

Start from Applications or run:

```bash
cd ~/RelationshipInboxOS
npm run start:student
```

The wrapper applies one pending update, reconciles distribution settings,
prepares changed build/schema inputs, starts runner and dashboard, and opens
the browser.

Stop the Applications launcher normally. In a foreground Terminal, press
Control-C. Restart after changing `.env`, macOS permissions, Node, native
dependencies, or provider keys.

### Development checkout

```bash
npm run dev
```

`npm run dev:fast` skips database generation/push and core build; use it only
when those inputs are known current. The Turbo daemon can serve another
worktree's cwd. If edits are missing, inspect the listening process with
`lsof` and stop only the process whose cwd belongs to that checkout.

### Electron development shell

```bash
npm run dev:desktop
```

The shell starts `scripts/start-app.mjs`, waits for the dashboard, restricts
window navigation to the local dashboard, and logs child output.

## Health-check sequence

Run the no-mutation doctor first:

```bash
npm run doctor
```

Then check live surfaces:

```bash
curl -fsS http://127.0.0.1:4001/health
curl -fsS http://127.0.0.1:4001/data/platforms
curl -fsS http://127.0.0.1:4001/data/ai-status
curl -fsS http://127.0.0.1:4001/system/version
```

Interpret `/health`:

| Field | Meaning |
| --- | --- |
| `runnerStatus` | `ONLINE` when idle, `SCANNING` during a scan |
| `lastScanAt` | Most recent connected-platform scan time |
| `queueDepth` | Current plus queued scan/platform-mutex work |
| `connectedPlatforms` | Platform rows currently `CONNECTED` |
| `currentScanPlatform` | Active scan platform or null |
| `enrichmentQueue` | Eligible pending/running enrichment only; zero when auto enrichment is disabled |
| `scanProgress` | Scope, processed/opened rows, total, percent, and optional ETA |

A healthy runner can still have one degraded platform. Use `/data/platforms`
and the Activity receipts rather than restarting everything immediately.

## Logs and diagnostic evidence

Collect the smallest relevant evidence and remove private artifacts after the
case is closed.

| Surface | Location / access | Use |
| --- | --- | --- |
| Activity and receipts | `http://localhost:3100/logs` or `/data/logs?limit=300` | Scan, send, control, selector, and system audit rows |
| Installer | `~/Library/Logs/RelationshipInboxOS/install-*.log` | Node download, relocation, npm, Prisma, model, and launcher creation |
| Source launcher | `~/Library/Logs/RelationshipInboxOS/app-*.log` | Source `.app` startup output |
| Electron desktop | `~/Library/Logs/RelationshipInboxOS/desktop-*.log` | Child startup, dashboard load, recovery, and process exit |
| Update/restart | `<install>/logs/app-restart.log` and `update-restart-*.log` | Detached update and relaunch |
| Run traces | `apps/runner/logs/runs` by normal workspace cwd, or `RUN_TRACE_DIR` | Per-scan decision/action/summary artifacts when enabled |
| Selector artifacts | `data/screenshots`, `data/dom_dumps` | External UI failure confirmation |
| Latest LinkedIn pointer | `apps/runner/LATEST_LINKEDIN_SCAN.txt` when written | Most recent traced scan directory |

`AuditLog.detailsJson`, screenshots, DOM, and PII traces can contain message or
profile context. Do not paste them into an issue without review/redaction.

### Enable one bounded trace

Stop the runner, set `RUN_TRACE=1`, keep `RUN_TRACE_PII=0`, restart, reproduce
one scan, then turn tracing off. Set an explicit `RUN_TRACE_DIR` if the runner
cwd is uncertain.

## Back up and restore local state

### Database-only backup

1. Stop the app.
2. Create a private backup directory.
3. Choose the active data root. Source installs normally use
   `~/RelationshipInboxOS/data`; packaged installs use
   `~/Library/Application Support/Relationship Inbox OS/data`.
4. Copy all SQLite siblings together. For a source install:

```bash
mkdir -p ~/RelationshipInboxOS-backups/db
cp -p ~/RelationshipInboxOS/data/inbox-os.sqlite* ~/RelationshipInboxOS-backups/db/
```

5. Record the app version and commit from `package.json`/`release.json` with
   the backup.

### Full local-state backup

Stop the app, then copy `.env`, `data`, and `logs` to encrypted or otherwise
private storage. This includes API keys, messages, browser sessions, media,
and transcripts. Do not upload it to a normal issue or shared drive.

### Restore

1. Stop every runner/dashboard process belonging to the install.
2. Preserve the current `data` directory under a new name instead of deleting
   it.
3. Restore the matching database files or complete data directory.
4. Confirm ownership and write access.
5. Run `npm run db:generate`, then `npm run doctor`.
6. Start the app and verify `/health`, platform status, inbox count, one thread,
   and send queue before any external send.

Do not restore browser profiles into a running browser or mix a database from
one point in time with newer WAL/SHM files.

## Database and schema operation

Normal preparation:

```bash
npm run db:generate
npm run db:push
```

Before `db:push` on an existing pilot database, take a stopped backup. The
repository has no committed migration history. Follow the
[schema-change procedure](../developer/data-and-storage.md#safe-schema-change-procedure)
for anything beyond an additive change.

If the dashboard is empty after a database command, confirm the runner's
resolved `DATABASE_URL` and file size before scanning or resetting. A relative
path pointing at a second file is a configuration problem, not missing user
data.

## Scan and platform procedures

### Normal rescan

Use Command-K or the Settings platform card. Start with update scope. Use a
full scan only for first import or confirmed drift. Watch `/health`, platform
status, and receipts.

### Selector diagnosis

```bash
npm run test:selectors:linkedin
```

This is an external browser action. Preserve the audit reason and artifacts.
Do not blindly replace selectors from one transient empty page.

### LinkedIn smoke ingest

```bash
npm run linkedin:smoke
```

This opens the account and performs a bounded one-thread ingest. Use only with
the account owner present and review the trace afterward. It is not a safe CI
command.

### iMessage history import

The operator route supports a dry run before writing. Use the Settings/UI
entry point where available, review candidate counts, then apply. It uses the
same idempotent persistence path and skips synchronous per-thread AI during
bulk history import.

### Name repair

Preview before applying:

```bash
npm run imessage:backfill-names --workspace @inbox-os/runner
npm run imessage:backfill-names --workspace @inbox-os/runner -- --apply
```

Use only after Contacts or the optional vCard contains the expected identities.

### Session reset

Reset only the affected platform after confirming an expired/corrupt session.
It discards app-owned sign-in state and requires login or QR linking again.
It does not fix selectors, network outages, Full Disk Access, or AI errors.

## Send queue operation

Use `/data/send-queue` and thread receipts to distinguish `SCHEDULED`,
`PENDING`, `SENT`, `FAILED`, and `CANCELLED`.

- A scheduled row can be edited or canceled only while still `SCHEDULED`.
- An unclaimed pending row resumes after runner restart.
- A claimed row left by a crash becomes `FAILED/INTERRUPTED` and must be
  checked in the real platform before a user retries.
- Do not edit send rows directly or flip an uncertain request back to pending.
- Do not delete staged attachments while their request is scheduled/pending.

## macOS permission recovery

### Full Disk Access

Open Settings through the app or System Settings, enable the actual launching
app/process shown by the UI, quit completely, and reopen. A scan retry without
a restart does not refresh this permission.

### Messages Automation and Accessibility

First inspect System Settings and enable the current launcher/terminal for
Messages automation. File sends also need Accessibility for UI scripting.

The in-app permission reset runs `tccutil reset AppleEvents`, which clears all
Automation grants for every app on the Mac. Use it only after error `-1743` or
equivalent is confirmed and a normal toggle cannot recover. It is not a
general iMessage fix and should not be the first step.

## Artifact cleanup

Preview:

```bash
npm run cleanup:artifacts
```

Apply only after reviewing the planned run, screenshot, DOM-dump, and repair
paths:

```bash
npm run cleanup:artifacts -- --apply
```

This command must not touch the SQLite database, profiles, models, preserved
voice media, or user attachments outside its declared artifact roots. If the
preview names an unexpected path, stop.

## Key and token rotation

1. Revoke the old provider or service credential at its source.
2. Update the correct local `.env`, GitHub Actions secret, or
   `.env.release.local`; do not put it in `.env.example`.
3. Restart the runner for AI/GitHub key changes.
4. Check `/data/ai-status` or perform a dry-run/live publish verification as
   appropriate.
5. Remove old logs or backups only after verifying they do not contain the
   credential.

The pilot feedback token is distributed in builds and should be treated as
low-value and rotatable. Dropbox refresh tokens, AI keys, and GitHub tokens
are high-value and must never ship.

## Destructive admin reset

The `/admin/reset` path requires `ADMIN_RESET_ENABLED`, a token, a typed
confirmation, scan abort, global/platform locks, and an audit receipt. It
deletes the selected platform graph. It is not routine recovery.

Before use:

1. prove the affected rows are wrong and cannot be repaired;
2. take a stopped full backup;
3. record the selected platform and expected deletion counts;
4. confirm no scan, send, enrichment, or transcription work is active;
5. arrange a verified re-import path.

If any item is missing, do not apply the reset.
