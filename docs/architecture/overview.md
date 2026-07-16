# System architecture

Tovi is a local-first desktop application. A dashboard renders
the reply workflow, a local runner owns external integrations and persistence,
an optional Electron shell hosts the dashboard, and the core workspace holds
shared contracts and the Prisma schema.

```text
Platform data                         Optional external services
LinkedIn / Instagram / TikTok         OpenAI / Gemini API / Z.AI
iMessage chat.db / Contacts           Pilot feedback webhook / GitHub
WhatsApp Web
        |                                      |
        v                                      v
  platform adapters  --->  runner services and Express API
                              |       |       |
                              |       |       +--> audit logs / run traces
                              |       +----------> AI and transcription
                              +------------------> Prisma + local SQLite
                                              |
                                              v
 Next.js dashboard <--- HTTP + SSE proxy --- runner
        ^
        |
 Electron desktop window or ordinary browser
```

The canonical end-to-end sequence is in the
[message lifecycle](message-lifecycle.md). Workspace ownership and the source
module map are in the [repository reference](../developer/repository.md).

## Runtime components

### Dashboard

[`apps/dashboard`](../../apps/dashboard) is a Next.js 15 and React 19 client.
It renders Today, Inbox, Reconnect, Settings, thread, archive, diagnostic, and
demo routes. It never opens platform databases or calls provider SDKs. It uses
relative `/runner/*` requests, which Next rewrites to the runner configured by
`RUNNER_ORIGIN` or `RUNNER_PORT`. [`events-proxy/route.ts`](../../apps/dashboard/app/events-proxy/route.ts)
streams the runner's server-sent events into the browser.

### Runner

[`apps/runner`](../../apps/runner) is an Express service. It is the only
component that owns platform sessions, scans, send dispatch, AI provider
clients, Prisma writes, local attachment serving, update orchestration, and
structured audit receipts. It binds to `127.0.0.1:4001` by default.

The runner exposes:

- `/data/*` for reads;
- `/control/*` for user or operator actions;
- `/system/*` for version and update operations;
- `/admin/*` for explicitly guarded destructive operations;
- `/health` for runtime health;
- `/events` for server-sent event delivery.

Route definitions in [`apps/runner/src/index.ts`](../../apps/runner/src/index.ts)
are the API source of truth.

### Desktop shell and launchers

There are three verified launch shapes:

1. [`scripts/start-student.mjs`](../../scripts/start-student.mjs) launches a
   source installation, opens the dashboard in the default browser, and
   applies any staged update before startup.
2. [`scripts/create-macos-app-bundle.mjs`](../../scripts/create-macos-app-bundle.mjs)
   creates a small local `.app` launcher that points at the source installation.
3. [`apps/desktop/main.cjs`](../../apps/desktop/main.cjs) is the Electron shell
   used by the packaged DMG. It owns a single window, a single child app
   process, local-only navigation, external-link handoff, process recovery,
   and a one-time choice to import an existing source installation's data.

The packaged shell keeps signed application code immutable. Configuration,
data, and runtime state live below `~/Library/Application Support/Relationship
Inbox OS`; desktop logs live below `~/Library/Logs/RelationshipInboxOS`.

These are distinct paths. The source ZIP release and the DMG are not the same
artifact. See the [release runbook](../operations/releases.md).

### Core package

[`packages/core`](../../packages/core) supplies shared types, the platform
adapter contract, selector loading, risk and scheduling helpers, iMessage
system-event filtering, and the Prisma schema. Both runner and dashboard
depend on its compiled output. Core does not own network sessions or database
connections.

### SQLite database

The runner uses Prisma with a local SQLite file. Runtime settings, messages,
AI-derived thread state, drafts, send requests, audit receipts, and
transcription state all persist there. WAL mode is enabled best-effort at
runner startup so readers can continue while one writer appends.

The complete model and storage map is in
[database and storage](../developer/data-and-storage.md).

## Data and trust boundaries

### Local by default

The SQLite database, browser profiles, message attachments, transcripts,
models, logs, and update state live under the source installation or the
packaged app's macOS user directories. The runner binds to loopback by
default. The dashboard should
not be pointed at a remote runner unless the operator has deliberately added
transport security and authentication, which the current repository does not
provide.

### Data that can leave the Mac

- AI prompt context goes to the selected configured provider when AI runs.
- OpenAI audio transcription receives audio only when that provider is
  explicitly selected.
- LinkedIn, Instagram, TikTok, and WhatsApp operations communicate with their
  respective platform services.
- Pilot feedback goes to the configured webhook. A screenshot is sent only
  when the user attaches and confirms it. Message content is not added
  automatically.
- The updater fetches an HTTPS manifest and source ZIP from the configured
  release feed.

Local Transformers or local Whisper transcription keeps audio on the Mac.

## Concurrency and consistency

- Scans are serialized by the scan queue and per-platform mutex.
- Sends are durable `SendRequest` rows drained serially by the send queue.
- SQLite and adapter message keys provide idempotent upserts; outbound rows
  have additional send-time versus scan-time reconciliation.
- The runner emits bounded, replayable events. The dashboard also performs
  visible, low-frequency polling, so event loss does not become permanent
  stale state.
- Inbox responses use a 20-second, URL-keyed, version-gated in-memory cache.
  JSON and gzip bytes are prepared once per cache entry; `X-RIOS-Cache` and
  `Server-Timing` expose cache status and preparation time without message
  content. Any runner event or mutation invalidates the cache.

## Important design records

- [ADR 0001: Local-first split runtime](../adr/0001-local-first-split-runtime.md)
- [ADR 0002: Normalized platform adapter boundary](../adr/0002-platform-adapter-boundary.md)
- [ADR 0003: SQLite schema synchronization](../adr/0003-sqlite-schema-synchronization.md)
- [ADR 0004: Durable, user-triggered send queue](../adr/0004-durable-user-triggered-send.md)
- [ADR 0005: AI compatibility routing and deterministic voice controls](../adr/0005-ai-routing-and-voice-controls.md)
- [ADR 0006: Replayable local events with polling recovery](../adr/0006-events-and-polling-recovery.md)
