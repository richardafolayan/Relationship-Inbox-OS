# Relationship Inbox

I'm bad at replying.

The pattern's the same every time. Someone sends me something on LinkedIn. I see it. I think *"I'll reply properly when I've got a moment."* Then a week passes. By the time I come back to the chat it's gone cold, and I've half-forgotten what we were even talking about. Rereading the whole thread to figure out where we left off feels like work, so I close the tab and tell myself I'll do it tomorrow.

I don't do it tomorrow.

This same thing happens to me across LinkedIn, iMessage, WhatsApp, and Instagram. Messages stranded across four apps, all aging quietly, all carrying that low-grade guilt of *"I should have replied days ago."* And every time I open one of those apps to deal with it, I get pulled into the feed instead and forget what I came for. Twenty minutes gone, three reels watched, and I still haven't replied to my mum.

So I built one place that pulls all of it together.

## What it does

The inbox shows every conversation from every platform in one view, sorted by who's been waiting longest. Next to each conversation it tells me how long it's been since I last replied, summarises what the chat is actually about, and flags the questions I haven't answered yet. I don't have to reread anything to remember where I left off. I just see *"this person asked you X three days ago"* and I can reply.

When I'm not sure what to write, the AI helps. It can draft a reply based on the context of the conversation, soften something I've written too bluntly, or summarise a long back-and-forth so I can catch up at a glance.

The whole thing pulls my messages without me having to open LinkedIn or Instagram. No feed. No "while you're here, look at this" distraction. Just the messages.

## When you want to start a conversation, not just maintain one

There's a separate problem this also helps with. Wanting to reach out to someone you haven't spoken to before and not knowing how to open.

You set up a small profile of yourself, what you do, what you're into, what you're working on. Then when you want to message someone, you search them on the app. It pulls what's public about them, their posts, the comments they've left on other people's posts, the things they've reacted to, and finds where their world overlaps with yours. From there it suggests an opener that's specific to them rather than the generic "Hi, hope you're well" everyone ignores.

It saves the half hour of stalking through someone's profile to find something to mention. The system does the looking for you.

## Who this is for

If you keep meaning to reply to messages and somehow never do, this might be useful. The whole flow is built around the friction that stops me from replying, the rereading, the forgetting, the getting pulled into the feed. If those are also the things stopping you, the rest of this app will feel familiar. If you also want to start conversations with people you haven't met yet without spending an hour rehearsing what to say, the networking side covers that too.

If none of that's your problem, this probably isn't for you, and that's completely fine.

## What's actually shipped

LinkedIn is the one I use daily, so it's the most polished. Instagram and TikTok work but their UIs change often, and the system degrades gracefully when something breaks rather than failing silently. iMessage and WhatsApp foundations are in place but I haven't built the UI for them yet. Adding more platforms over time.

It runs locally on your own machine. Your data lives on your laptop, not on someone's server. The only thing that leaves is API calls to your AI provider of choice (OpenAI, GLM via Z.AI, or Gemini), and you can turn AI off entirely if you'd rather draft everything yourself.

## Quick start

### What you need

Node.js 20 or newer. npm 10.8.2. Chrome installed locally if you want personal profile mode (which most people will).

### Get it running

```bash
npm install
npx playwright install
npm run db:generate
npm run db:push
```

Make a `.env` file in the repo root. The minimum to get going.

```bash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5
RUNNER_PORT=4001
DASHBOARD_PORT=3100
USE_EVENTS_PROXY=false
BROWSER_PROFILE_MODE=isolated
```

If you want to use your own Chrome profile so you stay logged in (recommended), see the personal profile config in the Reference section further down.

Start it.

```bash
npm run dev
```

Dashboard at http://localhost:3100. Runner at http://localhost:4001.

### First connection

Open http://localhost:3100/platforms and hit Connect on LinkedIn. If you're using personal profile mode, make sure you're already signed into the right Chrome profile. Wait for the status to flip to CONNECTED.

Click Run scan. Threads start appearing in /inbox.

Open one. Reply, either yourself or with one of the AI tools. Then check the Activity Log to confirm it actually sent.

That's the loop.

## A typical day

### Morning

I open /inbox first thing. The red threads at the top are the ones that have gone cold for over 48 hours. I work through those first. Reply, mark done, snooze, depending on what each one needs.

If a thread is asking for something I don't have to hand (a link, a doc, a decision), I predraft a placeholder reply, snooze the thread for a few hours, and come back to it after I've sorted whatever was missing.

### Through the day

