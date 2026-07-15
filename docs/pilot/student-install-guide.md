# Install Tovi on your Mac

> The maintained installation procedure is [Install on macOS](../user/install.md).
> This pilot page is retained for call-specific facilitation notes.
> Windows pilots should use [Windows pilot install](./windows-install.md).

This guide is for student pilots. **You do not need to know how to code.**

You paste one command into Terminal. It checks your Mac, installs anything
that's missing, downloads the app, sets it up, and opens it in your browser.
Then the app asks which message sources and optional features you want.

The app runs entirely on your own Mac. Nothing is uploaded to a server.

## You will need

- A **Mac** (a MacBook is fine). This page covers the Mac pilot. Windows
  pilots use Google Messages with an Android phone instead of iMessage.
- **Messages working on your Mac.** If you've ever sent an iMessage from this
  Mac, you're set.
- A **LinkedIn account**, if you want to test LinkedIn.
- **At least 4GB free space** (8GB is comfortable).
- **Stable Wi-Fi.**
- About **20 to 30 minutes** for the first setup, mostly waiting and clicking
  "Allow".

## You do **not** need

- GitHub or a GitHub account
- git
- Python
- Xcode
- Homebrew
- nvm
- Any coding experience

If you have none of these, that's exactly right. The installer brings its own.

---

## Step 1: Run the install command

I'll send you the install command privately. There are two shapes it can
take, and I'll tell you which one you've got.

### A) A one-line command

If I send you a command that looks like this, open **Terminal** (press
**⌘ + Space**, type `Terminal`, press **Enter**), paste the whole line, and
press **Enter**:

```bash
/bin/bash -c "$(curl -fsSL <the link I send you>)"
```

That's it. Skip to [Step 2](#step-2-follow-the-permission-prompts).

### B) A ZIP file

If I instead send you the app as a **ZIP** (by AirDrop, email, or a download
link):

1. **Double-click the ZIP** to unzip it. You'll get a folder called
   `relationship-inbox-os` (extra text on the end is fine). Unzip it
   anywhere. **Downloads is fine.** This folder is only the source: the
   installer copies the app to one permanent home at **`~/RelationshipInboxOS`**
   and runs it from there, so you can delete the unzipped folder afterwards.
