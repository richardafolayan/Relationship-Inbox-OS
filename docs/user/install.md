# Install on macOS

This is the canonical installation guide for student-pilot builds. No GitHub
account, Homebrew, Python, Xcode, or administrator access is required.

## Before you start

You need:

- macOS 13 Ventura or newer;
- Messages signed in on the Mac if you want iMessage;
- Google Chrome signed in to LinkedIn if you want LinkedIn personal-profile
  mode;
- at least 4 GB free, with 8 GB recommended;
- a stable internet connection for the first install.

The pilot installer uses Node 22. If the Mac does not already have the exact
supported major, it downloads the official Node 22 archive, verifies its
checksum, and installs it under `~/.rios-node` without `sudo`.

## Install from the pilot ZIP

1. Unzip the build anywhere.
2. Open Terminal.
3. Type `bash `, drag `scripts/install-student-macos.sh` from the unzipped
   folder into Terminal, then press Return.
4. Wait while the installer copies the tracked application into
   `~/RelationshipInboxOS`, installs dependencies, creates the database,
   prepares the dashboard, and
   creates `~/Applications/Tovi.app`.

The installer is safe to rerun. It preserves the existing `.env`, `data/`,
and `logs/` while replacing application code.

Release operators can also provide a private one-line download command. Use
only the exact HTTPS command supplied by the pilot operator. Do not substitute
an untrusted download URL.

## First launch and permissions

Open Tovi from Applications or Launchpad. The source-install
launcher starts the local runner and dashboard and opens
`http://localhost:3100`.

On a new install, the setup assistant opens before Today. It asks for your
name, lets you choose iMessage, LinkedIn, and WhatsApp independently, checks
Contacts, and offers optional AI help and optional local voice transcription.
Nothing is required just to open Today. Every choice can be changed later in
**Settings > Setup**.

Grant only the permissions needed for features you choose:

| Permission | Needed for | When and how |
| --- | --- | --- |
| Full Disk Access | Reading Messages `chat.db` and local Contacts databases | Open System Settings, Privacy & Security, Full Disk Access. Add or enable `~/Applications/Tovi.app`, then quit and reopen the app. macOS does not show an automatic prompt for this permission. |
| Automation for Messages | Sending an iMessage or SMS after you press Send | macOS prompts on the first send. Choose Allow. |
| Accessibility | Sending iMessage file attachments through Messages UI scripting | Grant the launcher or terminal process in System Settings, Privacy & Security, Accessibility only if an attachment send reports that it is required. Text-only sends do not need this UI-scripting path. |
| Microphone | Dictation and recording a voice note | The browser or Electron shell asks after you press the microphone control. |
| Notifications | Optional new-message, update, and digest notifications | Enable explicitly in Settings. A denied permission must be changed in browser or macOS notification settings. |

The current DMG declares a camera usage description, but the verified
dashboard requests audio only and has no current camera capture flow.

## Connect message sources

### iMessage

1. Confirm recent conversations appear in Apple's Messages app.
2. In the setup assistant, press **Open Full Disk Access**. Turn on
   **Tovi**, then quit and reopen the app.
3. In the setup assistant, press **Scan iMessage**. You can also do this later
   from Settings.
4. On the first user-triggered send, allow Messages automation.

### LinkedIn

The pilot default mirrors the selected normal Chrome profile. Sign into
LinkedIn in Chrome first, then press **Connect LinkedIn** in the setup
assistant. You can also do this later from Settings. Complete 2FA or any
account verification yourself. The app does not need a stored password for
the normal path.

### WhatsApp

Choose WhatsApp in the setup assistant. Press **Connect WhatsApp**, then open
WhatsApp on your phone, open **Settings > Linked Devices > Link a Device**, and
scan the QR code Tovi shows. The local linked-device session is kept below the
installation's `data/profiles/whatsapp` directory.

## Configure voice transcription

Voice transcription is off on a fresh install and uses no model space. Choose
**Standard** to download the local `whisper-base.en` model at about 150 MB, or
**Enhanced** to download `whisper-small.en` at about 500 MB. Audio stays on the
Mac. Open **Settings > Setup > Optional components** to switch models, turn
transcription off, or remove the downloaded model later.

Instagram and TikTok adapters are beta and are not part of the primary pilot
setup.

## Configure AI help

The app works as a message inbox without an AI key. Summaries, reply briefs,
classification, and writing help need at least one configured provider key.
Use the first-run setup assistant, or open **Settings > Setup > Run setup
assistant**, to create and save a free Gemini key. See
[AI key setup](../pilot/getting-ai-keys.md) for the exact click-by-click steps.
No file editing, Terminal command, or restart is needed.

When summaries or writing help run, the relevant conversation text is sent to
Google's Gemini service for processing. The key remains on this Mac. Tovi
never sends a reply to another person unless you press send.

## Verify the installation

Run the read-only health check:

```bash
cd ~/RelationshipInboxOS
npm run doctor
```

`WARN` can be expected for an intentionally unused integration. Resolve every
`FAIL` for a feature you want to use.

## Start, stop, and reopen

- Start: open Tovi from Applications or Launchpad.
- Stop: quit the app. If using the Terminal fallback, press Control-C.
- Terminal fallback:

```bash
cd ~/RelationshipInboxOS
npm run start:student
```

Do not start several copies. The Electron shell enforces one instance, but
the browser launcher can still meet an already-running source process on the
same ports.

## Update

Use Settings, App updates, Check for updates. A source installation offers
Update and relaunch; it verifies the manifest and ZIP, preserves `.env`,
`.env.bak`, `data/`, and `logs/`, and retains a rollback backup. A packaged
DMG build instead tells you to replace the app from a newer DMG. Its data and
settings remain under `~/Library/Application Support/Relationship Inbox OS`.

Terminal equivalents:

```bash
cd ~/RelationshipInboxOS
npm run update:student -- --check-only
npm run update:student -- --apply
```

## Uninstall

From the installed folder:

```bash
cd ~/RelationshipInboxOS
bash scripts/uninstall-student-macos.sh
```

The confirmed uninstall removes matching source and packaged app locations,
Application Support data, logs, and the legacy app-managed Node runtime after
confirmation. Add `--keep-data` to retain messages, settings, and logs. It
does not alter Messages, Contacts, Chrome, LinkedIn, WhatsApp, or the
corresponding accounts.

Uninstalling deletes the local SQLite database and application data. Back up
the active `data/` directory first if the history matters.