The scan runs in the background and pulls new messages as they arrive. Sometimes I'll do a manual run if I know I've been ignored on something specific.

When the inbox starts feeling cluttered with stuff that doesn't actually need me (broadcast messages, automated notifications, threads that aren't really live), I bulk-select and clear them. The threads stay in the database, they just don't show in the active view anymore.

### End of day

I close out anything that's now waiting on the other person. Anything I want to follow up on later, I set an "open loop" reminder so it resurfaces at the right time.

If anything's stuck in the send queue, that usually means a network blip or an auth issue. I retry or cancel and rewrite.

## When something breaks

### "Profile already in use" or lock errors

Another Chrome process is using the same profile directory.

Close any manually opened Chrome windows on the affected profile. Retry from /platforms. If you need to keep working before sorting it out, set `PERSONAL_PROFILE_FALLBACK=allow_isolated` in your env to fall back to an isolated profile temporarily.

### Connect timeouts

Personal mode has a longer timeout budget by default (90 seconds, vs 25 for isolated mode). If you're still hitting timeouts, bump `CONNECT_OPERATION_TIMEOUT_MS_PERSONAL` higher. Verify the auth state is valid by opening the browser window directly (not via Connect) and checking you're actually logged in.

### Auth required, or LinkedIn redirects to login

Open the browser window for the platform. Sign in. Retry Connect. Re-run the scan. The session cookie probably expired.

### Selector failures

If the selector tests show a fail on `composer_input` or `send_button`, LinkedIn's UI has shifted. Run the tests again (the adaptive probing checks multiple threads). If still failing, look at the screenshot the test produced, find the new selector that matches the current UI, save an override, and re-run.

The override is per-platform and persists across scans. When LinkedIn ships a fix that matches the original selector again, you can reset the override and go back to defaults.

### Dashboard errors connecting to runner

The runner isn't up, or it's on a different port than the dashboard expects. Check `http://localhost:4001/health` returns OK. Confirm `RUNNER_PORT` and `DASHBOARD_PORT` match.

### Port already in use

Some other process is on the runner port. Either stop it or change `RUNNER_PORT` in your env and restart.

### Fast reset checklist

If you're stuck and want to reset to a known good state, the order is:

1. Verify runner health (`/health`).
2. Verify ports and env match.
3. From /platforms, click Reset session, then Connect.
4. Run selector tests for the failing platform.
5. Re-run scan.
6. Check Activity Log for residual blockers.

The reset session step rebuilds the shared person context across all platforms, so it's the heaviest hammer available short of clearing the database.

## How it's built

Monorepo with three workspaces.

`apps/dashboard` is the Next.js UI. App Router, TypeScript, Tailwind.

`apps/runner` is the Express plus Playwright service that drives the browsers and talks to AI providers.

`packages/core` holds shared types, selector definitions, risk-scoring logic, and the Prisma schema.

Data sits in SQLite via Prisma. Browser profiles, screenshots, DOM dumps, and other artifacts live under `/data` in the repo root.

The runner has two browser profile modes. Isolated launches a clean managed Playwright context every time. Personal mirrors your real Chrome profile so the runner sees what you see (logged-in cookies, your actual Chrome state). Personal mode is what most people want for daily use.

Sending is always user-triggered. There's no autonomous send loop. The runner can scan, scrape, classify, draft, queue, and schedule, but a human has to click the button (or schedule a draft) for anything to actually leave.

