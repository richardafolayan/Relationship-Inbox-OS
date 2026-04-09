# Relationship Inbox OS — Codebase Overview

## What it is
A **local-first inbox command center** for managing unread DMs across **LinkedIn, Instagram, and TikTok**. It uses browser automation (Playwright) to scrape messages, stores them in a local SQLite DB, scores them by risk/SLA, and lets you reply with AI assistance — all from a Next.js dashboard.

Everything runs on your machine. There are no official platform APIs in v1 — it drives a real Chrome browser.

## Tech Stack
- **Monorepo:** npm workspaces + Turbo
- **Dashboard:** Next.js (App Router) + TypeScript + Tailwind
- **Runner:** Node + Express + Playwright + OpenAI
- **Database:** SQLite via Prisma
- **Language:** TypeScript everywhere

## Top-Level Layout
```
relationship-inbox-os/
├── apps/
│   ├── dashboard/    # Next.js UI (port 3100)
│   └── runner/       # Express + Playwright server (port 4001)
├── packages/
│   └── core/         # Shared types, Prisma schema, risk logic, selectors
├── data/             # SQLite DB, browser profiles, screenshots, DOM dumps
├── tests/            # Node test runner integration tests
└── logs/             # Runtime logs
```

## The Two Apps

### 1. `apps/dashboard` — The UI (Next.js App Router)
Where the operator lives. Everything is a thin client that proxies to the runner.

**Pages (`app/`):**
- `inbox/` — Prioritized unread feed with risk KPIs & filters
- `thread/` — Single-thread workspace (timeline, AI tools, send, snooze)
- `platforms/` — Connect/reconnect, run scans, selector tests, reset sessions
- `settings/` — Scan interval, SLA thresholds, headless toggle, demo mode
- `logs/` — Activity log with receipts & artifact links
- `people/` — Lightweight relationship panel
- `at-risk/` — Filtered view of SLA-breached threads
- `events/` + `events-proxy/` — SSE stream endpoints

**Supporting dirs:**
- `components/` — Organized by page (inbox, thread, platforms, logs, layout, ui, common)
- `lib/` — `api.ts` (runner client), `time.ts`, `types.ts`, `utils.ts`

### 2. `apps/runner` — The Brain (Express + Playwright)
The automation engine. Does all the actual browser work, DB writes, and AI calls.

**Entry points (`src/`):**
- `index.ts` — Express server, all routes
- `cli.ts` — CLI wrappers (`scan`, `connect`, `test-selectors`, `linkedin-smoke`)
- `config.ts` — Env var loading
- `db.ts` — Prisma client
- `dev-flags.ts` — Dev-only toggles

**`platforms/`** — Browser automation adapters
- `linkedin-adapter.ts` — The mature one (deep scroll, backfill, auth detection)
- `beta-adapter.ts` — Instagram/TikTok (still beta)
- `browser-launch.ts` — Playwright launch + profile management
- `personal-profile-mirror.ts` — Mirrors your real Chrome profile into a managed dir
- `utils.ts` — Shared adapter helpers

**`services/`** — The meat of the runner (~20 modules)
- **Session:** `session-manager.ts`, `session-coordinator.ts`, `keyed-mutex.ts` — per-person/per-platform locks
- **Scan loop:** `scan-queue.ts`, `scan-retry-controller.ts`, `linkedin-inflight-guard.ts`
- **Send:** `send.ts` — idempotent via `clientSendId`
- **AI:** `ai.ts` — OpenAI calls (suggest, shorten, warmer)
- **Audit/telemetry:** `audit.ts`, `event-bus.ts` (SSE), `run-logger.ts`, `selector-report-store.ts`
- **Selectors:** `selector-tests.ts`, `failure-routing.ts`
- **Admin:** `admin-reset.ts`, `settings.ts`, `demo.ts`
- **Platform dispatch:** `platform-factory.ts`
- **LinkedIn smoke test:** `linkedin-smoke-direct.ts`, `linkedin-smoke-logger.ts`
- **Shaping:** `thread-row-shaping.ts`

**`linkedin/`** — LinkedIn-specific parsers
- `linkedinIdentity.ts`, `linkedinRowSignals.ts`, `linkedinTime.ts`

**`scripts/`** — Maintenance CLIs
- `cleanup-artifacts.ts` — Prune old run folders
- `repair-linkedin-threads.ts` — Conservative dedupe/recency repair
- `reset-linkedin-inbox.ts` — Token-guarded LinkedIn wipe

