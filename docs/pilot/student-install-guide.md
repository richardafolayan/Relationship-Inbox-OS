# Student Pilot — Install Guide

This is the setup guide for the Relationship Inbox OS student pilot. It is
written to be followed **on a short call with me** — you do not need to be
technical. If a step looks confusing, stop there and we will do it together.

The app runs entirely on your own Mac. Nothing is uploaded to a server.

## What you need

- A **MacBook**. The first pilot is Mac-only — iMessage support is
  macOS-only, and I want to keep the first round simple.
- **Google Chrome**, and you signed into LinkedIn in it as normal.
- About 20 minutes, and me on a call with you.

I will send you an AI key to paste into one file. You do not need your own.

## Step 1 — Get the code

On the call I will give you the project folder (a download or a `git clone`
link). Open the **Terminal** app and move into that folder:

```bash
cd path/to/relationship-inbox-os
```

## Step 2 — Install it

Run these four commands one at a time. Each one finishes before you run the
next. The first two take a few minutes.

```bash
npm install
npx playwright install
npm run db:generate
npm run db:push
```

If a command prints a wall of text and ends without the word `error`, it
worked.

## Step 3 — Create your settings file

In the project folder there is a file called `.env.example`. Make a copy of
it named `.env`:

```bash
cp .env.example .env
```

Then open `.env` in a text editor. You only need to touch two things — I
will give you both on the call:

- `OPENAI_API_KEY=` — paste the key I send you after the `=`.
- `BROWSER_PROFILE_MODE=personal` — leave this as `personal` (see
  [Browser modes](#browser-modes) below).

Leave everything else as it is. We will fill in the Chrome profile details
together on the call — they depend on your Mac.

## Step 4 — Start the app

```bash
npm run dev
```

Leave that Terminal window open — it keeps the app running. When it settles,
open **Chrome** and go to:

```
http://localhost:3100
```

## Step 5 — Set up your reply style

The first time you open it, the **Today** page shows a short welcome card
and a "Set up your reply style" card. Fill the reply-style card in — your
name and a sentence on how you usually message people. This is what makes
the app support *your* words rather than sounding generic. It takes a minute
and you can change it later in Settings.

## Step 6 — Pull in your messages

The app reads your messages in the background. To pull them in the first
time, press **⌘K** to open the command bar, type `scan`, and choose
**Run scan now**. Your conversations appear on **Today** and **Inbox**.

On a Mac, iMessage is included automatically. macOS may pop up a permission
request the first time — allow it, or ask me on the call.

That is the whole setup. From here, see
[student-pilot-instructions.md](./student-pilot-instructions.md) for what to
actually test, and [troubleshooting.md](./troubleshooting.md) if something
looks stuck.

## Browser modes

The app needs a browser session to read LinkedIn. There are two modes, set
by `BROWSER_PROFILE_MODE` in your `.env` file.

- **`personal` (use this for the pilot).** The app reuses your real Chrome
  profile, so it sees the LinkedIn you are already signed into. Nothing new
  to log into. This is the gentlest option for LinkedIn — a normal,
  signed-in Chrome looks far less unusual than a fresh automated browser.
- **`isolated` (fallback only).** The app opens its own separate browser
  window and you sign into LinkedIn inside that one. Use this **only** if
  personal Chrome mode cannot be set up — for example if you do not use
  Chrome as your main browser.

Two more things, both already set for you:

- **Keep the headless browser off.** There is a toggle in Settings — leave
  it off. A visible browser (it runs quietly offscreen) looks more like a
  real person than a hidden one.
- **Chrome is preferred** for this pilot. If you mainly use Safari or
  Firefox, tell me — we will use `isolated` mode and you will sign into
  LinkedIn in the app's own window.

## A note on Windows

The app can technically run on Windows, but the first pilot is **Mac-only**
on purpose: iMessage is macOS-only, and I want a small, consistent first
round. If you only have a Windows PC, let me know and we will sort something
out — just do not treat Windows as the normal pilot path yet.
