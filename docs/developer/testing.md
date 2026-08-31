# Tests and verification

The repository uses TypeScript workspace builds plus Node's test runner. Most
behavior tests live under [`tests`](../../tests) and import source or compiled
runner modules through `tsx`.

## Standard gates

Run from the repository root with Node 20 or newer. Pilot and release paths are
tested against Node 22. Install Patchright's managed Chromium before the first
suite run. Use `npx patchright install chromium` on macOS or Windows, and
`npx patchright install --with-deps chromium` on Linux.

```bash
npm ci
npx patchright install chromium
npm run db:generate
npm run docs:check
npm run lint
npm run test:all
npm run build
```

What they cover:

| Command | Work performed |
| --- | --- |
| `npm run docs:check` | Internal Markdown links/anchors, referenced local files, and documented npm/script commands |
| `npm run lint` | Builds core, then runs each workspace TypeScript no-emit check |
| `npm run test:all` | Builds core and runner, then runs every `tests/*.test.mjs` with `tsx` import support |
| `npm run build` | Turbo build of core, runner, and production dashboard |

The runner executes browser fixtures serially and rejects any applicable
browser test that reports a skip. Do not set `TOVI_ALLOW_BROWSER_SKIPS=1` for a
verification or release gate. Platform-scoped fixtures are excluded on other
operating systems, so Linux CI does not replace the macOS Electron and iPhone
browser fixtures.

The merged interaction-latency harness is available separately:

```bash
DATABASE_URL=file:/tmp/rios-perf.sqlite npm run perf:seed
DATABASE_URL=file:/tmp/rios-perf.sqlite npm run perf:interactions -- --help
npm run perf:launcher -- --help
```

`perf:seed` refuses a database URL that does not contain `perf` or `benchmark`.
The measured baseline, sampling method, commands, and known variance are
canonical in the [issue 801 latency report](../performance/issue-801-interaction-latency.md).

Run one focused test with:

```bash
node --import tsx --test tests/runner-send-claim-crash-safety.test.mjs
```

Do not use each workspace's placeholder `npm test` output as evidence. The
root `test:all` script is the current suite.

## Coverage map

