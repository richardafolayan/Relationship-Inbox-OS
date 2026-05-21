# Relationship Inbox OS

I'm bad at replying. Someone messages me, I think *"I'll reply properly when
I've got a moment"*, and then a week passes. By the time I come back the
chat has gone cold and I've half-forgotten what we were talking about.
Rereading it to catch up feels like work, so I close the tab.

Relationship Inbox OS is the fix I built for myself: a calm, local-first
workspace that pulls my unread messages into one place, tells me what each
one is about and what I still owe a reply on, and lets me actually deal with
it, without ever opening a feed.

It is **not** a dashboard, a CRM, or a tool that replies for you. It helps
*you* reply, in your own words.

## Contents

- [For pilot testers](#for-pilot-testers)
- [What it does](#what-it-does)
- [What's shipped](#whats-shipped)
- [Quick start](#quick-start)
- [The daily loop](#the-daily-loop)
- [Browser modes](#browser-modes)
- [How it's built](#how-its-built)
- [Docs](#docs)

## For pilot testers

If you're here for the student pilot, you only need three pages. Start with
the first:

1. **[Install guide](docs/pilot/student-install-guide.md)**: setting it up,
   written to be followed on a short call with me. No technical background
   needed.
2. **[What to test](docs/pilot/student-pilot-instructions.md)**: the pilot
   is about one question: *does this actually help you reply to people?*
3. **[Troubleshooting](docs/pilot/troubleshooting.md)**: quick fixes when
   something looks stuck.

The first pilot is **Mac and Chrome first**. You can stop reading this
README here. The rest is for people working on the code.

## What it does

The inbox shows every conversation in one view, sorted by who has been
waiting longest. For each one it tells you:

- **Who is waiting**, and how long it's been.
- **What they said**: a short summary, so you don't reread a cold thread.
- **What you still need to address**: the open questions, as a checklist.

You write the reply. AI help is optional and has three levels, from
summaries only, through help polishing your own draft, up to full suggested
drafts. Nothing is ever sent automatically.

## What's shipped

- **LinkedIn**: the main platform, and the most polished.
- **iMessage**: works, on macOS.
- **Instagram, TikTok**: beta; their UIs shift often, so they degrade
  gracefully rather than failing silently.
- **WhatsApp**: foundation only, not usable yet.

It runs entirely on your own machine. Your data lives on your laptop in a
local SQLite database, not on a server. The only thing that leaves is API
calls to your chosen AI provider, and you can turn AI off entirely.

## Quick start

For developers. Pilot testers: use the
[install guide](docs/pilot/student-install-guide.md) instead.

**You need:** Node.js 20+, npm, and Chrome.

**Install:**

```bash
npm install
npx playwright install
npm run db:generate
npm run db:push
```

**Configure:** copy the example env file and set an AI key.

```bash
cp .env.example .env
# then edit .env, set OPENAI_API_KEY (or Z_AI_API_KEY / GEMINI_API_KEY)
```

`.env.example` is fully commented. The defaults are fine for local use; for
the pilot, leave `BROWSER_PROFILE_MODE=personal`. See
[Browser modes](#browser-modes).

**Run:**

```bash
npm run dev
```

The dashboard is at `http://localhost:3100`, the runner at
`http://localhost:4001`. To pull in messages, press **⌘K** and choose
**Run scan now**.

There is no separate "connect" page in the everyday flow. In `personal`
mode the app uses the LinkedIn session already in your Chrome.

## The daily loop

**Today** opens on the one conversation that has waited longest, with a peek
at who's next. You read the summary and the things to address, write a
reply, and mark it done or snooze it. **Inbox** is the full list when you
want to work through everything; **Archived** is the history.

That's the whole product. Calm, low-surface-area, built around the single
job of replying to people without it feeling like work.

## Browser modes

The runner needs a browser session to read LinkedIn.

- **`personal`**: reuses your real Chrome profile and its signed-in
  LinkedIn session. Recommended, and the pilot default.
- **`isolated`**: the app opens its own browser and you sign in there. A
  fallback for when personal Chrome mode can't be used.

Full detail, including why `personal` is gentler on LinkedIn, is in the
[developer reference](docs/reference.md#browser-modes).

## How it's built

A small monorepo:

- `apps/dashboard`: the Next.js UI.
- `apps/runner`: an Express + Playwright service that drives the browsers
  and talks to AI providers.
- `packages/core`: shared types, risk logic, and the Prisma schema.

Data is SQLite via Prisma. Sending is always user-triggered. There is no
autonomous send loop.

## Docs

- [Pilot install guide](docs/pilot/student-install-guide.md)
- [Pilot testing instructions](docs/pilot/student-pilot-instructions.md)
- [Pilot troubleshooting](docs/pilot/troubleshooting.md)
- [Developer reference](docs/reference.md): configuration, CLIs, runner API
- [Current product direction](docs/strategy/current-product-direction.md)
