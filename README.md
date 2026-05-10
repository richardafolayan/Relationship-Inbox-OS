# Relationship Inbox OS

A local-first command center for managing unread DMs across LinkedIn, Instagram, and TikTok — all in one place.

Instead of bouncing between apps to keep up with conversations, Relationship Inbox OS pulls your unread messages into a single inbox, flags ones at risk of going stale, and helps you reply faster with AI-assisted drafting. Everything runs on your own machine — your messages and data never leave it.

## Features

- **Unified inbox** — see unread DMs from every connected platform in one prioritized list.
- **Risk scoring** — threads are flagged AMBER or RED as they age, so you reply before relationships go cold.
- **AI-assisted replies** — generate suggested replies, shorten, warm up the tone, or rewrite in your own voice.
- **Thread workspace** — view conversation history, draft replies, snooze, schedule sends, or set open-loop reminders.
- **People view** — a lightweight relationship panel showing last interaction, tags, and notes per person.
- **Send queue** — schedule replies for later or queue them up; cancel or retry anytime.
- **Activity log** — every scan and send is recorded with screenshots, so you can always see what happened.
- **Local-first** — runs entirely on your machine. No cloud sync, no third-party servers handling your messages.

## Getting Started

### What you'll need

- A Mac with Google Chrome installed
- [Node.js](https://nodejs.org/) version 20 or newer
- An OpenAI API key (for the AI reply features)

### Install

```bash
npm install
```

### Configure

Copy the example settings file and add your OpenAI key:

```bash
cp .env.example .env
```

Open `.env` and paste your OpenAI API key into the `OPENAI_API_KEY` line.

### Run

```bash
npm run dev
```

Then open **http://localhost:3100** in your browser.

## How to Use It

1. **Connect a platform.** Go to the *Platforms* page and click **Connect** next to LinkedIn. Sign in when the browser window opens.
2. **Scan for messages.** Click **Run scan** to pull in your unread DMs.
3. **Open a thread.** From the inbox, click any conversation to see the full history.
4. **Draft a reply.** Use the AI suggestions, write your own, or transform the tone. Then send it directly or schedule it for later.
5. **Stay on top of things.** Snooze threads you'll handle later, archive ones you're done with, and set reminders for replies you're waiting on.

## Daily Workflow

Most days look like this:

1. Open the inbox.
2. Tackle anything flagged RED (most urgent), then AMBER, then the rest.
3. Reply, snooze, or mark done.
4. Done.

## Settings

Open the *Settings* page in the dashboard to adjust things like:

- How often the inbox auto-scans
- When threads turn AMBER or RED
- Which platforms are active
- AI provider and model
- Quiet hours (so scheduled replies don't go out at 2 AM)

## Troubleshooting

**Can't connect to a platform?** Make sure you're signed in to it in the Chrome window that opens, then try again.

**Inbox looks broken or empty?** Go to *Platforms* → **Reset session** → **Connect**, then run a scan.

**Need more help?** Check the *Activity Log* page — every action records a receipt with screenshots so you can see exactly what happened.