## Reference

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `OPENAI_API_KEY` | empty | OpenAI API key for AI features. |
| `OPENAI_MODEL` | `gpt-5` | OpenAI model used by runner. |
| `GLM_API_KEY` | empty | GLM (Z.AI) API key for AI features. |
| `Z_AI_MODEL` | `glm-4.7-flash` | GLM model used by runner. |
| `GEMINI_API_KEY` | empty | Gemini API key for AI features. |
| `GEMINI_MODEL` | `gemma-4-31b-it` | Gemini/Gemma model used by runner. |
| `DATABASE_URL` | `file:./data/inbox-os.sqlite` | Prisma DB URL. |
| `RUNNER_PORT` | `4001` | Runner API server port. |
| `DASHBOARD_PORT` | `3100` | Dashboard port. |
| `USE_EVENTS_PROXY` | `false` | Use dashboard SSE proxy instead of direct rewrite stream. |
| `BROWSER_PROFILE_MODE` | `isolated` | `isolated` or `personal`. |
| `PERSONAL_PROFILE_FALLBACK` | `error` | `error` or `allow_isolated` for personal mode fallback. |
| `PERSONAL_PROFILE_SYNC_MODE` | `smart` | `smart`, `always`, or `never`. |
| `PERSONAL_PROFILE_MIRROR_ROOT` | empty | Optional override for mirror root. |
| `PERSONAL_CHROME_USER_DATA_DIR` | macOS Chrome path | Source Chrome user-data directory. |
| `PERSONAL_CHROME_PROFILE_DIRECTORY` | `Person 1` | Profile directory key or display name. |
| `PERSONAL_CHROME_PROFILE_NAME` | `Richard Afolayan` | Display label used in diagnostics. |
| `CONNECT_OPERATION_TIMEOUT_MS` | `25000` | Connect timeout for isolated mode. |
| `CONNECT_OPERATION_TIMEOUT_MS_PERSONAL` | `90000` | Connect timeout for personal mode. |
| `LINKEDIN_SCAN_MAX_THREADS` | `200` | Max threads collected in deep LinkedIn pass. |
| `LINKEDIN_SCAN_STABLE_ITERATIONS` | `3` | Stop after this many no-growth iterations. |
| `LINKEDIN_SCAN_SCROLL_WAIT_MS` | `700` | Wait between scroll iterations. |
| `LINKEDIN_SCAN_MESSAGE_BACKFILL_ATTEMPTS` | `8` | Max message pane backfill attempts per thread. |
| `LINKEDIN_DEV_SCAN_MAX_THREADS` | empty | Dev-only cap for full-scan candidate count. |
| `LINKEDIN_DEV_SCAN_MAX_OPENS` | empty | Dev-only cap for threads opened in one full scan. |
| `LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL` | `0` | Dev-only toggle to disable deep scroll. |
| `LINKEDIN_DEV_DISABLE_AUTOSCAN` | `1` | Dev-only background autoscan disable. |
| `LINKEDIN_DEV_LOG_STAGE_HEADLINES` | `1` | Dev-only stage headline logs. |
| `ADMIN_RESET_TOKEN` | empty | Required token for `/admin/reset` and reset CLI. |
| `ADMIN_RESET_ENABLED` | unset | Optional explicit enable in non-dev environments. |
| `NEXT_PUBLIC_DISABLE_AUTOSCAN` | `1` | Dashboard autoscan gate. |
| `NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN` | `1` | Legacy dashboard autoscan disable flag. |

### Runtime settings (`/settings` page)

| Setting | What it does |
|---|---|
| `scanIntervalSeconds` | How often the scheduler scans. |
| `amberHours` | Hours before a thread becomes amber risk. |
| `redHours` | Hours before a thread becomes red risk. |
| `maxMessagesPerThread` | Max messages fetched per thread. |
| `recentThreadSweepCount` | Additional recent thread sweep size. |
| `headless` | Browser visibility for automation. |
| `demoMode` | Seed and cleanup demo dataset. |
| `enabledPlatforms` | Active platforms for scheduler scans. |
| `aiProvider` | `openai`, `glm`, or `gemini`. |
| `glmModel` | Optional GLM model override. |
| `geminiModel` | Optional Gemini/Gemma model override. |

### API routes

Runner-native base is `http://localhost:4001`. Dashboard calls go through proxied endpoints under `/runner/...` and `/events`.

#### Health and events

- `GET /health`
- `GET /events`
- `GET /artifacts/:type/:name`

#### Control routes

- `POST /control/settings`
- `POST /control/scan`
- `POST /control/platform/connect`
- `POST /control/platform/test-selectors`
- `POST /control/platform/save-selector-override`
- `POST /control/platform/reset-selector-override`
- `POST /control/platform/open-browser`
- `POST /control/platform/linkedin/smoke-unread`
- `POST /control/platform/reset-session`
- `POST /control/thread/:threadId/send` (accepts optional `scheduledFor` ISO 8601)
- `POST /control/thread/:threadId/cancel-send`
- `POST /control/thread/:threadId/retry-send`
- `POST /control/thread/:threadId/open`
- `POST /control/thread/:threadId/rescan`
- `POST /control/thread/:threadId/resummarize`
- `POST /control/thread/:threadId/transform`
- `POST /control/thread/:threadId/compose`
- `POST /control/thread/:threadId/predraft`
- `POST /control/thread/:threadId/voice-rewrite`
- `POST /control/thread/:threadId/draft`
- `POST /control/thread/:threadId/reassess`
- `POST /control/thread/:threadId/recategorize`
- `POST /control/thread/:threadId/archive`
- `POST /control/thread/:threadId/unarchive`
- `POST /control/thread/:threadId/open-loop`
- `POST /control/thread/:threadId/mark-done`
- `POST /control/thread/:threadId/snooze`
- `GET  /control/thread/:threadId/suggest-snooze`
- `POST /control/classify-uncategorized`
- `POST /control/resummarize-stale`
- `POST /control/person/:personId/notes`
- `POST /control/person/:personId/enrich`
- `POST /control/person/:personId/profile-url`
- `POST /control/self/enrich`
- `POST /control/system/clear-db`
- `POST /control/system/restart`

