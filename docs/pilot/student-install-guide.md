# Install Relationship Inbox OS on your Mac

This guide is for student pilots. **You do not need to know how to code.**

You paste one command into Terminal. It checks your Mac, installs anything
that's missing, downloads the app, sets it up, and opens it in your browser.
Then the app walks you through connecting iMessage and LinkedIn.

The app runs entirely on your own Mac. Nothing is uploaded to a server.

## You will need

- A **Mac** (a MacBook is fine). iMessage doesn't work on Windows, so the
  pilot is Mac-only.
- **Messages working on your Mac.** If you've ever sent an iMessage from this
  Mac, you're set.
- A **LinkedIn account**, if you want to test LinkedIn.
- **At least 10GB free space** (20GB is comfortable).
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
- install **Node 22** if it's missing (it may ask for your Mac password, the
  one you use to unlock your Mac),
- install the app into **`~/RelationshipInboxOS`** and set up what it needs,
- set up your local database,
- download a small voice-transcription model (about 150 MB) so voice notes
  transcribe automatically,
- start the app and open it at **http://localhost:3100**.

The long part is "Installing the app", which takes a few minutes. It's normal
for the Terminal to sit quietly while it works.

> **Keep this Terminal window open.** It's what keeps the app running. To stop
> the app, click the window and press **Ctrl + C**. To start it again later:
>
> ```bash
> cd ~/RelationshipInboxOS
> npm run start:student
> ```

---

## Step 2: Follow the permission prompts

Once the app opens in your browser, it guides you through the rest:

1. **iMessage access**: a one-time macOS permission (see below).
2. **Connecting LinkedIn**: you log in yourself.
3. **Your first scan**: pulls your conversations in.
4. **Your inbox**: opens once the scan finishes.

### Connect iMessage

Relationship Inbox OS reads the messages already stored on your Mac. It never
logs into anything and never sends anything on its own.

1. Open **Messages** on your Mac and check you can see recent conversations.
2. Give **Terminal Full Disk Access** so the app can read your local message
   history: **System Settings → Privacy & Security → Full Disk Access**, find
   **Terminal**, and turn it **on**. (If Terminal isn't listed, click **+**
   and add it from Applications → Utilities.)
3. macOS will say Terminal must quit to use the new permission. **Quit
   Terminal** (⌘ + Q), then start the app again.
4. The first time you *send* an iMessage reply, macOS asks "Terminal wants to
   control Messages". Click **Allow**.

What it does: reads your local iMessage/SMS history, summarises it, and shows
what needs a reply. What it doesn't do: send anything unless you press send.

### Connect LinkedIn

Relationship Inbox OS uses a normal, signed-in Chrome. **It never asks for or
stores your LinkedIn password.**

1. In the app, click **Connect LinkedIn**.
2. Log into LinkedIn yourself, the normal way.
3. Complete any security check (2FA) if LinkedIn asks.
4. Come back to Relationship Inbox OS and press **Start LinkedIn scan**.

You only log in once; it remembers the session.

### Add an AI key (for summaries and reply help)

The summaries, action items, and reply suggestions are written by an AI model,
which needs a key (yours, kept private on your Mac). The free Google Gemini key
is the easiest. It takes a few minutes and the steps are in
[getting-ai-keys.md](./getting-ai-keys.md). Without a key the app still shows
your conversations, but without the summaries and reply help.

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

When I publish a new build, your app can update itself. From the app folder
(`cd ~/RelationshipInboxOS`):

```bash
npm run update:student -- --check-only   # is there a new version?
npm run update:student -- --apply        # download and install it
```

An update only replaces the app's code. It keeps your settings (`.env`), your
local database, your conversations, and your sign-ins. It also makes a backup
first and rolls back automatically if anything goes wrong, so it is safe to
run. I will send you a one update link to put in your `.env` as
`RIOS_UPDATE_FEED_URL` (or you can pass it with `--url`).

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