2. Open **Terminal** (⌘ + Space, type `Terminal`, Enter).
3. Type `bash ` (the word `bash` and a space, don't press Enter yet).
4. Open **Finder**, go inside the unzipped folder to **scripts**, and drag
   **install-student-macos.sh** onto the Terminal window. It fills in the
   path for you.
5. Press **Enter**.

Either way, the installer takes over from here. While it runs it will:

- check your Mac and free space,
- install **Node 22** if it's missing, into a folder in your home directory,
  so **no admin rights or Mac password are needed** (it works on a managed or
  non-admin Mac too),
- install the app into **`~/RelationshipInboxOS`** and set up what it needs,
- create **Tovi.app** in your Applications folder,
- set up your local database,
- leave voice transcription off until you explicitly choose a local model,
- start the app and open it at **http://localhost:3100**.

The long part is "Installing the app", which takes a few minutes. It is normal
for Terminal to sit quietly while it works.

Once the browser opens, you can close Terminal. To start the app again later,
open **Tovi** from Applications or Launchpad.

If the app icon was not created for some reason, the Terminal fallback is:

```bash
cd ~/RelationshipInboxOS
npm run start:student
```

---

## Step 2: Follow the permission prompts

Once the app opens in your browser, it guides you through the rest:

1. Press **Start setup** on the welcome screen.
2. Add your name, then choose iMessage, LinkedIn, WhatsApp, or none.
3. Follow the connection card for each source you chose.
4. Check that Contacts are available if you chose iMessage.
5. Choose whether to use optional Gemini AI help.
6. Leave voice transcription off, or download Standard (about 150 MB) or
   Enhanced (about 500 MB).
7. Review the green checks, then press **Go to Today**. You can also open safe
   demo conversations first.

To change anything later, open **Settings > Setup**. Optional components can
be turned off and downloaded transcription models can be removed there.

### Connect iMessage

Tovi reads the messages already stored on your Mac. It never
logs into anything and never sends anything on its own.

1. Open **Messages** on your Mac and check you can see recent conversations.
2. In Tovi's setup assistant, press **Open Full Disk Access**.
3. In the Mac window that opens, find **Tovi** and turn it
   **on**. If it is not listed, press **+** and add
   `~/Applications/Tovi.app`.
4. macOS may say the app must quit to use the new permission. Quit
   **Tovi**, then open it again.
5. Return to the setup assistant and press **Scan iMessage**.
6. The first time you *send* an iMessage reply, macOS asks "Tovi wants to
   control Messages". Click **Allow**.

What it does: reads your local iMessage/SMS history, summarises it, and shows
what needs a reply. What it doesn't do: send anything unless you press send.

### Connect LinkedIn

Tovi uses a normal, signed-in Chrome. **It never asks for or
stores your LinkedIn password.**

1. Sign into LinkedIn in your normal Google Chrome window.
2. In Tovi's setup assistant, press **Connect LinkedIn**.
3. Log into LinkedIn yourself if the window asks you to.
4. Complete any security check (2FA) if LinkedIn asks.
5. Come back to Tovi. The setup assistant changes to **Connected** when it is
   ready.

You only log in once; it remembers the session.

### Add an AI key (for summaries and reply help)

The setup assistant explains how to create and paste a free Google Gemini key.
It checks and saves the key for you, with no file editing, Terminal command, or
restart. The full click-by-click steps are in
[getting-ai-keys.md](./getting-ai-keys.md).

Without a key, the app still shows your conversations but cannot create
summaries or writing help. When those features run, the relevant conversation
text is sent to Google's Gemini service for processing. Your key stays on this
Mac. Tovi never sends a reply to another person unless you press send.

### Set up your reply style

The first time you open the app, the **Today** page has a "Set up your reply
style" card. Fill it in (your name and a sentence on how you usually message
people). This is what makes the app support *your* words instead of sounding
generic. You can change it later in Settings.

---

## If something looks wrong

Run the built-in health check from the app folder:

```bash
cd ~/RelationshipInboxOS
npm run doctor
```

It prints a plain-English **PASS / WARN / FAIL** for each part of the setup
and tells you the exact next step for anything that failed.

For specific problems ("inbox is empty", "can't reach the runner", "Node
version is wrong", and so on), see
[student-install-troubleshooting.md](./student-install-troubleshooting.md).

When you're up and running, [student-pilot-instructions.md](./student-pilot-instructions.md)
covers what to actually test.

---

## Updating

When I publish a new build, your app can update itself. Updates work out of
the box: the update link ships inside the app (builds 0.1.9 and later), so
there is nothing to configure.

The easy way is in the app itself: **Settings > App updates > Check for
updates**, then **Update and relaunch** if one is available. It stages the
update; quit Tovi and open it again to finish.

The same thing from the Terminal, in the app folder
(`cd ~/RelationshipInboxOS`):

```bash
npm run update:student -- --check-only   # is there a new version?
npm run update:student -- --apply        # download and install it
```

An update only replaces the app's code. It keeps your settings (`.env`), your
local database, your conversations, and your sign-ins. It also makes a backup
first and rolls back automatically if anything goes wrong, so it is safe to
run.

If the app says "Updates aren't set up yet", you are on a build older than
0.1.9 that never got the update link. One-time fix: ask me for the update
link and put it in your `.env` as `RIOS_UPDATE_FEED_URL` (or pass it with
`--url`). Every later update then carries the link automatically.

## Uninstall

Everything the app knows lives in one folder, so removing it removes the app:

```bash
bash scripts/uninstall-student-macos.sh
```

It asks you to confirm, then deletes the app and its local data. It does
**not** touch Node, your Messages, your Chrome, or your LinkedIn account.

---

## Privacy

- **Nothing sends automatically.** The app never replies for you.
- **Your messages stay on your Mac.** There's no server and no tracking.
- **AI help is optional.** You can ignore it entirely.
- **Feedback and bug reports never include your message content**, only what
  you choose to type. A screenshot you attach may show private messages, so
  check before sending; the app asks you to confirm.
- **Don't connect any account you're uncomfortable testing** with an early
  build.