#### Admin routes

- `POST /admin/reset` (dev-only by default, requires token plus `confirm: "RESET"`)

#### Data routes

- `GET /data/settings`
- `GET /data/ai-status`
- `GET /data/inbox`
- `GET /data/thread/:threadId`
- `GET /data/receipts`
- `GET /data/platforms`
- `GET /data/logs`
- `GET /data/people`
- `GET /data/person/:personId`
- `GET /data/self`
- `GET /data/archived`
- `GET /data/send-queue`

### LinkedIn smoke run

Triggers a one-thread LinkedIn unread ingest. Useful for verifying the scan pipeline end-to-end without doing a full pass.

```bash
npm run linkedin:smoke
```

Or via the API.

```bash
POST /control/platform/linkedin/smoke-unread
```

Always writes artifacts under the run folder. `pretty.log`, `events.ndjson`, `actions.csv`, `list-probe.json`, `list-probe.html`, `list-probe.png`. Failures additionally drop `dom.html` and `failure.png`. Latest run pointer at `apps/runner/logs/runs/LATEST_LINKEDIN_SMOKE.txt`.

Success response. `{ ok: true, requestId, logDir, result: { outcome, unreadCount, name, listTimestamp, preview, messagesParsed, probeArtifacts } }`. Outcome is `INGESTED_ONE_THREAD` or `UNREAD_EMPTY`.

Failure response. `{ ok: false, requestId, logDir, stage, reason, error }`.

### LinkedIn repair CLI

Conservative dedupe and recency repair for LinkedIn threads. Defaults to dry-run.

```bash
npm run repair:linkedin-threads
```

Apply the planned merges and timestamp recompute.

```bash
npm run repair:linkedin-threads -- --apply
```

Optional cleanup for unresolved zero-message placeholders.

```bash
npm run repair:linkedin-threads -- --apply --delete-zero-message-unresolved
```

Every run writes an NDJSON report under `data/repair` unless you pass `--report <path>`.

### Token-guarded LinkedIn reset

For when you need to wipe LinkedIn and start fresh.

Runner route is `POST /admin/reset` (dashboard path: `/runner/admin/reset`).

Guards.

- Dev-only unless `ADMIN_RESET_ENABLED=1`.
- Requires `ADMIN_RESET_TOKEN` match (header `x-admin-reset-token` or body `token`).
- Requires `confirm: "RESET"`.

Default scope from the dashboard action is `platform: "LINKEDIN"`. The reset deletes the LinkedIn graph in foreign-key-safe order (sendRequests, drafts, messages, threads) and removes only truly orphan Person rows (those with no threads anywhere).

CLI wrapper.

```bash
npm run db:reset:linkedin
```

### Artifact cleanup

Runtime artifacts (screenshots, DOM dumps, run folders) are gitignored and can be pruned safely. Always dry-run first.

```bash
npm run cleanup:artifacts
```

Apply deletion.

```bash
npm run cleanup:artifacts -- --apply
```

Defaults are: keep last 20 run folders, keep artifacts newer than 7 days. The script never touches SQLite DB files.

### Cheat sheet

```bash
# Full local startup (db generate/push + core build + dashboard+runner dev)
npm run dev

# Faster dev loop (skips db generate/push + core build)
npm run dev:fast

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
npm run db:reset:linkedin
npm run cleanup:artifacts
```

## Notes

This README tracks shipped behaviour in `apps/runner/src/index.ts` and the dashboard pages. If you add new control routes, data routes, or settings fields, update this README in the same PR so the docs stay accurate.

Browser automation only in v1. No official platform API integrations. Sending is always user-triggered. Instagram and TikTok adapters are beta and degrade gracefully via selector diagnostics. iMessage and WhatsApp foundations are in place but not yet UI-exposed.

Receipts and artifacts are first-class debugging primitives. When something goes wrong, check those before changing selectors.
