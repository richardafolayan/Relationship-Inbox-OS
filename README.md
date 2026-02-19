# Relationship Inbox OS (Operator + Developer Guide)

Relationship Inbox OS is a local-first inbox command center for managing unread DMs across LinkedIn, Instagram, and TikTok using browser automation, risk scoring, receipts, and AI-assisted reply workflows.

This guide is for:
- Operators who run the inbox daily.
- Developers who maintain or extend the runner and dashboard.

## Table of Contents

- [What This Project Is](#what-this-project-is)
- [Feature Inventory (Current, Shipped)](#feature-inventory-current-shipped)
- [Quick Start (Step-by-Step, First Run)](#quick-start-step-by-step-first-run)
- [Daily Usage Workflow (Operator Runbook)](#daily-usage-workflow-operator-runbook)
- [LinkedIn Repair CLI](#linkedin-repair-cli)
- [Configuration Reference](#configuration-reference)
- [Profiles and Browser Session Model](#profiles-and-browser-session-model)
- [API Surface (Practical Reference)](#api-surface-practical-reference)
- [Troubleshooting](#troubleshooting)
- [Safety, Limitations, and Behavior Guarantees](#safety-limitations-and-behavior-guarantees)
- [Commands Cheat Sheet](#commands-cheat-sheet)

## What This Project Is

Monorepo layout:
- `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard`: Next.js App Router UI.
- `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner`: Express + Playwright runner.
- `/Users/richard/IdeaProjects/relationship-inbox-os/packages/core`: shared types, selectors, risk logic, Prisma schema.
- `/Users/richard/IdeaProjects/relationship-inbox-os/data`: SQLite DB, browser profiles, screenshots, DOM dumps.

Stack:
- Dashboard: Next.js + TypeScript + Tailwind.
- Runner: Node + Express + Playwright + OpenAI.
- Data: SQLite via Prisma.

## Feature Inventory (Current, Shipped)

### Dashboard surfaces

- Inbox:
  - Unread/at-risk KPIs and filters.
  - Prioritized list with risk, unread count, preview, and action buttons.
  - Degraded banner shortcuts to selector tests, receipts, and DOM dumps.
- Thread workspace:
  - Timeline view with message direction and timestamps.
  - Actions: open in platform, rescan thread, save draft, snooze, mark done/manual review, send.
  - AI tools: suggested replies, shorten, make warmer.
  - Receipts drawer for traceability.
- Platforms:
  - Connect/reconnect per platform.
  - Run platform scan.
  - Open browser window.
  - Run selector tests.
  - Save/reset selector overrides.
  - Reset session.
  - Personal profile diagnostics shown inline (mode, sync mode, source dir, launch dir, resolution strategy).
- Settings:
  - Scan interval, amber/red SLA thresholds.
  - Max messages per thread, recent thread sweep count.
  - Headless toggle.
  - Demo mode toggle.
  - Enabled platforms.
  - Danger zone: reset platform sessions, clear DB.
- Activity Log:
  - Receipts-first trace of scans, sends, selector checks, failures.
  - Artifact links for screenshots and DOM dumps.
- People view:
  - Lightweight relationship panel with platform, last interaction, risk, tags, notes.

### Runner capabilities

- Control and data APIs for all dashboard actions.
- SSE stream with replay window and resync support.
- Audit logging with screenshot/DOM artifact pointers.
- Idempotent send workflow using `clientSendId`.
- Browser profile modes:
  - Managed shared person context under `data/profiles/__managed_person_profiles/default`.
  - Personal Chrome mirrored profile mode.
- Personal mode mirror behavior:
  - Sync mode support (`smart`, `always`, `never`).
  - Directory-first profile resolution.
  - Fallback behavior (`error` or `allow_isolated`).
- Shared session lifecycle + keyed locks:
  - One browser context per person, with one managed tab per platform.
  - Queue-one lock policy per `person+platform` to prevent overlap.
  - Shared reset path rebuilds the whole managed person context.
- Abort-aware scan queue:
  - Graceful `SCAN_ABORTED` behavior on reset/abort.
  - Avoids false degradation from lifecycle interruptions.
- LinkedIn reliability mode:
  - Auth-required detection (`AUTH_REQUIRED` with `401` and platform `NOT_CONNECTED`).
  - Deep thread list collection for virtualized/infinite inbox.
  - Deterministic thread activation checks.
  - Message backfill collection in thread panes.
  - Per-thread failure receipts (`THREAD_SYNC_FAIL`) without degrading whole platform for isolated thread errors.
- Selector test behavior:
  - Uses the same launch pipeline as platform connect.
  - Adaptive probing for reply-capable threads (stabilizes `composer_input` and `send_button` checks).

### CLI capabilities

- `scan`: trigger scan.
- `connect <PLATFORM>`: connect a platform.
- `test-selectors <PLATFORM>`: run selector tests.
- `linkedin-smoke`: run one-thread LinkedIn unread smoke ingest.
- `repair:linkedin-threads`: plan/apply conservative LinkedIn dedupe + recency repair.

### LinkedIn Repair CLI

The LinkedIn repair command is conservative and defaults to dry-run.

Dry-run (safe default):

```bash
npm run repair:linkedin-threads
```

Apply planned merges/recompute timestamps:

```bash
npm run repair:linkedin-threads -- --apply
```

Optional explicit cleanup for unresolved zero-message placeholders:

```bash
npm run repair:linkedin-threads -- --apply --delete-zero-message-unresolved
```

Every run writes an NDJSON report under `/Users/richard/IdeaProjects/relationship-inbox-os/data/repair` unless `--report <path>` is provided.

## Quick Start (Step-by-Step, First Run)

### 1) Prerequisites

- Node.js `20.x` or newer.
- npm (project uses `npm@10.8.2`).
- macOS Chrome installed for personal profile mode.

### 2) Install dependencies

```bash
npm install
```

If Playwright browser binaries are missing on first run:

```bash
npx playwright install
```

### 3) Initialize database/client

```bash
npm run db:generate
npm run db:push
```

### 4) Configure environment

Create `.env` in repo root (or copy from `.env.example`) and set at least:

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5
RUNNER_PORT=4001
DASHBOARD_PORT=3100
USE_EVENTS_PROXY=false
BROWSER_PROFILE_MODE=isolated
```

For personal profile mode, also configure:

```bash
PERSONAL_PROFILE_FALLBACK=error
PERSONAL_PROFILE_SYNC_MODE=smart
PERSONAL_CHROME_USER_DATA_DIR=/Users/richard/Library/Application Support/Google/Chrome
PERSONAL_CHROME_PROFILE_DIRECTORY=Person 1
PERSONAL_CHROME_PROFILE_NAME=Richard Afolayan
CONNECT_OPERATION_TIMEOUT_MS=25000
CONNECT_OPERATION_TIMEOUT_MS_PERSONAL=90000
```

### 5) Start dashboard + runner

```bash
npm run dev
```

Expected:
- Dashboard at `http://localhost:3100`.
- Runner at `http://localhost:4001`.

### 6) Verify health

Open:
- `http://localhost:3100/inbox`

Optional runner check:

```bash
curl http://localhost:4001/health
```

### 7) Connect first platform

- Go to `http://localhost:3100/platforms`.
- Click `Connect` on LinkedIn first.
- In personal mode, ensure you are signed into the intended Chrome profile.
- Wait for status to become `CONNECTED`.

### 8) Run first scan

- From `/platforms`, click `Run scan` for LinkedIn, or start global scan from UI controls.
- Confirm `Last scan` updates and rows appear in `/inbox`.

### 9) Open a thread and send test reply

- Open `/inbox` and click a thread row.
- On thread page, optionally use AI suggestions/transform tools.
- Send with `Send (Cmd+Enter)` or button.

### 10) Verify receipts/artifacts

- Open Activity Log (`/logs`) or Receipts drawer.
- Confirm send/scan receipts.
- For failures, open linked screenshot/DOM artifacts under `/artifacts/...`.

## Daily Usage Workflow (Operator Runbook)

### Morning loop

1. Open `/inbox` and `/platforms`.
2. Check degraded banners first.
3. Run scan.
4. Prioritize `RED` then `AMBER`, then unread.
5. Open thread, draft/transform reply, send.
6. Mark done or snooze where needed.
7. Confirm outcomes in Activity Log/Receipts.

### Recovery loop (when degraded)

1. From `/platforms`, run selector tests for affected platform.
2. If a selector fails, test override candidate.
3. Save override if pass, otherwise reset to default.
4. Re-run scan.
5. If still failing, reset platform session and reconnect.

## Configuration Reference

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | empty | OpenAI API key for AI summary/reply features. |
| `OPENAI_MODEL` | `gpt-5` | OpenAI model used by runner. |
| `DATABASE_URL` | `file:./data/inbox-os.sqlite` | Prisma DB URL (scripts often override explicitly). |
| `RUNNER_PORT` | `4001` | Runner API server port. |
| `DASHBOARD_PORT` | `3100` | Dashboard port. |
| `USE_EVENTS_PROXY` | `false` | Use dashboard SSE proxy route instead of direct rewrite stream. |
| `BROWSER_PROFILE_MODE` | `isolated` | `isolated` or `personal`. |
| `PERSONAL_PROFILE_FALLBACK` | `error` | In personal mode: `error` or `allow_isolated` fallback behavior. |
| `PERSONAL_PROFILE_SYNC_MODE` | `smart` | Mirror sync mode: `smart`, `always`, `never`. |
| `PERSONAL_PROFILE_MIRROR_ROOT` | empty | Optional override for mirror root. |
| `PERSONAL_CHROME_USER_DATA_DIR` | macOS Chrome path | Source Chrome user-data directory for personal mode. |
| `PERSONAL_CHROME_PROFILE_DIRECTORY` | `Person 1` | Profile directory key or display name (directory-first resolution). |
| `PERSONAL_CHROME_PROFILE_NAME` | `Richard Afolayan` | Display label used in diagnostics. |
| `CONNECT_OPERATION_TIMEOUT_MS` | `25000` | Connect timeout budget for isolated mode. |
| `CONNECT_OPERATION_TIMEOUT_MS_PERSONAL` | `90000` | Connect timeout budget for personal mode. |
| `LINKEDIN_SCAN_MAX_THREADS` | `200` | Max threads to collect in deep LinkedIn pass. |
| `LINKEDIN_SCAN_STABLE_ITERATIONS` | `3` | Stop after stable no-growth iterations. |
| `LINKEDIN_SCAN_SCROLL_WAIT_MS` | `700` | Wait between LinkedIn scroll collection iterations. |
| `LINKEDIN_SCAN_MESSAGE_BACKFILL_ATTEMPTS` | `8` | Max message pane backfill attempts per thread. |
| `LINKEDIN_DEV_SCAN_MAX_THREADS` | empty | Dev-only cap for LinkedIn full scan candidate count. |
| `LINKEDIN_DEV_SCAN_MAX_OPENS` | empty | Dev-only cap for how many LinkedIn threads are opened in one full scan. |
| `LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL` | `0` | Dev-only toggle to disable LinkedIn deep scroll and keep one visible pass. |
| `LINKEDIN_DEV_DISABLE_AUTOSCAN` | `1` | Dev-only runner scheduler guard; disables background autoscan ticks by default. |
| `LINKEDIN_DEV_LOG_STAGE_HEADLINES` | `1` | Dev-only toggle for always-visible `[LI][SCAN]` headline logs. |
| `NEXT_PUBLIC_DISABLE_AUTOSCAN` | `1` | Dashboard autoscan gate; in dev it defaults to disabled unless explicitly set `0`. |
| `NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN` | `1` | Legacy dashboard autoscan disable flag (still honored). |

### Runtime settings (`/settings`)

| Setting | Meaning |
|---|---|
| `scanIntervalSeconds` | Scheduler scan interval. |
| `amberHours` | Hours before thread becomes AMBER risk. |
| `redHours` | Hours before thread becomes RED risk. |
| `maxMessagesPerThread` | Max messages fetched/considered per thread. |
| `recentThreadSweepCount` | Additional recent thread candidate sweep size. |
| `headless` | Browser visibility mode for automation. |
| `demoMode` | Seed/cleanup demo dataset and demo receipts. |
| `enabledPlatforms` | Active platform list for scheduler scans. |

## Profiles and Browser Session Model

### Isolated mode

- Launches with a shared managed person directory:
  - `data/profiles/__managed_person_profiles/default`
- Best for predictable automation isolation.

### Personal mode

- Uses your local Chrome user-data source and mirrors selected profile into the shared managed person launch dir.
- Uses `channel: chrome` with `--profile-directory=<resolved profile>`.
- Profile resolution is directory-first, then name match.

### Mirror sync semantics

- `smart`: sync only when target missing or source marker is newer.
- `always`: always sync before launch.
- `never`: skip sync.

### Profile lock behavior and shared session ownership

- Runner uses one managed context per person and coordinates actions with per-platform mutex keys.
- Reset session acquires global reset lock, aborts scans, and recreates the managed person context.
- Runner does not close manually opened personal Chrome windows.
- If a personal profile is locked by external Chrome processes:
  - with `PERSONAL_PROFILE_FALLBACK=error`: connect/test fails fast with explicit error.
  - with `PERSONAL_PROFILE_FALLBACK=allow_isolated`: runner falls back to isolated profile launch.

### Expected behavior for browser control actions

- `Connect`: uses managed shared session tab, validates platform connection.
- `Run selector tests`: uses managed shared session tab and auth-aware readiness checks.
- `Open browser window`: opens managed shared session tab for manual interaction.

## API Surface (Practical Reference)

Runner-native base: `http://localhost:4001`

Dashboard calls proxied endpoints under `/runner/...` and `/events`.

### Health/events/artifacts

- `GET /health`
- `GET /events`
- `GET /artifacts/:type/:name`

### Control routes

- `POST /control/settings`
- `POST /control/scan`
- `POST /control/platform/connect`
- `POST /control/platform/test-selectors`
- `POST /control/platform/save-selector-override`
- `POST /control/platform/reset-selector-override`
- `POST /control/platform/open-browser`
- `POST /control/platform/linkedin/smoke-unread`
- `POST /control/platform/reset-session`
- `POST /control/system/clear-db`
- `POST /control/thread/:threadId/send`
- `POST /control/thread/:threadId/open`
- `POST /control/thread/:threadId/rescan`
- `POST /control/thread/:threadId/transform`
- `POST /control/thread/:threadId/draft`
- `POST /control/thread/:threadId/mark-done`
- `POST /control/thread/:threadId/snooze`

### LinkedIn smoke unread run

- `POST /control/platform/linkedin/smoke-unread`
- `npm run linkedin:smoke`
- Always writes smoke artifacts under the run folder:
  - `pretty.log`
  - `events.ndjson`
  - `actions.csv`
  - `list-probe.json`
  - `list-probe.html`
  - `list-probe.png`
  - failure-only: `dom.html`, `failure.png`
- Updates latest pointer: `apps/runner/logs/runs/LATEST_LINKEDIN_SMOKE.txt`
- Success response shape:
  - `{ ok: true, requestId, logDir, result: { outcome, unreadCount, name, listTimestamp, preview, messagesParsed, probeArtifacts } }`
  - `outcome` is `INGESTED_ONE_THREAD` or `UNREAD_EMPTY`
- Failure response shape:
  - `{ ok: false, requestId, logDir, stage, reason, error }`

### Data routes

- `GET /data/settings`
- `GET /data/inbox`
- `GET /data/thread/:threadId`
- `GET /data/receipts`
- `GET /data/platforms`
- `GET /data/logs`
- `GET /data/people`

## Troubleshooting

### `...profile is already in use` / lock errors

Symptoms:
- Selector tests/connect fail with profile lock or singleton messages.

Actions:
1. Close all manually opened Chrome windows using the same personal profile.
2. Retry from `/platforms`.
3. If needed, set `PERSONAL_PROFILE_FALLBACK=allow_isolated` for temporary continuity.
4. Reconnect platform.

### `CONNECT_* timed out after ...ms`

Symptoms:
- Connect returns timeout failure.

Actions:
1. In personal mode, use `CONNECT_OPERATION_TIMEOUT_MS_PERSONAL=90000` or higher if needed.
2. Verify auth state is valid in opened browser profile.
3. Check runner logs for connect step receipts.
4. Retry `Connect` from `/platforms`.

### `AUTH_REQUIRED` / LinkedIn redirect to login

Symptoms:
- Connect fails with auth-required message.
- Platform status flips to `NOT_CONNECTED`.

Actions:
1. Open browser window for platform.
2. Sign in on LinkedIn in the active profile.
3. Retry `Connect`.
4. Re-run scan.

### Dashboard proxy `ECONNREFUSED` to runner

Symptoms:
- Dashboard errors while calling `localhost:4001`.

Actions:
1. Ensure runner process is actually up.
2. Ensure `RUNNER_PORT` matches dashboard expectations.
3. Restart `npm run dev`.
4. Verify `http://localhost:4001/health`.

### `EADDRINUSE :::4001`

Symptoms:
- Runner fails to start because port is already in use.

Actions:
1. Stop existing runner process using port `4001`.
2. Or change `RUNNER_PORT` and restart both apps.

### Selector fails for `composer_input` / `send_button`

Symptoms:
- Selector report shows `composer_input` or `send_button` fail intermittently.

Actions:
1. Run selector tests again (adaptive probing now checks multiple threads).
2. If still failing, inspect screenshot/DOM dump for current UI variant.
3. Save an override for that selector.
4. Re-run tests and scan.

### Fast reset checklist

1. Verify runner health (`/health`).
2. Verify ports and env (`RUNNER_PORT`, `DASHBOARD_PORT`).
3. On `/platforms`: `Reset session` -> `Connect`.
   - Reset now rebuilds the shared person context for all platforms.
4. Run selector tests for failing platform.
5. Re-run scan.
6. Check Activity Log and receipts for remaining blockers.

## Safety, Limitations, and Behavior Guarantees

- Browser automation only in v1; no official platform API integrations.
- Sending is always user-triggered from UI. No autonomous send loop.
- Instagram/TikTok adapters are beta and can degrade gracefully with selector diagnostics.
- Receipts and artifacts are first-class debugging primitives and should be checked before changing selectors.
- Shared session reset targets runner-owned managed Playwright context only.

## Commands Cheat Sheet

```bash
# Full local startup (db generate/push + core build + dashboard+runner dev)
npm run dev

# Build all packages
npm run build

# Lint
npm run lint

# Run all tests
npm run test
npm run test:all
npm run move-on

# Prisma helpers
npm run db:generate
npm run db:push
npm run db:migrate

# Run one app
npm run dev:dashboard
npm run dev:runner

# Runner CLI wrappers
npm run scan
npm run connect:linkedin
npm run test:selectors:linkedin
npm run linkedin:smoke
```

## Notes

- This README is aligned to current shipped routes and UI behavior in `apps/runner/src/index.ts` and dashboard pages.
- If you add new control/data routes or settings fields, update this README in the same PR to keep operator docs accurate.
