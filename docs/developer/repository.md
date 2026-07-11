# Repository, workspaces, and module map

Relationship Inbox OS is an npm-workspaces monorepo coordinated by Turbo. The
runtime dependency direction is:

```text
packages/core  <---  apps/runner
      ^               |
      |               | HTTP + SSE
      +--- apps/dashboard
                      ^
                      |
                 apps/desktop
```

The dashboard and runner import compiled core. Desktop starts and hosts the
dashboard/runner pair but does not import application-domain code.

## Top-level structure

| Path | Responsibility |
| --- | --- |
| [`apps/dashboard`](../../apps/dashboard) | Next.js UI, browser state, runner proxying, presentation, and user actions |
| [`apps/runner`](../../apps/runner) | Express API, platform integration, persistence, AI, queues, diagnostics, and update orchestration |
| [`apps/desktop`](../../apps/desktop) | Electron lifecycle, local window security, child-process launch, and packaged icon |
| [`packages/core`](../../packages/core) | Shared types, adapter contract, selectors, pure domain helpers, and Prisma schema |
| [`scripts`](../../scripts) | Install, launch, health, build, publish, update, rollback support, and documentation checks |
| [`tests`](../../tests) | Root Node test suite, including source-contract and focused regression tests |
| [`.github/workflows`](../../.github/workflows) | CI, PR title policy, source release build, and automatic student publishing |
| [`docs`](../) | User, operator, architecture, ADR, developer, strategy, pilot, and handoff documentation |
| `data/` | Gitignored runtime state, created locally, not a source directory |
| `logs/` | Gitignored runtime logs and update output |

Root [`package.json`](../../package.json) owns shared commands and workspace
versions. [`turbo.json`](../../turbo.json) describes build, lint, test, and dev
task relationships. `package-lock.json` is the installation lockfile.

## Workspace responsibilities

### `@inbox-os/core`

Core must remain platform-neutral and side-effect-light.

| Module group | Purpose | Main consumers |
| --- | --- | --- |
| [`src/types.ts`](../../packages/core/src/types.ts) | Shared platform, message, reply brief, settings, event, attachment, and AI-source shapes | Runner and dashboard |
| [`src/adapters.ts`](../../packages/core/src/adapters.ts) | `PlatformAdapter` contract and optional capabilities | Runner adapter factory and implementations |
| [`src/defaults.ts`](../../packages/core/src/defaults.ts) | Default persisted application settings | Runner settings store |
| [`src/risk.ts`](../../packages/core/src/risk.ts) | Deterministic waiting/risk calculation | Runner persistence and dashboard display helpers |
| [`src/autoscan.ts`](../../packages/core/src/autoscan.ts), [`src/overdue-digest.ts`](../../packages/core/src/overdue-digest.ts), [`src/birthday.ts`](../../packages/core/src/birthday.ts) | Pure scheduling and presentation decisions | Dashboard and runner services |
| [`src/selectors.ts`](../../packages/core/src/selectors.ts), [`selectors`](../../packages/core/selectors) | Default browser selector registries and override resolution | Browser adapters and selector tests |
| [`src/imessage-system-events.ts`](../../packages/core/src/imessage-system-events.ts), [`src/deleted-placeholder.ts`](../../packages/core/src/deleted-placeholder.ts) | Cross-surface filtering of non-content messages | Runner ingest, AI, and dashboard rendering |
| [`src/hash.ts`](../../packages/core/src/hash.ts) | Stable hashes used in identity and cache keys | Runner services |
| [`prisma/schema.prisma`](../../packages/core/prisma/schema.prisma) | Canonical SQLite schema | Prisma client, launcher, updater, runner |

### `@inbox-os/runner`

[`src/index.ts`](../../apps/runner/src/index.ts) is the composition root and
route source of truth. It should wire services rather than absorb more domain
logic.

