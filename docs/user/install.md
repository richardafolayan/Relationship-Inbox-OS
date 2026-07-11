# Install on macOS

This is the canonical installation guide for student-pilot builds. No GitHub
account, Homebrew, Python, Xcode, or administrator access is required.

## Before you start

You need:

- macOS 13 Ventura or newer;
- Messages signed in on the Mac if you want iMessage;
- Google Chrome signed in to LinkedIn if you want LinkedIn personal-profile
  mode;
- at least 10 GB free, with 20 GB recommended;
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
   downloads the local transcription model, prepares the dashboard, and
   creates `~/Applications/Relationship Inbox OS.app`.

The installer is safe to rerun. It preserves the existing `.env`, `data/`,
and `logs/` while replacing application code.

Release operators can also provide a private one-line download command. Use
only the exact HTTPS command supplied by the pilot operator. Do not substitute
an untrusted download URL.

## First launch and permissions

Open Relationship Inbox OS from Applications or Launchpad. The source-install
launcher starts the local runner and dashboard and opens
`http://localhost:3100`.

Grant only the permissions needed for features you choose:

| Permission | Needed for | When and how |
| --- | --- | --- |
| Full Disk Access | Reading Messages `chat.db` and local Contacts databases | Open System Settings, Privacy & Security, Full Disk Access. Add or enable `~/Applications/Relationship Inbox OS.app`, then quit and reopen the app. macOS does not show an automatic prompt for this permission. |
| Automation for Messages | Sending an iMessage or SMS after you press Send | macOS prompts on the first send. Choose Allow. |
| Accessibility | Sending iMessage file attachments through Messages UI scripting | Grant the launcher or terminal process in System Settings, Privacy & Security, Accessibility only if an attachment send reports that it is required. Text-only sends do not need this UI-scripting path. |
| Microphone | Dictation and recording a voice note | The browser or Electron shell asks after you press the microphone control. |
| Notifications | Optional new-message, update, and digest notifications | Enable explicitly in Settings. A denied permission must be changed in browser or macOS notification settings. |

The current DMG declares a camera usage description, but the verified
dashboard requests audio only and has no current camera capture flow.

## Connect message sources

### iMessage

1. Confirm recent conversations appear in Apple's Messages app.
2. Grant Full Disk Access and restart Relationship Inbox OS.
3. In Settings, run an iMessage scan.
4. On the first user-triggered send, allow Messages automation.

### LinkedIn

The pilot default mirrors the selected normal Chrome profile. Sign into
LinkedIn in Chrome first, then use Connect LinkedIn in Settings. Complete 2FA
or any account verification yourself. The app does not need a stored password
for the normal path.

### WhatsApp

WhatsApp is opt-in and disabled unless the build has
`WHATSAPP_ENABLED=true`. When enabled, Settings displays a QR flow. Scan it
with the linked-device flow in WhatsApp. The runner stores a local session
below the installation's `data/profiles/whatsapp` directory.

Instagram and TikTok adapters are beta and are not part of the primary pilot
setup.

## Configure AI help

The app works as a message inbox without an AI key. Summaries, reply briefs,
classification, and writing help need at least one configured provider key.
See [AI key setup](../pilot/getting-ai-keys.md) for account-specific steps and
[AI routing](../developer/ai.md) for the exact technical behavior.

After editing `.env`, quit and reopen the app. Provider clients and API keys
are read at runner startup.

## Verify the installation

Run the read-only health check:

```bash
cd ~/RelationshipInboxOS
npm run doctor
```

`WARN` can be expected for an intentionally unused integration. Resolve every
`FAIL` for a feature you want to use.

## Start, stop, and reopen

- Start: open Relationship Inbox OS from Applications or Launchpad.
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
