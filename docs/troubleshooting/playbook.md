# Troubleshooting playbook

Start with the read-only checks in the
[operator runbook](../operations/runbook.md#health-check-sequence). Each
playbook below follows the same cause-to-evidence structure. Preserve private
logs locally and redact before sharing.

## App does not start or the page says the runner is offline

### Symptom

The launcher exits, the Electron window stays on startup, the dashboard loads
but reports Runner offline, or `/health` does not answer.

### Likely causes

1. Node is missing, unsupported, or `better-sqlite3` was built for another
   Node ABI.
2. Dependencies, Prisma client, core output, or dashboard build are missing.
3. Runner or dashboard port belongs to another process.
4. Database/schema preparation failed because the path is unwritable.
5. A development Turbo process is serving another worktree.

### How to confirm each cause

1. Run `node -v` and `npm run doctor`; inspect the Dependencies and Node lines.
2. Inspect source/Electron startup logs for the failing prepare step; check
   `node_modules`, generated Prisma client, core `dist`, and dashboard `.next`.
3. Run `lsof -nP -iTCP:4001 -sTCP:LISTEN` and the same for 3100, then inspect
   each PID's cwd with `lsof -a -p <pid> -d cwd -Fn`.
4. Doctor reports the resolved database and nearest writable directory.
5. Compare the listener cwd and served commit with the intended worktree.

### Safe fix

Use the installer again for a pilot Node/runtime repair. In a developer
checkout, run `npm ci`, `npm run db:generate`, and `RIOS_REBUILD=1 npm run
start:app`. Stop only a conflicting process whose cwd belongs to this app,
then restart once.

### Relevant logs

[Installer, source launcher, Electron, and update logs](../operations/runbook.md#logs-and-diagnostic-evidence).

### Relevant source files

[`scripts/start-app.mjs`](../../scripts/start-app.mjs),
[`scripts/start-student.mjs`](../../scripts/start-student.mjs),
[`apps/desktop/main.cjs`](../../apps/desktop/main.cjs),
[`scripts/doctor.mjs`](../../scripts/doctor.mjs),
[`apps/runner/src/db.ts`](../../apps/runner/src/db.ts).

### Relevant tests

[`desktop-launcher.test.mjs`](../../tests/desktop-launcher.test.mjs),
[`runner-database-url.test.mjs`](../../tests/runner-database-url.test.mjs),
[`runner-bind-host-config.test.mjs`](../../tests/runner-bind-host-config.test.mjs),
[`installer-no-sudo-node.test.mjs`](../../tests/installer-no-sudo-node.test.mjs).

### When not to apply the fix

Do not kill a process with an unrelated cwd, delete `data`, run an admin reset,
or rebuild native modules under a different Node major merely because the
dashboard is slow to start.

## Port 3100 or 4001 is already in use

### Symptom

Startup reports `EADDRINUSE`, opens an old build, or one half repeatedly exits.

### Likely causes

1. Another source launcher is still running.
2. A different worktree's dev server owns the port.
3. An unrelated application uses the configured port.

### How to confirm each cause

1. Use `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
2. Inspect the PID cwd and command.
3. Compare cwd/command with every known Relationship Inbox OS worktree.

### Safe fix

Quit the matching app normally. If it does not exit, send TERM only to the PID
whose cwd is the intended or stale Relationship Inbox OS install. Otherwise
choose unused `RUNNER_PORT` and `DASHBOARD_PORT` values together and restart.

### Relevant logs

Source or Electron startup log and the Terminal process output.

### Relevant source files

[`apps/runner/scripts/free-runner-port.mjs`](../../apps/runner/scripts/free-runner-port.mjs),
[`apps/runner/src/config.ts`](../../apps/runner/src/config.ts),
[`apps/desktop/launcher.cjs`](../../apps/desktop/launcher.cjs).

### Relevant tests

[`desktop-launcher.test.mjs`](../../tests/desktop-launcher.test.mjs),
[`runner-bind-host-config.test.mjs`](../../tests/runner-bind-host-config.test.mjs).

### When not to apply the fix

Do not use a broad `killall node`, kill a process without checking cwd, or
expose the runner on a non-loopback host to avoid a local port conflict.

## A scan completes but the inbox is empty or missing conversations

### Symptom

The scan reports completion but Today/Inbox has no rows or fewer rows than the
platform.

### Likely causes

1. The platform returned no eligible unread/recent candidates, or a UI filter,
   archive, snooze, category, or close-state rule hides them.
2. The runner and schema command used different SQLite files.
3. Platform auth, Full Disk Access, or selectors prevented collection.
4. Update scope stopped on unchanged rows while older history needs one full
   import/sweep.
5. Identity failed closed, especially an unresolved LinkedIn thread ID.

### How to confirm each cause

1. Clear Inbox filters, inspect Archived, and compare `/data/inbox` with the
   current view.
2. Doctor prints the resolved database. Compare the path and file size with
   `DATABASE_URL` and `data/inbox-os.sqlite`.
3. Check `/data/platforms`, its `lastError`, and scan audit receipts.
4. Check run summary scope, processed/opened counts, and first-full-backfill
   receipts.
5. Search audit/run trace for `unresolved_thread_id_after_open` or candidate
   skip decisions.

### Safe fix

Correct the one confirmed permission/auth/path problem and restart when
required. Run a targeted update scan first, then one full scan or the iMessage
history-import dry run if evidence says history was never backfilled. Preserve
fail-closed identity behavior.

### Relevant logs

Activity receipts, platform `lastError`, and an optional bounded
[run trace](../operations/runbook.md#enable-one-bounded-trace).

### Relevant source files

[`apps/runner/src/services/scan-queue.ts`](../../apps/runner/src/services/scan-queue.ts),
[`apps/runner/src/services/incremental-scan.ts`](../../apps/runner/src/services/incremental-scan.ts),
[`apps/runner/src/config.ts`](../../apps/runner/src/config.ts),
[`apps/dashboard/app/inbox/page.tsx`](../../apps/dashboard/app/inbox/page.tsx).

### Relevant tests

[`runner-incremental-scan-plan.test.mjs`](../../tests/runner-incremental-scan-plan.test.mjs),
[`runner-linkedin-identity.test.mjs`](../../tests/runner-linkedin-identity.test.mjs),
[`runner-database-url.test.mjs`](../../tests/runner-database-url.test.mjs),
[`dashboard-inbox-query.test.mjs`](../../tests/dashboard-inbox-query.test.mjs).

### When not to apply the fix

Do not delete the database, reset the account session, raise scan caps, or
weaken identity checks until logs prove that specific cause.

## iMessage conversations do not appear

### Symptom

LinkedIn works but iMessage is absent, not connected, or reports `chat.db`
unreadable.

### Likely causes

1. `IMESSAGE_ENABLED` is not true or iMessage is disabled in persisted
   Settings.
2. Messages is not signed in or `chat.db` does not exist.
3. The actual launcher/Node process lacks Full Disk Access.
4. `IMESSAGE_DB_PATH` points at the wrong file.

### How to confirm each cause

1. Check `.env`, `/data/settings`, and `/data/platforms`.
2. Open Messages and run doctor.
3. Doctor reports Found but not readable; Settings shows the responsible
   executable name/path.
4. Compare the configured path with `~/Library/Messages/chat.db`.

### Safe fix

Enable iMessage only on macOS, open the Full Disk Access pane from Settings,
enable the exact app/process, quit completely, reopen, then run an iMessage
update scan.

### Relevant logs

Platform last error, `IMESSAGE_WATCH_TRIGGER` receipts, startup log.

### Relevant source files

[`apps/runner/src/config.ts`](../../apps/runner/src/config.ts),
[`apps/runner/src/platforms/imessage-db.ts`](../../apps/runner/src/platforms/imessage-db.ts),
[`apps/runner/src/services/imessage-watcher.ts`](../../apps/runner/src/services/imessage-watcher.ts),
[`apps/dashboard/app/settings/page.tsx`](../../apps/dashboard/app/settings/page.tsx).

### Relevant tests

[`runner-imessage-chatdb-open-denied.test.mjs`](../../tests/runner-imessage-chatdb-open-denied.test.mjs),
[`runner-imessage-watcher.test.mjs`](../../tests/runner-imessage-watcher.test.mjs),
[`runner-imessage-db-construct-leak.test.mjs`](../../tests/runner-imessage-db-construct-leak.test.mjs).

### When not to apply the fix

Do not reset AppleEvents/Automation for a read failure, grant a shell broad
permissions you do not intend to use, or copy/modify Apple's live `chat.db`.

## An iMessage send fails or macOS does not prompt correctly

### Symptom

A user-triggered iMessage fails with `-1743`, not authorized, System Events
keystroke denial, or attachment delivery failure.

### Likely causes

1. Automation permission to control Messages was denied or belongs to a
   different launcher/terminal.
2. Attachment UI scripting lacks Accessibility permission.
3. Messages is signed out, the handle is invalid, or delivery later becomes
   Not Delivered.
4. The wrong sibling handle/chat was selected.

### How to confirm each cause

1. Match `-1743`, `errAEEventNotPermitted`, or not authorized in send receipt
   and inspect Privacy & Security, Automation.
2. Match `osascript is not allowed to send keystrokes`, error 1002, or System
   Events authorization and inspect Accessibility.
3. Open Messages, inspect the recipient and bubble, then check later scan
   receipts for retracted outbound keys.
4. Compare the thread/person sibling receipts and actual Messages chat.

### Safe fix

Enable the exact current app/terminal under Automation for Messages. For file
sends only, enable it under Accessibility. Use the in-app permission guidance,
restart, and retry once. The current app does not reset TCC permissions.

### Relevant logs

Thread send receipt, Activity send failure, source/Electron log, later scan
retraction receipt.

### Relevant source files

[`apps/runner/src/platforms/imessage-send.ts`](../../apps/runner/src/platforms/imessage-send.ts),
[`apps/runner/src/platforms/imessage-adapter.ts`](../../apps/runner/src/platforms/imessage-adapter.ts),
[`apps/runner/src/services/send.ts`](../../apps/runner/src/services/send.ts),
[`apps/runner/src/platforms/macos-permission-guidance.ts`](../../apps/runner/src/platforms/macos-permission-guidance.ts),
[`apps/runner/src/scripts/imessage-permission-help.ts`](../../apps/runner/src/scripts/imessage-permission-help.ts).

### Relevant tests

[`runner-imessage-permission-help.test.mjs`](../../tests/runner-imessage-permission-help.test.mjs),
[`runner-imessage-receipt-sibling-chat.test.mjs`](../../tests/runner-imessage-receipt-sibling-chat.test.mjs),
[`runner-imessage-attachment-convert-atomic.test.mjs`](../../tests/runner-imessage-attachment-convert-atomic.test.mjs).

### When not to apply the fix

Do not run `tccutil reset AppleEvents` as routine troubleshooting. It is not a
Full Disk Access fix and resets Automation grants outside this app.

## iMessage shows phone numbers instead of contact names

### Symptom

Messages are present but people appear as phone numbers or email addresses.

### Likely causes

1. Contacts are not synced to this Mac.
2. The handle is absent or formatted unexpectedly in Contacts.
3. AddressBook read lacks Full Disk Access.
4. An optional `contacts.vcf` is missing/stale or a manual name intentionally
   takes precedence.

### How to confirm each cause

1. Open the Mac Contacts and Messages apps and see whether they know the name.
2. Compare the saved phone/email with the raw handle.
3. Check iMessage contact health and startup name-sync receipts.
4. Inspect `IMESSAGE_CONTACTS_VCF`/`data/contacts.vcf` and the Person name
   provenance before applying changes.

### Safe fix

Sync/import the correct Contacts entry, restart or rescan, then preview the
name-backfill command before `--apply`. Preserve a manual display name unless
the operator explicitly changes it.

### Relevant logs

`imessage-name-sync` console/audit output and `/data/imessage-contact-health`.

### Relevant source files

[`apps/runner/src/platforms/addressbook-db.ts`](../../apps/runner/src/platforms/addressbook-db.ts),
[`apps/runner/src/services/contact-resolver.ts`](../../apps/runner/src/services/contact-resolver.ts),
[`apps/runner/src/services/imessage-name-sync.ts`](../../apps/runner/src/services/imessage-name-sync.ts).

### Relevant tests

[`runner-addressbook-contacts.test.mjs`](../../tests/runner-addressbook-contacts.test.mjs),
[`runner-imessage-name-sync.test.mjs`](../../tests/runner-imessage-name-sync.test.mjs),
[`runner-backfill-imessage-names.test.mjs`](../../tests/runner-backfill-imessage-names.test.mjs).

### When not to apply the fix

Do not overwrite a manual name, import an untrusted vCard, or deduplicate
people solely because two rows display the same common name.

## LinkedIn asks for login, scans degrade, or a thread will not open

### Symptom

LinkedIn reports auth required/manual login, selector failure, unresolved
thread identity, repeated empty scans, or open/send thread mismatch.

### Likely causes

1. The mirrored Chrome session expired, the selected profile is wrong/locked,
   or a verification checkpoint is active.
2. LinkedIn DOM/selectors changed or a temporary page failed to load.
3. Candidate row identity did not resolve to a canonical conversation.
4. Account cooldown/rate safety stopped the scan.

### How to confirm each cause

1. Open normal Chrome and controlled browser, verify profile name and LinkedIn
   login, and inspect auth failure kind.
2. Run the selector test once and review screenshot/DOM plus action receipts.
3. Look for unresolved canonical ID or thread mismatch decisions.
4. Inspect cooldown status, retry-after, scan caps, and last run summary.

### Safe fix

Sign in manually in the configured Chrome profile, complete 2FA/checkpoints,
and rerun a small update scan. For selectors, reproduce on the current UI,
update the smallest selector contract, and run focused tests. Respect cooldown.

### Relevant logs

LinkedIn run trace, `data/screenshots`, `data/dom_dumps`, platform last error,
and Activity receipts.

### Relevant source files

[`apps/runner/src/platforms/linkedin-adapter.ts`](../../apps/runner/src/platforms/linkedin-adapter.ts),
[`apps/runner/src/services/session-manager.ts`](../../apps/runner/src/services/session-manager.ts),
[`apps/runner/src/services/scan-retry-controller.ts`](../../apps/runner/src/services/scan-retry-controller.ts),
[`packages/core/selectors/linkedin.json`](../../packages/core/selectors/linkedin.json).

### Relevant tests

[`runner-linkedin-auth-url-detection.test.mjs`](../../tests/runner-linkedin-auth-url-detection.test.mjs),
[`runner-linkedin-identity.test.mjs`](../../tests/runner-linkedin-identity.test.mjs),
[`runner-linkedin-reliability.test.mjs`](../../tests/runner-linkedin-reliability.test.mjs),
[`runner-selector-service.test.mjs`](../../tests/runner-selector-service.test.mjs).

### When not to apply the fix

Do not enable credential auto-login, raise caps, force fallback loops, delete
the profile, or weaken fail-closed identity while a checkpoint, cooldown, or
transient platform outage remains possible.

## WhatsApp QR, connection, scan, or send fails

### Symptom

WhatsApp is absent, QR never appears/refreshes, state stays connecting, scans
return not connected, or a send is blocked.

### Likely causes

1. `WHATSAPP_ENABLED` is not exactly true or the runner was not restarted.
2. LocalAuth expired/corrupted or the phone unlinked the device.
3. Puppeteer/Chromium launch failed.
4. The send guard rejected unsaved direct contact, minimum interval, or daily
   cap.
5. Media staging/read failed.

### How to confirm each cause

1. Check `.env`, restart, and query `/data/whatsapp/status` plus platforms.
2. Inspect state transitions `qr_ready`, `connecting`, `connected`,
   `disconnected`; verify Linked Devices on phone.
3. Check runner console for initialize/Puppeteer errors.
4. Read the exact `WhatsApp send blocked` reason and guard receipts.
5. Confirm staged path exists and the error names the attachment.

### Safe fix

Enable/restart deliberately, refresh QR, and relink through the phone. Reset
only the WhatsApp app-owned session if relinking cannot start. Wait for guard
interval/cap rather than bypassing it. Reattach a readable file for media
errors.

### Relevant logs

Runner startup/client output, WhatsApp state events, send failure receipt,
platform last error.

### Relevant source files

[`apps/runner/src/platforms/whatsapp-adapter.ts`](../../apps/runner/src/platforms/whatsapp-adapter.ts),
[`apps/runner/src/platforms/whatsapp/client.ts`](../../apps/runner/src/platforms/whatsapp/client.ts),
[`apps/runner/src/platforms/whatsapp/sendGuard.ts`](../../apps/runner/src/platforms/whatsapp/sendGuard.ts),
[`apps/dashboard/components/settings/WhatsAppConnect.tsx`](../../apps/dashboard/components/settings/WhatsAppConnect.tsx).

### Relevant tests

[`runner-whatsapp-session.test.mjs`](../../tests/runner-whatsapp-session.test.mjs),
[`runner-whatsapp-send-guard.test.mjs`](../../tests/runner-whatsapp-send-guard.test.mjs),
[`runner-whatsapp-adapter.test.mjs`](../../tests/runner-whatsapp-adapter.test.mjs),
[`runner-whatsapp-media.test.mjs`](../../tests/runner-whatsapp-media.test.mjs).

### When not to apply the fix

Do not delete the WhatsApp profile for a rate-limit or media error, bypass the
send guard, or make normal auto-scan launch an unlinked QR session.

## Messages are duplicated, stale, missing, or out of order

### Symptom

One physical outbound appears twice, an older preview wins, sibling iMessage
chats disagree, or a scan seems to omit/reorder a message.

### Likely causes

1. Send-time and scan-time keys differ and reconciliation did not match text,
   time window, or sibling set.
2. An adapter supplied unstable identity/timestamps or one extraction path
   omitted a field.
3. A system/deleted placeholder incorrectly affected aggregates.
4. Cached/polled presentation has not refreshed yet.

### How to confirm each cause

1. Compare `threadId`, platform keys, normalized text, timestamp, `sentVia`,
   and reply parent on both rows.
2. Compare adapter raw/normalized output across streaming and fallback paths.
3. Inspect the raw message kind/text and AI-visible/system-event filters.
4. Compare direct `/data/thread` and `/data/inbox` with the browser after an
   event or hard refresh.

### Safe fix

Add a privacy-safe characterization test reproducing the key/timestamp/field
shape, then repair the normalizer or reconciliation logic. Rescan the targeted
thread after the code fix. Use an explicit repair script with dry-run for
existing rows rather than manual SQL.

### Relevant logs

Thread parse/persist receipts, send receipt, run trace, and event stream.

### Relevant source files

[`apps/runner/src/services/scan-queue.ts`](../../apps/runner/src/services/scan-queue.ts),
[`apps/runner/src/services/message-upsert-payload.ts`](../../apps/runner/src/services/message-upsert-payload.ts),
[`apps/runner/src/services/canonical-thread.ts`](../../apps/runner/src/services/canonical-thread.ts),
[`apps/runner/src/services/thread-row-shaping.ts`](../../apps/runner/src/services/thread-row-shaping.ts).

### Relevant tests

[`runner-outbound-dedup.test.mjs`](../../tests/runner-outbound-dedup.test.mjs),
[`runner-outbound-same-thread-delete-twin-merge.test.mjs`](../../tests/runner-outbound-same-thread-delete-twin-merge.test.mjs),
[`runner-canonical-thread.test.mjs`](../../tests/runner-canonical-thread.test.mjs),
[`runner-imessage-timestamp-drift.test.mjs`](../../tests/runner-imessage-timestamp-drift.test.mjs).

### When not to apply the fix

Do not delete a row solely by matching text, merge people by display name, or
rewrite timestamps without platform evidence. Similar messages can be real.

## A send is stuck, failed, or uncertain after restart

### Symptom

The composer shows pending indefinitely, a scheduled send did not run, a send
failed, or an interrupted receipt says it may have delivered.

### Likely causes

1. Runner stopped before an unclaimed pending row drained.
2. A claimed row crashed after possible external dispatch.
3. Scheduled time has not arrived, the row was canceled/edited concurrently,
   or promoter is not running.
4. Adapter auth, thread identity, permission, guard, or verification failed.
5. Dashboard missed an event and shows stale queue state.

### How to confirm each cause

1. Query `/data/send-queue`, restart runner, and watch send queue receipts.
2. Check `FAILED` error kind `INTERRUPTED` and verify the platform conversation.
3. Inspect status/scheduledFor and promoter receipts.
4. Read the stable adapter error and relevant platform playbook.
5. Compare direct queue/thread API with the dashboard after refresh.

### Safe fix

Restart to resume only unclaimed pending rows. For interrupted/uncertain rows,
open the real platform and confirm whether the message exists before the user
chooses Retry. Correct the confirmed platform cause, then retry once. Keep
scheduled edits/cancel status-guarded through the API.

### Relevant logs

`SEND_QUEUE_UPDATED`, `MESSAGE_SENT`, `MESSAGE_SEND_FAILED`, Activity send
receipts, thread send status.

### Relevant source files

[`apps/runner/src/services/send.ts`](../../apps/runner/src/services/send.ts),
[`apps/runner/src/services/send-queue.ts`](../../apps/runner/src/services/send-queue.ts),
[`apps/runner/src/services/scheduled-send-promoter.ts`](../../apps/runner/src/services/scheduled-send-promoter.ts).

### Relevant tests

[`runner-send-claim-crash-safety.test.mjs`](../../tests/runner-send-claim-crash-safety.test.mjs),
[`runner-scheduled-send-promoter.test.mjs`](../../tests/runner-scheduled-send-promoter.test.mjs),
[`runner-scheduled-send-race-safety.test.mjs`](../../tests/runner-scheduled-send-race-safety.test.mjs),
[`dashboard-thread-check-status.test.mjs`](../../tests/dashboard-thread-check-status.test.mjs).

### When not to apply the fix

Do not manually set an uncertain row back to pending, resend without platform
verification, or report success because the adapter call merely returned.

## AI output is missing, slow, or uses a fallback provider

### Symptom

Summaries/drafts are absent, a spinner is slow, `/data/ai-status` says the
selected provider is unconfigured, or the UI discloses a fallback.

### Likely causes

1. No configured key, key changed without restart, or persisted provider choice
   differs from `AI_PROVIDER`.
2. Auth, balance/quota, rate limit, overload, timeout, or invalid model.
3. Active provider failed and narrow runtime fallback used OpenAI.
4. Help level intentionally hides full drafting or reduces classification.
5. Existing cache hash did not change, or transcription awaits explicit
   Reassess.

### How to confirm each cause

1. Query `/data/ai-status`, inspect persisted settings, and confirm key presence
   without printing the key.
2. Read `[ai]` classifications and provider/model/attempt metadata.
3. Inspect source metadata for `fellBackFromProviderId` and reason.
4. Check operator profile `aiHelpLevel`.
5. Compare cache key inputs and `needsAiRefresh`.

### Safe fix

Correct/revoke/replace the specific key or model, restart, and verify status.
Wait/back off for rate limits. Choose the intended help level. Use Reassess
explicitly for changed transcript/context. Preserve safe fallback on outage.

### Relevant logs

Runner `[ai]` console output, Activity AI action, `/data/ai-status`, provider
source shown in thread.

### Relevant source files

[`apps/runner/src/services/ai.ts`](../../apps/runner/src/services/ai.ts),
[`apps/runner/src/services/ai-providers.ts`](../../apps/runner/src/services/ai-providers.ts),
[`apps/runner/src/services/settings.ts`](../../apps/runner/src/services/settings.ts),
[`apps/runner/src/services/reassess-thread.ts`](../../apps/runner/src/services/reassess-thread.ts).

### Relevant tests

[`runner-ai-provider-pick.test.mjs`](../../tests/runner-ai-provider-pick.test.mjs),
[`runner-gemini-error-classifier.test.mjs`](../../tests/runner-gemini-error-classifier.test.mjs),
[`runner-openai-error-classifier.test.mjs`](../../tests/runner-openai-error-classifier.test.mjs),
[`runner-ai-race.test.mjs`](../../tests/runner-ai-race.test.mjs).

### When not to apply the fix

Do not add retries for non-retriable auth/balance errors, claim the selected
provider ran without source evidence, turn on full drafts for someone who did
not choose them, or expose prompt/message content in a bug report.

## Voice or video transcription is missing or failed

### Symptom

An attachment has no transcript, shows skipped/failed, dictation is unavailable,
or a better transcript does not update the summary.

### Likely causes

1. Transcription master gate is off or provider/model is not configured.
2. Transformers model is not downloaded; Whisper command/model is missing.
3. File expired, is missing, too large/long, unsupported, silent, or conversion
   failed.
4. Provider timed out or OpenAI key/model failed.
5. Higher tier updated the selected transcript and marked AI refresh needed.

### How to confirm each cause

1. Query transcription capabilities and inspect `.env` plus selected provider.
2. Run doctor; inspect `data/models` or absolute Whisper paths.
3. Read safe transcription error and confirm source attachment locally.
4. Inspect provider-specific error/timeout without logging audio contents.
5. Check selected tier/attempts and `needsAiRefresh`.

### Safe fix

Download the configured Transformers model with `npm run fetch:whisper-model`,
or correct explicit Whisper/OpenAI config and restart. Preserve future
iMessage voice files by setting Messages audio expiry appropriately. Retry the
specific message, then explicitly Reassess if the summary needs the new text.

### Relevant logs

Transcription status/error row, runner transcription warning, thread tooltip,
doctor output.

### Relevant source files

[`apps/runner/src/services/transcription/transcription-service.ts`](../../apps/runner/src/services/transcription/transcription-service.ts),
[`apps/runner/src/services/transcription/selection.ts`](../../apps/runner/src/services/transcription/selection.ts),
[`apps/runner/src/services/transcription/transformers-whisper-provider.ts`](../../apps/runner/src/services/transcription/transformers-whisper-provider.ts),
[`apps/runner/src/services/transcription/local-whisper-provider.ts`](../../apps/runner/src/services/transcription/local-whisper-provider.ts).

### Relevant tests

[`runner-transcription-service.test.mjs`](../../tests/runner-transcription-service.test.mjs),
[`runner-transcription-selection.test.mjs`](../../tests/runner-transcription-selection.test.mjs),
[`runner-transcription-missing-file.test.mjs`](../../tests/runner-transcription-missing-file.test.mjs),
[`runner-transcription-force-retry.test.mjs`](../../tests/runner-transcription-force-retry.test.mjs).

### When not to apply the fix

Do not switch to paid OpenAI transcription silently, increase file limits for
an unknown attachment, delete prior attempts to hide evidence, or auto-run a
new summary that spends provider tokens without the user's action.

## Dashboard does not refresh after a scan or send

### Symptom

The runner data is current but an open dashboard remains stale until reload or
navigation.

### Likely causes

1. SSE proxy/connection failed or replay window was exceeded.
2. Event type was not handled by the current page.
3. Browser tab was hidden and polling paused.
4. Inbox cache or request cache was not invalidated by a mutation.

### How to confirm each cause

1. Inspect `/events` and `/events-proxy`, Last-Event-ID, and
   `RESYNC_REQUIRED`.
2. Compare event payload type with dashboard event handler tests.
3. Focus the tab and observe the immediate visible-poll tick.
4. Compare direct API data, cache version, and browser request cache.

### Safe fix

Reload once to resync, then repair event handling/proxy/cache invalidation with
a focused test. Keep visible polling as recovery. Do not increase background
polling aggressively.

### Relevant logs

Browser console/client error log, runner event output, direct inbox/thread API.

### Relevant source files

[`apps/runner/src/services/event-bus.ts`](../../apps/runner/src/services/event-bus.ts),
[`apps/runner/src/index.ts`](../../apps/runner/src/index.ts),
[`apps/dashboard/app/events-proxy/route.ts`](../../apps/dashboard/app/events-proxy/route.ts),
[`apps/dashboard/lib/inbox-events.ts`](../../apps/dashboard/lib/inbox-events.ts).

### Relevant tests

[`runner-event-bus.test.mjs`](../../tests/runner-event-bus.test.mjs),
[`runner-sse-resume-cursor.test.mjs`](../../tests/runner-sse-resume-cursor.test.mjs),
[`dashboard-inbox-events.test.mjs`](../../tests/dashboard-inbox-events.test.mjs),
[`dashboard-events-proxy-runner-base.test.mjs`](../../tests/dashboard-events-proxy-runner-base.test.mjs).

### When not to apply the fix

Do not replace events with rapid global polling, treat event payloads as the
database, or disable cache correctness guards merely to make one view update.

## Database setup fails or the app opens a new empty database

### Symptom

Prisma generation/push fails, SQLite is locked/unwritable, or a formerly
populated install appears empty after config/update.

### Likely causes

1. Relative `DATABASE_URL` resolved differently in an old command/path.
2. The directory is unwritable or the app is running from a protected bundle.
3. Another writer/process holds the file, or database/WAL files were copied
   inconsistently.
4. Schema change is destructive/incompatible with `db push`.

### How to confirm each cause

1. Doctor prints the runner-resolved path; compare all candidate files, sizes,
   and timestamps without deleting any.
2. Check directory ownership/write access and packaged app location.
3. Stop app, identify all PIDs, and keep sqlite/wal/shm siblings together.
4. Review schema diff and Prisma output; check for missing migration plan.

### Safe fix

Point `DATABASE_URL` at the known existing absolute file, restart, and verify
before scanning. Restore a stopped complete backup for copy damage. For schema
change, use a disposable copy and explicit migration plan.

### Relevant logs

Doctor, launcher prepare output, updater log, Prisma command output.

### Relevant source files

[`apps/runner/src/config.ts`](../../apps/runner/src/config.ts),
[`apps/runner/src/db.ts`](../../apps/runner/src/db.ts),
[`packages/core/prisma/schema.prisma`](../../packages/core/prisma/schema.prisma),
[`scripts/start-app.mjs`](../../scripts/start-app.mjs).

### Relevant tests

[`runner-database-url.test.mjs`](../../tests/runner-database-url.test.mjs),
[`student-updater-stop-order.test.mjs`](../../tests/student-updater-stop-order.test.mjs),
[`student-updater.test.mjs`](../../tests/student-updater.test.mjs).

### When not to apply the fix

Do not run reset/delete, copy only the main SQLite file while WAL is active,
or force a destructive `db push` without backup and tested transformation.

## Update fails, rolls back, or repeatedly offers the same version

### Symptom

Update check errors, checksum is rejected, apply restores the old version, the
app does not relaunch, or a version keeps appearing.

### Likely causes

1. Feed URL is missing, non-HTTPS, HTML rather than raw JSON, or malformed.
2. Manifest/ZIP checksum, version, or minimum installer version does not match.
3. Developer checkout contains `.git` and is intentionally refused.
4. Dependency/schema preparation failed after swap.
5. Published version did not increase or live Dropbox files/links are out of
   sync.

### How to confirm each cause

1. Run check-only with the exact feed and inspect HTTP content type/body safely.
2. Validate manifest fields and independently calculate ZIP SHA-256.
3. Check for `.git` in the target install.
4. Inspect update/restart log and preserved backup/failed directory.
5. Compare current, live manifest, package, baked release, and public version.

### Safe fix

Correct the raw HTTPS link or republish a matched manifest/ZIP pair. Use Git
for developer checkouts. Repair the specific prepare failure and retry only
after doctor passes. Restore the retained backup if automatic rollback did not
finish. Publish a higher version for pilot-visible repair.

### Relevant logs

`logs/app-restart.log`, `logs/update-restart-*.log`, publisher verification
output, GitHub Actions publish run.

### Relevant source files

[`scripts/update-student.mjs`](../../scripts/update-student.mjs),
[`scripts/apply-update-and-restart.mjs`](../../scripts/apply-update-and-restart.mjs),
[`scripts/lib/release-manifest.mjs`](../../scripts/lib/release-manifest.mjs),
[`scripts/publish-student-release.mjs`](../../scripts/publish-student-release.mjs).

### Relevant tests

[`student-updater.test.mjs`](../../tests/student-updater.test.mjs),
[`student-updater-https-gate.test.mjs`](../../tests/student-updater-https-gate.test.mjs),
[`release-manifest.test.mjs`](../../tests/release-manifest.test.mjs),
[`student-publish-release.test.mjs`](../../tests/student-publish-release.test.mjs).

### When not to apply the fix

Do not disable HTTPS/checksum validation, hand-edit only one live artifact,
downgrade the version, delete the only backup, or run the source updater inside
a Git checkout.

## macOS refuses to open the DMG app

### Symptom

Finder/Gatekeeper reports an unidentified developer, damaged app, or cannot
verify/open.

### Likely causes

1. The DMG is ad-hoc signed rather than Developer ID signed/notarized.
2. Quarantine or artifact corruption occurred during transfer.
3. Architecture does not match the Mac.
4. The app was copied incompletely or modified after signing.

### How to confirm each cause

1. Inspect `codesign -dv --verbose=4` and notarization with `spctl -a -vv`.
2. Compare artifact SHA-256 and mount/copy again from the trusted source.
3. Compare build architecture with `uname -m`.
4. Run strict code-sign verification and inspect the desktop log. Runtime data
   should be under Application Support, not the app bundle.

### Safe fix

Rebuild on the target architecture from the known ref and use the builder's
strict code-sign and DMG verification. For normal distribution, use a real
Developer ID signing and notarization process. Preserve Application Support
data when replacing the app.

### Relevant logs

Electron desktop log, macOS Console/Gatekeeper output, DMG builder output.

### Relevant source files

[`scripts/build-macos-dmg.mjs`](../../scripts/build-macos-dmg.mjs),
[`apps/desktop/main.cjs`](../../apps/desktop/main.cjs),
[`apps/runner/src/config.ts`](../../apps/runner/src/config.ts).

### Relevant tests

[`macos-dmg-builder.test.mjs`](../../tests/macos-dmg-builder.test.mjs),
[`macos-app-bundle.test.mjs`](../../tests/macos-app-bundle.test.mjs),
[`desktop-launcher.test.mjs`](../../tests/desktop-launcher.test.mjs),
[`process-lifecycle.test.mjs`](../../tests/process-lifecycle.test.mjs).

### When not to apply the fix

Do not tell pilots to bypass Gatekeeper or remove quarantine as a default fix,
and do not mistake ad-hoc signing for notarized distribution.

## Disk use grows unexpectedly

### Symptom

The installation, data, logs, models, profiles, media, or release artifacts
consume unexpectedly large storage.

### Likely causes

1. Browser profiles or transcription models are large but expected.
2. Screenshots, DOM dumps, or run traces accumulated.
3. Preserved voice/WhatsApp media accumulated.
4. Update backups or `release-dist` accumulated.
5. Database/audit growth is real user/diagnostic data, not a cache.

### How to confirm each cause

1. Measure each canonical storage directory separately.
2. Run artifact cleanup in preview and inspect age/count.
3. Compare media folders with feature use and retention expectations.
4. Inspect sibling `.rios-backup-*` and `release-dist`.
5. Measure SQLite tables on a stopped backup before proposing retention.

### Safe fix

Use the artifact cleanup preview/apply only for its declared roots. Remove
rebuildable `release-dist` or old validated updater backups after preserving a
known-good rollback. Design explicit retention before pruning private media or
audit/database rows.

### Relevant logs

Cleanup preview/output and storage measurements.

### Relevant source files

[`apps/runner/src/scripts/cleanup-artifacts.ts`](../../apps/runner/src/scripts/cleanup-artifacts.ts),
[`apps/runner/src/services/run-logger.ts`](../../apps/runner/src/services/run-logger.ts),
[`scripts/update-student.mjs`](../../scripts/update-student.mjs),
[`apps/runner/src/config.ts`](../../apps/runner/src/config.ts).

### Relevant tests

[`runner-cleanup-artifacts.test.mjs`](../../tests/runner-cleanup-artifacts.test.mjs),
[`runner-cleanup-artifacts-keep-runs-per-source.test.mjs`](../../tests/runner-cleanup-artifacts-keep-runs-per-source.test.mjs),
[`student-build-release.test.mjs`](../../tests/student-build-release.test.mjs).

### When not to apply the fix

Do not label the database, profiles, message media, transcripts, or only
rollback backup as disposable, and never delete unique user data to meet a
size target.

## Feedback submission fails or a screenshot is missing

### Symptom

The feedback modal reports not configured/failure, copy fallback appears, or a
GitHub issue lacks the optional screenshot.

### Likely causes

1. Webhook URL/secret is absent or rejected.
2. Status/webhook service is unavailable.
3. Screenshot upload/confirmation or size/type validation failed.
4. GitHub token/repo/branch attachment step failed after webhook success.

### How to confirm each cause

1. Check configuration presence without printing the secret and inspect safe
   runner response.
2. Inspect webhook status and runner timeout/error.
3. Confirm user selected and approved the file and read the validation error.
4. Check optional GitHub attachment log; confirm the report itself succeeded.

### Safe fix

Keep the user's text in the modal and use Copy report. Repair/rotate webhook
configuration through release secrets. Retry optional attachment only after
reviewing the screenshot for private content; webhook success must not be
rolled back because GitHub attachment failed.

### Relevant logs

`PILOT_FEEDBACK` audit/console output, webhook response, optional GitHub
attachment warning. Do not log the report body or secret unnecessarily.

### Relevant source files

[`apps/runner/src/services/pilot-feedback.ts`](../../apps/runner/src/services/pilot-feedback.ts),
[`apps/runner/src/services/github-attachments.ts`](../../apps/runner/src/services/github-attachments.ts),
[`apps/dashboard/components/common/pilot-feedback-modal.tsx`](../../apps/dashboard/components/common/pilot-feedback-modal.tsx).

### Relevant tests

[`runner-pilot-feedback.test.mjs`](../../tests/runner-pilot-feedback.test.mjs),
[`dashboard-pilot-feedback.test.mjs`](../../tests/dashboard-pilot-feedback.test.mjs),
[`runner-github-attachments.test.mjs`](../../tests/runner-github-attachments.test.mjs),
[`dashboard-feedback-ondone-throw.test.mjs`](../../tests/dashboard-feedback-ondone-throw.test.mjs).

### When not to apply the fix

Do not auto-attach message content, upload an unconfirmed screenshot, expose
the webhook secret in client code, or make GitHub attachment failure invalidate
an accepted report.