| Module group | Purpose | Depends on |
| --- | --- | --- |
| [`src/config.ts`](../../apps/runner/src/config.ts), [`src/db.ts`](../../apps/runner/src/db.ts), [`src/dev-flags.ts`](../../apps/runner/src/dev-flags.ts) | Environment resolution, canonical data paths, Prisma singleton, WAL, and development gates | Node, Prisma, `.env` |
| [`src/platforms`](../../apps/runner/src/platforms) | LinkedIn, beta social, iMessage, WhatsApp implementations; browser/session helpers; platform identity and send verification | Core adapter contract, OS/platform SDKs |
| [`src/services/platform-factory.ts`](../../apps/runner/src/services/platform-factory.ts), [`src/services/session-manager.ts`](../../apps/runner/src/services/session-manager.ts), [`src/services/selector-tests.ts`](../../apps/runner/src/services/selector-tests.ts) | Adapter construction, reusable browser sessions, selector validation | Config, selectors, adapters |
| [`src/services/scan-queue.ts`](../../apps/runner/src/services/scan-queue.ts), [`src/services/incremental-scan.ts`](../../apps/runner/src/services/incremental-scan.ts), [`src/services/scan-retry-controller.ts`](../../apps/runner/src/services/scan-retry-controller.ts) | Serialized discovery, identity, message persistence, derived state, incremental plans, cooldowns, and backoff | Adapters, Prisma, AI, audit, event bus |
| [`src/services/message-upsert-payload.ts`](../../apps/runner/src/services/message-upsert-payload.ts), [`src/services/canonical-thread.ts`](../../apps/runner/src/services/canonical-thread.ts), [`src/services/thread-row-shaping.ts`](../../apps/runner/src/services/thread-row-shaping.ts) | Message write semantics and consistent visible-thread folding | Core types and Prisma rows |
| [`src/services/send.ts`](../../apps/runner/src/services/send.ts), [`src/services/send-queue.ts`](../../apps/runner/src/services/send-queue.ts), [`src/services/scheduled-send-promoter.ts`](../../apps/runner/src/services/scheduled-send-promoter.ts) | Durable immediate/scheduled sends, claim safety, adapter dispatch, persistence, and restart recovery | Prisma, adapters, event bus, audit |
| [`src/services/ai.ts`](../../apps/runner/src/services/ai.ts), [`src/services/ai-providers.ts`](../../apps/runner/src/services/ai-providers.ts), [`src/services/ai-race.ts`](../../apps/runner/src/services/ai-race.ts) | Prompts, parsing, retries, fallback, limited racing, and deterministic voice rules | Provider clients, settings, core types |
| [`src/services/reply-brief.ts`](../../apps/runner/src/services/reply-brief.ts), [`src/services/reassess-thread.ts`](../../apps/runner/src/services/reassess-thread.ts), [`src/services/resummarize-thread.ts`](../../apps/runner/src/services/resummarize-thread.ts), [`src/services/reassess-on-send.ts`](../../apps/runner/src/services/reassess-on-send.ts) | Reply-state sanitization and explicit refresh operations | AI service and Prisma |
| [`src/services/style.ts`](../../apps/runner/src/services/style.ts), [`src/services/reply-style-analysis.ts`](../../apps/runner/src/services/reply-style-analysis.ts), [`src/services/settings.ts`](../../apps/runner/src/services/settings.ts) | Observed writing style, inferred profile suggestions, and persisted settings/operator profile | Prisma and AI |
| [`src/services/transcription`](../../apps/runner/src/services/transcription), [`src/services/imessage-voice-store.ts`](../../apps/runner/src/services/imessage-voice-store.ts), [`src/services/linkedin-voice-store.ts`](../../apps/runner/src/services/linkedin-voice-store.ts) | Provider selection, audio fingerprinting, local/OpenAI transcription, tier selection, refinement, and preserved media | File system, Prisma, provider SDK/CLI |
| [`src/services/event-bus.ts`](../../apps/runner/src/services/event-bus.ts), [`src/services/sse-resume-cursor.ts`](../../apps/runner/src/services/sse-resume-cursor.ts) | Bounded replayable local event delivery | Runner routes and dashboard proxy |
| [`src/services/compressed-json-cache.ts`](../../apps/runner/src/services/compressed-json-cache.ts) | Byte-stable JSON and prepared gzip cache entries for the Inbox route | Runner data route |
| [`src/services/run-logger.ts`](../../apps/runner/src/services/run-logger.ts), [`src/services/audit.ts`](../../apps/runner/src/services/audit.ts), [`src/services/failure-routing.ts`](../../apps/runner/src/services/failure-routing.ts) | Structured receipts, optional per-run artifacts, and stable failure classes | Prisma and filesystem |
| [`src/services/enrichment-queue.ts`](../../apps/runner/src/services/enrichment-queue.ts), [`src/services/conversation-starters.ts`](../../apps/runner/src/services/conversation-starters.ts), [`src/services/self-profile.ts`](../../apps/runner/src/services/self-profile.ts) | Optional LinkedIn profile enrichment and AI-derived relationship context | LinkedIn adapter, AI, Prisma |
| [`src/services/contact-resolver.ts`](../../apps/runner/src/services/contact-resolver.ts), [`src/services/imessage-name-sync.ts`](../../apps/runner/src/services/imessage-name-sync.ts), [`src/services/birthday-sync.ts`](../../apps/runner/src/services/birthday-sync.ts) | macOS Contacts resolution, existing-row repair, and birthdays | AddressBook and Messages databases |
| [`src/services/pilot-feedback.ts`](../../apps/runner/src/services/pilot-feedback.ts), [`src/services/github-attachments.ts`](../../apps/runner/src/services/github-attachments.ts), [`src/services/gh-cli-token.ts`](../../apps/runner/src/services/gh-cli-token.ts) | Privacy-bounded report delivery and optional screenshot attachment | Webhook and optional GitHub credentials |
| [`src/services/system-update.ts`](../../apps/runner/src/services/system-update.ts) | Update check, pending intent, detached apply/restart | Root update scripts |
| [`src/scripts`](../../apps/runner/src/scripts), [`src/cli.ts`](../../apps/runner/src/cli.ts) | Explicit repair, reset, backfill, smoke, cleanup, and seeding commands | Runner services and Prisma |