| Area | Representative tests |
| --- | --- |
| Core settings, risk, selectors, system events | [`core-risk.test.mjs`](../../tests/core-risk.test.mjs), [`core-selectors.test.mjs`](../../tests/core-selectors.test.mjs), [`core-autoscan.test.mjs`](../../tests/core-autoscan.test.mjs), [`core-imessage-system-events.test.mjs`](../../tests/core-imessage-system-events.test.mjs) |
| Scan queue, incremental work, backoff, identity, persistence | [`runner-scan-queue-in-flight.test.mjs`](../../tests/runner-scan-queue-in-flight.test.mjs), [`runner-incremental-scan-plan.test.mjs`](../../tests/runner-incremental-scan-plan.test.mjs), [`runner-adaptive-backoff.test.mjs`](../../tests/runner-adaptive-backoff.test.mjs), [`runner-message-upsert-payload.test.mjs`](../../tests/runner-message-upsert-payload.test.mjs) |
| Send queue and recovery | [`runner-send-claim-crash-safety.test.mjs`](../../tests/runner-send-claim-crash-safety.test.mjs), [`runner-outbound-dedup.test.mjs`](../../tests/runner-outbound-dedup.test.mjs), [`runner-scheduled-send-race-safety.test.mjs`](../../tests/runner-scheduled-send-race-safety.test.mjs), [`runner-reassess-on-send.test.mjs`](../../tests/runner-reassess-on-send.test.mjs) |
| LinkedIn | [`runner-linkedin-streaming-scan.test.mjs`](../../tests/runner-linkedin-streaming-scan.test.mjs), [`runner-linkedin-identity.test.mjs`](../../tests/runner-linkedin-identity.test.mjs), [`runner-linkedin-send-verification.test.mjs`](../../tests/runner-linkedin-send-verification.test.mjs), [`linkedin-send-traced-goto.test.mjs`](../../tests/linkedin-send-traced-goto.test.mjs) |
| iMessage and Contacts | [`runner-imessage-watcher.test.mjs`](../../tests/runner-imessage-watcher.test.mjs), [`runner-imessage-scan-watermark.test.mjs`](../../tests/runner-imessage-scan-watermark.test.mjs), [`runner-imessage-chatdb-open-denied.test.mjs`](../../tests/runner-imessage-chatdb-open-denied.test.mjs), [`runner-addressbook-contacts.test.mjs`](../../tests/runner-addressbook-contacts.test.mjs) |
| WhatsApp | [`runner-whatsapp-adapter.test.mjs`](../../tests/runner-whatsapp-adapter.test.mjs), [`runner-whatsapp-send-guard.test.mjs`](../../tests/runner-whatsapp-send-guard.test.mjs), [`runner-whatsapp-media.test.mjs`](../../tests/runner-whatsapp-media.test.mjs), [`dashboard-whatsapp-poll.test.mjs`](../../tests/dashboard-whatsapp-poll.test.mjs) |
| AI routing, summary fidelity, and voice | [`runner-ai-provider-pick.test.mjs`](../../tests/runner-ai-provider-pick.test.mjs), [`runner-ai-race.test.mjs`](../../tests/runner-ai-race.test.mjs), [`runner-ai-reply-brief.test.mjs`](../../tests/runner-ai-reply-brief.test.mjs), [`runner-ai-predraft-fidelity.test.mjs`](../../tests/runner-ai-predraft-fidelity.test.mjs), [`runner-ai-style.test.mjs`](../../tests/runner-ai-style.test.mjs) |
| Transcription | [`runner-transcription-service.test.mjs`](../../tests/runner-transcription-service.test.mjs), [`runner-transcription-selection.test.mjs`](../../tests/runner-transcription-selection.test.mjs), [`runner-local-whisper-provider.test.mjs`](../../tests/runner-local-whisper-provider.test.mjs), [`runner-transformers-whisper-provider.test.mjs`](../../tests/runner-transformers-whisper-provider.test.mjs) |
| Dashboard state and presentation | `tests/dashboard-*.test.mjs`, especially [`dashboard-inbox-events.test.mjs`](../../tests/dashboard-inbox-events.test.mjs), [`dashboard-thread-page-safety.test.mjs`](../../tests/dashboard-thread-page-safety.test.mjs), and [`dashboard-reply-brief.test.mjs`](../../tests/dashboard-reply-brief.test.mjs) |
| Desktop, installer, DMG, updater, release | [`desktop-launcher.test.mjs`](../../tests/desktop-launcher.test.mjs), [`installer-relocate.test.mjs`](../../tests/installer-relocate.test.mjs), [`macos-dmg-builder.test.mjs`](../../tests/macos-dmg-builder.test.mjs), [`student-updater.test.mjs`](../../tests/student-updater.test.mjs), [`student-publish-release.test.mjs`](../../tests/student-publish-release.test.mjs) |
| Privacy and copy gates | [`dashboard-pilot-feedback.test.mjs`](../../tests/dashboard-pilot-feedback.test.mjs), [`runner-pilot-feedback.test.mjs`](../../tests/runner-pilot-feedback.test.mjs), [`no-ui-dashes.test.mjs`](../../tests/no-ui-dashes.test.mjs) |

Many dashboard tests are source-contract tests. They catch regression patterns
quickly but do not replace rendering and interacting in a browser.

## Safe local operational checks

These do not send messages or change accounts:

```bash
npm run doctor
npm run install:student -- --dry-run
npm run create:macos-app -- --dry-run
npm run build:macos-dmg -- --dry-run
npm run publish:student-release -- --dry-run
```

The publisher dry run can create local `release-dist` artifacts, but it never
uploads. Use the release tests as the first safety gate.

## Live verification

Live checks are separate because they touch private local state or external
accounts.

### Dashboard and runner

1. Start the intended worktree. The Turbo daemon can retain another
   worktree's cwd, so confirm the process cwd with `lsof` if edits do not
   appear.
2. Open Today, Inbox, one thread, Reconnect, Settings, and Archived.
3. Confirm `/health`, inbox loading, event-driven refresh, and offline recovery.
4. Exercise only reversible local actions unless the test explicitly includes
   an external send.

### LinkedIn

Use a deliberate account and keep caps low. `npm run test:selectors:linkedin`
checks selectors; `npm run linkedin:smoke` performs a one-thread ingest and is
an external browser action. A real send verification must be explicitly
authorized and reviewed on-platform.

### iMessage

Verify Full Disk Access, local read, watcher refresh, and Messages automation
separately. Attachment sends can also require Accessibility. Use a consenting
test contact; there is no safe fake delivery endpoint.

### WhatsApp

Enable only for the chosen test install, link by QR, confirm one incoming
message, then verify a deliberate low-volume send. Do not raise or bypass the
send guard for testing.

### Install/update/recovery

Use a throwaway copy or temporary `RIOS_INSTALL_DIR`. Verify `.env`, database,
profiles, and logs survive an update, that a checksum mismatch is refused, and
that failure restores the backup. Never point a destructive uninstall test at
the real pilot installation.

## CI

The CI workflow installs dependencies, generates Prisma, runs documentation
checks, lint, and the root suite. Release workflows independently rerun lint
and tests before building or publishing. External platform live tests are not
CI-safe and remain manual evidence.
