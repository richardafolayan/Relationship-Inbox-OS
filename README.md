# Relationship Inbox OS (Demo V1)

Local-first inbox command centre for managing unread DMs across LinkedIn, Instagram, and TikTok with browser automation.

## Stack

- `apps/dashboard`: Next.js App Router + TypeScript + Tailwind
- `apps/runner`: Node + Express + Playwright + OpenAI
- `packages/core`: shared types, selector registry, risk logic, Prisma schema
- `data`: SQLite + Playwright profiles + screenshots + DOM dumps

## Monorepo Layout

- `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard`
- `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner`
- `/Users/richard/IdeaProjects/relationship-inbox-os/packages/core`
- `/Users/richard/IdeaProjects/relationship-inbox-os/data`

## Install

1. Use Node `20.x`.
2. Install deps:

```bash
npm install
```

3. Generate Prisma client and sync schema:

```bash
npm run db:generate
npm run db:push
```

4. (Optional) Add `.env` in repo root:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5
RUNNER_PORT=4001
DASHBOARD_PORT=3100
USE_EVENTS_PROXY=false
BROWSER_PROFILE_MODE=isolated
PERSONAL_CHROME_USER_DATA_DIR=/Users/richard/Library/Application Support/Google/Chrome
PERSONAL_CHROME_PROFILE_DIRECTORY=Person 1
PERSONAL_CHROME_PROFILE_NAME=Richard Afolayan
```

## Run

Start dashboard + runner together:

```bash
npm run dev
```

- Dashboard: `http://localhost:3100`
- Runner: `http://localhost:4001`

## Control Plane URLs (UI-facing)

The dashboard calls same-origin URLs:

- `POST /runner/control/scan`
- `POST /runner/control/thread/:id/send`
- `POST /runner/control/thread/:id/open`
- `GET /runner/data/inbox`
- `GET /runner/data/thread/:id`
- `GET /runner/data/platforms`
- `GET /runner/data/logs`
- `GET /events`
- `GET /artifacts/:type/:name`

## Connect Platforms

1. Open `/platforms`.
2. Click `Connect` for each platform.
3. A visible Playwright window opens (`headless` default is off).
4. Sign in manually.
5. Runner marks platform connected once inbox DOM is detected.

Profile directories:

- `data/profiles/linkedin`
- `data/profiles/instagram`
- `data/profiles/tiktok`

## Personal Chrome Profile (Optional)

Use this if you want automation to run against your local Chrome profile `Person 1` (`Richard Afolayan`), instead of isolated runner profiles.

1. Set these values in `.env`:

```bash
BROWSER_PROFILE_MODE=personal
PERSONAL_CHROME_USER_DATA_DIR=/Users/richard/Library/Application Support/Google/Chrome
PERSONAL_CHROME_PROFILE_DIRECTORY=Person 1
PERSONAL_CHROME_PROFILE_NAME=Richard Afolayan
```

2. Restart the runner (`npm run dev`).
3. Connect a platform from `/platforms`.

Notes:

- If Chrome reports the profile is locked (for example Chrome is already using it), runner automatically falls back to isolated profiles under `data/profiles/*`.
- A fallback receipt is logged as `PERSONAL_PROFILE_FALLBACK` with the reason and fallback directory.
- Close regular Chrome windows that are using the same profile if you want personal mode to attach cleanly.

## Scanning Behaviour

- One platform scans at a time.
- LinkedIn reliability mode scans:
  - unread threads
  - plus top recent threads (`recentThreadSweepCount`, default `30`)
- Per candidate thread:
  - fetch last messages (`maxMessagesPerThread`, default `15`)
  - normalise + dedupe into SQLite
  - detect new inbound via timestamp/text hash vs DB
  - recompute risk + SLA
  - refresh AI summary when inbound changed

## Send Behaviour (Idempotent)

- UI sends with `clientSendId` UUID.
- Runner stores `send_requests`.
- Repeated `clientSendId` returns prior receipt, preventing double-send.

LinkedIn receipt verification stores:

- `bubble_detected`
- `timestamp_advanced`
- `best_effort`

## Selector Registry and Overrides

Default selector files:

- `packages/core/selectors/linkedin.json`
- `packages/core/selectors/instagram.json`
- `packages/core/selectors/tiktok.json`

Override workflow in `/platforms`:

1. Run selector tests.
2. Edit selector per key.
3. Test single selector.
4. Save override (stored in DB settings JSON).
5. Reset to default if needed.

## Selector Test Outputs

- Highlighted screenshots saved in `data/screenshots`
- DOM dumps saved in `data/dom_dumps`
- Accessible in UI via `/artifacts/screenshots/:name` and `/artifacts/dom_dumps/:name`

## Failure Receipts and Degraded State

On selector or automation failure, runner:

- captures screenshot and/or DOM dump
- writes audit log entry
- marks platform degraded
- emits SSE event

UI shows actionable degraded banner:

- Run selector tests
- Open receipts
- Open DOM dump

## SSE and Reconnect

- `GET /events` streams events with `eventId` and `jobId`.
- Runner buffers last ~500 events for replay.
- Reconnect supports `sinceEventId`.
- If event window is exceeded, `RESYNC_REQUIRED` is emitted and dashboard re-fetches core data endpoints.

## SSE Proxy Fallback

Primary: Next rewrites `/events` to runner.

Fallback: set `USE_EVENTS_PROXY=true` and use `apps/dashboard/app/events-proxy/route.ts` stream proxy.

## Demo Mode

Enable in `/settings`:

- Seeds realistic demo threads
- Includes at-risk examples
- Adds synthetic selector-fail logs and placeholder artifacts

Useful for walkthroughs when live inboxes are quiet.

## Useful Commands

```bash
npm run dev
npm run test:all
npm run move-on
npm run scan
npm run connect:linkedin
npm run test:selectors:linkedin
```

## Notes

- V1 is browser automation only (no official platform APIs).
- Sending is always user-triggered from UI (never automatic).
- Instagram/TikTok are beta adapters with graceful degradation and selector diagnostics.