### `@inbox-os/dashboard`

| Module group | Purpose | Depends on |
| --- | --- | --- |
| [`app`](../../apps/dashboard/app) | Route entry points, loading states, global styles, runner event proxy, and local-runner start route | Components and `lib` |
| [`app/today/page.tsx`](../../apps/dashboard/app/today/page.tsx), [`app/inbox/page.tsx`](../../apps/dashboard/app/inbox/page.tsx), [`app/reconnect/page.tsx`](../../apps/dashboard/app/reconnect/page.tsx), [`app/archived/page.tsx`](../../apps/dashboard/app/archived/page.tsx) | Primary and secondary list workflows | Runner data/control API |
| [`app/thread/[id]/page.tsx`](../../apps/dashboard/app/thread/[id]/page.tsx) | Conversation history, reply brief, composer, send state, AI help, and platform-capability controls | Runner API, thread components, browser media APIs |
| [`app/settings/page.tsx`](../../apps/dashboard/app/settings/page.tsx) | Pilot settings, source setup, permissions, notifications, voice, focus, digest, and update surfaces | Runner settings/system routes |
| [`app/people`](../../apps/dashboard/app/people), [`app/platforms`](../../apps/dashboard/app/platforms), [`app/logs`](../../apps/dashboard/app/logs), [`app/at-risk`](../../apps/dashboard/app/at-risk), [`app/demo`](../../apps/dashboard/app/demo) | Existing secondary, diagnostic, legacy, and presenter routes, not primary pilot navigation | Runner API |
| [`components/layout`](../../apps/dashboard/components/layout) | Shell, sidebar, mobile dock, status, command palette, and theme | Page routes and shared state |
| [`components/thread`](../../apps/dashboard/components/thread) | Reply brief, checklist, memory, media, poll, link, and in-app browser presentation | Thread response types |
| [`components/settings`](../../apps/dashboard/components/settings) | Voice, focus, update, and WhatsApp settings controls | Settings routes |
| [`components/common`](../../apps/dashboard/components/common) | Feedback, notifications, profiles, rows, focus overlays, demos, toasts, and shared presentation | Dashboard `lib` helpers |
| [`lib/api.ts`](../../apps/dashboard/lib/api.ts), [`lib/runner-base.ts`](../../apps/dashboard/lib/runner-base.ts), [`lib/inbox-events.ts`](../../apps/dashboard/lib/inbox-events.ts), [`lib/use-visible-polling.ts`](../../apps/dashboard/lib/use-visible-polling.ts) | HTTP cache/dedup, runner origin, event invalidation, and polling recovery | Browser fetch/EventSource |
| [`lib/inbox-pagination.ts`](../../apps/dashboard/lib/inbox-pagination.ts) | Pure 80-row Inbox windowing across grouped and ungrouped results | Inbox page |
| [`lib`](../../apps/dashboard/lib) | Pure feature state, query, formatting, notification, voice, demo, and race-guard helpers | Core types and browser APIs |

