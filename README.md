# Tovi

_Working name. Formerly Relationship Inbox OS._

I have messages from people I care about that I genuinely mean to reply to.

I read them, think _“I’ll reply properly when I have a minute”_, and then leave them long enough that replying becomes a bigger job than the message ever was. I need to reread the thread, remember what I missed, work out what still needs answering, and explain where I went.

I built Tovi because I wanted a calmer way back into those conversations.

Tovi brings supported messages into one local desktop app. It shows what the other person said, what still needs addressing, and gives you a quiet place to write the reply in your own words.

AI can summarise the thread, pull out open loops, or help improve something you have already written. Full suggested replies are optional. Tovi never chooses or sends a message for you. You press **Send**, or explicitly schedule it yourself.

> Tovi is currently being prepared for a small 3 to 5 student pilot. The question is simple. Does it actually help people return to unfinished conversations and complete the reply?

## The core loop

1. Open **Today** and focus on the next conversation that needs attention.
2. Read the short context and the points that still need addressing.
3. Open the thread and write the reply yourself.
4. Send it, schedule it, snooze it, or mark the conversation handled.

That is the product I am testing.

## What is in the current build

### Today

A focused view of the next reply, with a small preview of what comes after it. The ordering uses reply state, snooze state, conversation age, favourites, and quiet hours.

### Inbox

The full active list, with search, filters, favourites, ordering, selection, bulk actions, snooze, and rescan controls.

### Thread workspace

Each thread can include:

- the conversation history and supported rich message content
- a short reply brief explaining where things stand
- required, optional, and handled points
- open-loop checkboxes and things to remember
- relationship context from other conversations with the same person
- a saved draft and editable composer
- explicit send, scheduled send, retry, snooze, archive, and mark-done controls

### Your voice and AI help

You can set your identity, preferred tone, common phrases, phrases to avoid, interests, and the amount of AI help you want.

There are three levels:

- **Memory only**, for summaries, context, and what still needs addressing
- **Writing support**, for improving text you wrote yourself
- **Full drafts**, for complete suggestions and compose-from-intent, available only when you opt in

Every suggestion stays editable. Sending remains a separate action.

### Pilot support

The build also includes optional notifications, quiet hours, dictation, voice-note transcription, app update checks, installation health checks, and an in-app feedback flow that does not automatically attach private message content.

## Message sources

| Source | Current state |
| --- | --- |
| **LinkedIn** | Primary pilot integration and the most mature browser-based path. |
| **iMessage** | Supported on macOS, including text, file, and voice attachments. Requires the relevant macOS permissions. |
| **WhatsApp** | Opt-in pilot integration with QR setup and rich-message handling. Disabled unless enabled for the build. |
| **Instagram and TikTok** | Beta adapters. They are not part of the primary student pilot setup. |
| **Windows** | Phase 0 is being verified in parallel with LinkedIn and WhatsApp. iMessage is unavailable on Windows. |

## For pilot testers

The first pilot is macOS and Chrome first.

Start here:

1. **[Install Tovi on macOS](docs/user/install.md)**
2. **[See what the pilot is testing](docs/pilot/student-pilot-instructions.md)**
3. **[Use the troubleshooting playbook](docs/troubleshooting/playbook.md)**

The pilot installer does not require a GitHub account, Homebrew, Python, Xcode, administrator access, or an existing Node installation.

## Privacy boundaries

The app and its SQLite database run on your own machine.

Some features still communicate with external services:

- platform adapters communicate with the platforms you connect
- configured AI providers receive the conversation content needed for the AI feature you use
- OpenAI transcription receives selected media when you choose that provider
- local transcription keeps the selected audio on the machine
- feedback sends only what you type, safe application context, and any screenshot you deliberately attach and confirm

AI can be disabled. Review the full [user guide](docs/user/guide.md#feedback-and-privacy) before using private conversations with an external provider.

## Developer quick start

Pilot testers should use the install guide above. This section is for people working on the code.

### Requirements

- Node.js 20 or newer
- npm
- Chrome

### Install

```bash
npm install
npx playwright install
npm run db:generate
npm run db:push
```

### Configure

```bash
cp .env.example .env
```

The example file explains every setting. The app can work as a message inbox without an AI key. Summaries, reply briefs, classification, and writing help need a configured provider.

### Run the local services

```bash
npm run dev
```

The interface runs at `http://localhost:3100` and the runner at `http://localhost:4001`.

To open the Electron shell during development, run this in another terminal:

```bash
npm run dev:desktop
```

Press **Command K** in the app and choose **Run scan now** to pull in messages.

### Useful commands

```bash
npm run doctor
npm run test:all
npm run docs:check
npm run build:macos-dmg
npm run build:windows
```

## How it is built

Tovi is a small monorepo:

- `apps/desktop` contains the Electron desktop shell
- `apps/dashboard` contains the Next.js interface
- `apps/runner` contains the Express service, Playwright browser automation, platform adapters, AI routing, and transcription flows
- `packages/core` contains shared types, risk logic, and the Prisma schema

Conversation data is stored in SQLite through Prisma. The product is local-first, but integrations and enabled providers still operate across the boundaries explained above.

## Current direction

The current baseline is being prepared for the student pilot. Major product expansion is paused until real use shows a repeated blocker.

The work now is limited to small improvements that reduce pilot friction, including setup clarity, installation hardening, feedback submission, and bug fixes.

The current build deliberately avoids:

- relationship scoring
- a people CRM
- an analytics dashboard
- automatic sending
- a public launch or paid product
- LeadOS crossover
- broad platform expansion before the core reply loop is proven

See [Current Product Direction](docs/strategy/current-product-direction.md) and [Current Build Status](docs/strategy/current-build-status.md) for the live source of truth.

## Documentation

- [Documentation index](docs/index.md)
- [User install guide](docs/user/install.md)
- [User guide](docs/user/guide.md)
- [Pilot testing instructions](docs/pilot/student-pilot-instructions.md)
- [Operator runbook](docs/operations/runbook.md)
- [Troubleshooting playbook](docs/troubleshooting/playbook.md)
- [Developer reference](docs/developer/repository.md)
- [Current feature inventory](docs/developer/features.md)
- [Architecture decisions](docs/adr/README.md)
- [Current product direction](docs/strategy/current-product-direction.md)
- [Current build status](docs/strategy/current-build-status.md)
