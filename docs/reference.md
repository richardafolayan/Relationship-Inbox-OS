# Developer Reference

Reference material for working on Relationship Inbox OS. The
[README](../README.md) covers what the app is and how to get it running;
this file holds the longer technical detail that does not need to be on the
front page.

## Contents

- [Configuration](#configuration)
- [Browser modes](#browser-modes)
- [AI providers](#ai-providers)
- [Audio transcription](#audio-transcription)
- [Settings page](#settings-page)
- [Command-line helpers](#command-line-helpers)
- [Runner API](#runner-api)
- [Maintenance scripts](#maintenance-scripts)

## Configuration

All configuration is environment variables. **`.env.example` is the source
of truth**: every variable is listed and commented there. Copy it to `.env`
and fill in what you need:

```bash
cp .env.example .env
```

The only variable you must set for AI features is an API key
(`OPENAI_API_KEY`, `Z_AI_API_KEY`, or `GEMINI_API_KEY`). Everything else has
a working default. The variables worth understanding are below.

## Browser modes

`BROWSER_PROFILE_MODE` decides how the runner gets a browser session.

- **`personal`**: the runner mirrors your real Chrome profile and reuses
  the LinkedIn session you are already signed into. This is the recommended
  mode, and the default for the student pilot: a genuine signed-in Chrome
  profile is the gentlest path for LinkedIn's automation detection. It is
  configured by the `PERSONAL_CHROME_*` variables in `.env.example`.
- **`isolated`**: the runner launches its own clean browser context and you
  sign in inside it. Simpler to set up, but a fresh automated browser is a
  stronger bot signal. Use it as a fallback.

`PERSONAL_PROFILE_FALLBACK=allow_isolated` lets personal mode fall back to an
isolated context if the Chrome profile is locked or unavailable.

Keep the headless browser **off** (the Settings toggle, off by default). A
visible browser (run offscreen) keeps a full human fingerprint; headless
is one of the strongest bot signals.

## AI providers

`AI_PROVIDER` selects the LLM provider: `openai` (default), `glm` (Z.AI), or
`gemini`. Each has its own key and model variable in `.env.example`. The
provider can also be switched at runtime, and AI can be turned off entirely.
Summaries, action items and drafts simply stop being generated.

## Audio transcription

Voice and audio attachments captured during scans can be transcribed via
OpenAI's `/v1/audio/transcriptions` endpoint, so summaries, the reply
brief, the checklist, and predraft suggestions all read voice content as
ordinary text. Off by default. iMessage is the only supported source in
v1 (chat.db exposes the stored `.caf` voice notes); LinkedIn voice
messages are not captured today.

Enable with these `.env` variables (defaults shown):

```
AUDIO_TRANSCRIPTION_ENABLED=false
AUDIO_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe
AUDIO_TRANSCRIPTION_MAX_BYTES=26214400
AUDIO_TRANSCRIPTION_MAX_SECONDS=600
AUDIO_TRANSCRIPTION_LANGUAGE=en
```

`OPENAI_API_KEY` is reused; with the key blank the service marks every
attachment `skipped` and warns once at startup. `gpt-4o-mini-transcribe`
is the cheaper default; set `AUDIO_TRANSCRIPTION_MODEL=gpt-4o-transcribe`
for higher quality at higher cost. Other model ids accepted by the
endpoint are also passed through unchanged but are not supported.

Supported MIME types: `audio/mpeg`, `audio/mp4`, `audio/m4a`,
`audio/webm`, `audio/ogg`, `audio/wav`, `audio/aac`, `audio/flac`.
iMessage `.caf` voice notes are converted to `.m4a` via macOS
`afconvert` before upload, using the same converter that the dashboard
uses to play them inline.

How it runs:

- The scan-queue persists messages first, then enqueues a fire-and-forget
  transcription pass for any inbound message carrying a `voice_note` or
  `audio` attachment. Scans never block on transcription.
- A stable `audioFingerprint` (the platform message key plus the
  attachment guid) is the dedup key. Re-scans never spend a second
  OpenAI call on audio that has already been transcribed, failed, or
  skipped. A future admin reset endpoint can delete the row to retry.
- Each row records status (`pending`, `transcribed`, `failed`,
  `skipped`), the provider, the model, language, duration, and a short
  safe error message. Raw API bodies are never stored.
- The thread page renders a quiet `voice message transcript` line under
  the audio control when a transcription succeeded. Pending and failed
  states show a calm one-line hint. Skipped states stay silent.

Realtime transcription (`gpt-realtime-whisper` and similar) is
intentionally out of scope. Stored voice notes are files; the file
endpoint is the simplest and cheapest fit. If the app ever streams live
audio, a streaming provider can be added as a sibling without touching
the file path used here.

Privacy note: transcripts become part of the AI context for that thread
and are stored alongside the message rows in the local SQLite database.
Treat them like message content.

## Settings page

The v1 Settings page is deliberately small. It has:

- **Auto-scan**: pull new messages on a cadence.
- **Quiet hours**: mute the attention dot and pause auto-scan late at night.
- **Headless browser**: leave off (see [Browser modes](#browser-modes)).
- **Your reply style**: the voice/identity profile the AI uses, plus the
  **AI help level** (memory only / writing support / full drafts).
- **Pilot**: feedback / bug-report shortcuts and the welcome card.

Operator-console knobs from earlier versions (scan thresholds, model
pickers, danger-zone resets) were removed from the UI; they live as
environment variables or admin CLIs.

## Command-line helpers

```bash
npm run dev          # full local startup (db generate/push + build + dev)
npm run dev:fast     # faster loop (skips db + core build)
npm run build        # build all packages
npm run lint         # typecheck all workspaces
npm run test         # run the test suite
npm run db:generate  # regenerate the Prisma client
npm run db:push      # apply the schema to the local SQLite db
```

Single app: `npm run dev:dashboard`, `npm run dev:runner`.

## Runner API

The runner (Express) exposes routes under `/control/*` (actions), `/data/*`
(reads), and `/admin/*` (token-guarded). The dashboard reaches them through
proxied `/runner/...` paths. The route definitions live in
`apps/runner/src/index.ts`: treat that file as the API's source of truth
rather than a hand-maintained list here.

Sending is always user-triggered. The runner can scan, classify, draft,
queue and schedule, but a person has to click send (or schedule a draft)
for any message to leave.

## Maintenance scripts

```bash
npm run linkedin:smoke          # one-thread LinkedIn ingest, end-to-end check
npm run repair:linkedin-threads # dry-run dedupe/recency repair (add -- --apply)
npm run db:reset:linkedin       # token-guarded LinkedIn data wipe
npm run cleanup:artifacts       # prune old screenshots / run folders (add -- --apply)
```

Runtime artifacts (screenshots, DOM dumps, run folders) live under `data/`
and `logs/`, are gitignored, and can be pruned safely. The cleanup script
never touches the SQLite database.