### Desktop and root operational code

| Module group | Purpose |
| --- | --- |
| [`apps/desktop/main.cjs`](../../apps/desktop/main.cjs) | Electron window, startup wait, child lifecycle, logs, local-navigation boundary, and single-instance lock |
| [`apps/desktop/launcher.cjs`](../../apps/desktop/launcher.cjs) | Node selection, port resolution, local URL policy, and startup arguments |
| [`scripts/install-student-macos.sh`](../../scripts/install-student-macos.sh), [`scripts/uninstall-student-macos.sh`](../../scripts/uninstall-student-macos.sh) | User-owned Node install, source relocation, preparation, app launcher creation, and destructive uninstall confirmation |
| [`scripts/start-app.mjs`](../../scripts/start-app.mjs), [`scripts/start-student.mjs`](../../scripts/start-student.mjs), [`scripts/doctor.mjs`](../../scripts/doctor.mjs) | Prepare/start orchestration, browser launch, pending-update application, and read-only health checks |
| [`scripts/build-student-release.mjs`](../../scripts/build-student-release.mjs), [`scripts/publish-student-release.mjs`](../../scripts/publish-student-release.mjs), [`scripts/lib/release-manifest.mjs`](../../scripts/lib/release-manifest.mjs) | Tracked-source release, secret guards, manifest/checksum, Dropbox publishing, and live verification |
| [`scripts/create-macos-app-bundle.mjs`](../../scripts/create-macos-app-bundle.mjs), [`scripts/build-macos-dmg.mjs`](../../scripts/build-macos-dmg.mjs) | Lightweight source launcher and full Electron/Node DMG packaging |
| [`scripts/update-student.mjs`](../../scripts/update-student.mjs), [`scripts/apply-update-and-restart.mjs`](../../scripts/apply-update-and-restart.mjs) | HTTPS update check/apply, preservation, backup, rollback, and detached restart |
| [`scripts/lib/process-lifecycle.mjs`](../../scripts/lib/process-lifecycle.mjs) | Identity-checked runtime state, stale-process recovery, foreign-port refusal, and child-group teardown |
| [`scripts/performance`](../../scripts/performance) | Privacy-safe interaction, launcher, and fixture benchmarks | Developer measurement only |

## Where new code belongs

- Shared contract or deterministic domain rule: `packages/core/src`.
- External integration, database write, queue, provider call, or operator
  command: `apps/runner/src`.
- Presentation or browser-only behavior: `apps/dashboard`.
- Native window/process lifecycle: `apps/desktop`.
- Install, build, update, or release orchestration: root `scripts`.
- A behavior-sensitive change needs a focused root test under `tests` before
  broad refactoring.

Do not put private message fixtures, real API keys, runtime databases, browser
profiles, screenshots, or logs in the repository.