### 3. `packages/core` — Shared Code
- `src/types.ts` — Shared TS types
- `src/selectors.ts` — CSS selectors per platform
- `src/risk.ts` — Amber/red risk scoring logic
- `src/adapters.ts` — Adapter interface
- `src/autoscan.ts` — Autoscan scheduling
- `src/events.ts` — Event type definitions
- `src/defaults.ts` — Default settings
- `src/hash.ts` — Hashing utilities
- `prisma/schema.prisma` — SQLite schema (Person, Thread, Message, Draft, SendRequest, etc.)

## Data Flow (Mental Model)

```
[Chrome profile] → Playwright → linkedin-adapter → services/* → Prisma → SQLite
                                       ↓
                                   event-bus (SSE)
                                       ↓
                              Dashboard /events stream → UI
```

**Typical scan:**
1. User clicks **Run scan** in dashboard
2. Dashboard hits `POST /runner/control/scan`
3. Runner enqueues via `scan-queue`, acquires person+platform mutex
4. `session-manager` launches/reuses managed Playwright context
5. `linkedin-adapter` scrolls the inbox, collects threads, opens each one, backfills messages
6. Writes to SQLite via Prisma; emits events via `event-bus`
7. Dashboard SSE receives updates → UI re-renders
8. Every step writes **receipts** + screenshot/DOM artifacts to `data/`

**Typical send:**
1. User drafts reply (optionally AI-assisted via `services/ai.ts`)
2. Dashboard hits `POST /runner/control/thread/:id/send` with `clientSendId`
3. Runner checks idempotency, opens thread in managed tab, types & sends
4. Writes send receipt; degrades gracefully with `THREAD_SYNC_FAIL` if isolated failure

## Key Concepts to Know

- **Managed person context:** One Playwright browser context per user, one tab per platform, protected by per-platform mutex locks
- **Personal vs isolated profile mode:** Personal mirrors your real Chrome profile (`PERSONAL_PROFILE_SYNC_MODE` = smart/always/never); isolated uses a managed dir
- **Receipts:** First-class audit records linked to screenshots + DOM dumps (in `data/`)
- **Selector overrides:** Operators can patch broken selectors live from `/platforms` without code changes
- **Degradation model:** A single bad thread emits `THREAD_SYNC_FAIL` without poisoning the whole platform
- **Risk scoring:** Threads age into AMBER → RED based on `amberHours` / `redHours` settings
- **SSE events:** Runner streams `/events`, dashboard consumes either directly or via `events-proxy` route

## Runner API Surface (quick reference)

**Control (mutations):** `/control/settings`, `/control/scan`, `/control/platform/*` (connect, test-selectors, open-browser, reset-session, save-selector-override), `/control/thread/:id/*` (send, open, rescan, transform, draft, mark-done, snooze)

**Data (reads):** `/data/settings`, `/data/inbox`, `/data/thread/:id`, `/data/receipts`, `/data/platforms`, `/data/logs`, `/data/people`

**Infra:** `/health`, `/events` (SSE), `/artifacts/:type/:name`, `/admin/reset` (token-guarded)

## Where to Start for Common Changes

| You want to... | Go to |
|---|---|
| Add/modify a dashboard page | `apps/dashboard/app/<page>/` |
| Change UI components | `apps/dashboard/components/<area>/` |
| Add/fix a runner API route | `apps/runner/src/index.ts` |
| Change how LinkedIn is scraped | `apps/runner/src/platforms/linkedin-adapter.ts` |
| Add a new platform | `apps/runner/src/platforms/` + `packages/core/src/selectors.ts` |
| Change risk thresholds/logic | `packages/core/src/risk.ts` |
| Modify DB schema | `packages/core/prisma/schema.prisma` → `npm run db:push` |
| Tweak AI prompts | `apps/runner/src/services/ai.ts` |
| Add a CLI command | `apps/runner/src/cli.ts` + `scripts/` |
| Change scan scheduling | `apps/runner/src/services/scan-queue.ts` + `packages/core/src/autoscan.ts` |

## Important Files to Read First
1. `README.md` — Operator runbook + full env var reference (already very thorough)
2. `apps/runner/src/index.ts` — All runner routes in one file
3. `apps/runner/src/platforms/linkedin-adapter.ts` — The canonical adapter pattern
4. `packages/core/prisma/schema.prisma` — Data model
5. `packages/core/src/types.ts` — Shared types everything imports
