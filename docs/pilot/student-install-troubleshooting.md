# Student Pilot: Install Troubleshooting

The technical fallback page for **install-time** problems. For problems once
the app is running (scans, sending, the inbox UI), see
[troubleshooting.md](./troubleshooting.md).

**First thing to try, always:** run the health check from the app folder
(`~/RelationshipInboxOS`). It diagnoses most of what's below in one go and
tells you the next step.

```bash
cd ~/RelationshipInboxOS
npm run doctor
```

The full installer log is written to
`~/Library/Logs/RelationshipInboxOS/install-*.log`. That's the file to send me
if you're stuck.

---

## "Node version is wrong"

The app is pinned to **Node 22**. Node **26+** is the one that actually
breaks: it has no prebuilt binary for the `better-sqlite3` database library,
so npm tries to compile it from source, which then needs Xcode and Python,
exactly the toolchain the pilot is meant to avoid.

The installer handles this automatically and **needs no admin rights or Mac
password**: if Node isn't 22, it downloads the official Node 22 tarball from
<https://nodejs.org/download/release/latest-v22.x/>, checks its checksum, and
unpacks it into a folder in your home directory (`~/.rios-node`), then adds it
to your PATH. This is why it works on managed / non-admin Macs where you can't
install system software.

After installing, **quit Terminal (⌘ + Q) and reopen it**. A Terminal only
notices the new Node once it's reopened. Check with:

```bash
node -v        # should print v22.x.x
```

If it still shows an old version, another Node (e.g. one from Homebrew or nvm)
is earlier on your `PATH`. The pilot doesn't manage those; the simplest fix is
to use the Terminal session the installer opened, or tell me and we'll sort
your `PATH`.

## "... is not in the sudoers file" / "you need admin rights"

You saw something like `yourname is not in the sudoers file`. That means your
Mac account isn't an administrator, which is common on university or work Macs.
**The current installer doesn't need admin rights at all**; it installs Node
into a folder in your home directory. If you hit this on an older build,
re-download the latest install command/ZIP from me and run it again. No
password needed.

## "Messages is not signed in" / iMessage threads missing

The runner reads `~/Library/Messages/chat.db`. Two things must be true:

1. **You're signed into Messages.** Open the **Messages** app and confirm you
   can see recent conversations.
2. **Tovi has Full Disk Access.** System Settings → Privacy
   & Security → **Full Disk Access** → turn **Tovi** on. If
   it is not listed, click **+** and add
   `~/Applications/Tovi.app`. Then quit and reopen the app,
   because the permission only takes effect on a fresh start.

`node scripts/doctor.mjs` reports the iMessage database as **FAIL** when the
file exists but isn't readable, which is the Full Disk Access case.

LinkedIn works without any of this, so if **only** iMessage is missing, it's
almost always Full Disk Access.

## "LinkedIn login failed"

- Make sure you're **signed into LinkedIn in Chrome** (a normal window, not a
  private/incognito one). The app reuses that session.
- If LinkedIn shows a security check (2FA / captcha), complete it yourself in
  the window the app opened, then press **Start LinkedIn scan** again.
- The app **never** asks for your LinkedIn password. If anything does, stop
  and tell me.
- If LinkedIn keeps asking you to log in again, your session expired. Sign
  back in and rescan. If it happens repeatedly, that's worth reporting.

If you don't use Chrome as your main browser, set `BROWSER_PROFILE_MODE=isolated`
in `.env`; the app then opens its own browser window for you to sign into.

## "Runner is offline" / "Can't reach the runner"

The app has two halves: the dashboard (port 3100) and the runner (port 4001).
"Can't reach the runner" means the runner half isn't up.

1. Check that **Tovi** is running. If in doubt, open it from
   Applications or Launchpad.
2. Run `npm run doctor` (from `~/RelationshipInboxOS`). It pings both ports and
   the runner's `/health` endpoint.
3. Restart the app: quit **Tovi**, then open it again.

If the runner crashes immediately on start, the log
(`~/Library/Logs/RelationshipInboxOS/install-*.log`) has the reason. Send it
to me.

## "Port 3100 or 4001 is already used"

Another copy of the app (or another program) is already on that port.

- Quit any other running copy of Tovi, then start it once.
- Find what's holding a port:

  ```bash
  lsof -i tcp:3100
  lsof -i tcp:4001
  ```

- As a last resort, restart your Mac and start the app once.

You can also run on different ports by setting `DASHBOARD_PORT` and
`RUNNER_PORT` in `.env`, but the defaults (3100/4001) are expected for the
pilot.

## "Not enough disk space"

The installer needs at least **10GB** free (it stops below that) and is
comfortable with **20GB**. Node dependencies, the Chromium download, the npm
cache, and the database all need room. Free up space (empty the Trash, clear
Downloads) and run the command again.

## "Terminal says permission denied"

- If a script won't run, make it executable first, then retry:

  ```bash
  chmod +x scripts/install-student-macos.sh
  bash scripts/install-student-macos.sh
  ```

  (Running it with `bash <script>`, as in the install guide, avoids this
  entirely.)
- If installing Node fails with a permission error, that's the macOS password
  prompt. It needs your Mac login password to install Node system-wide. An
  empty or mistyped password will fail; just run the command again.

## "Inbox is empty after install"

Usually one of:

1. **No scan has run yet.** Press **⌘K**, type `scan`, choose **Run scan
   now**. A first LinkedIn scan can take a minute or two.
2. **iMessage permission** isn't granted; see "Messages is not signed in"
   above. (LinkedIn threads will still appear; iMessage ones won't.)
3. **A stale database path.** This was a real early bug: if `.env` had a
   *relative* `DATABASE_URL` (e.g. `file:./data/inbox-os.sqlite`), the runner
   and the database-setup step could end up on two different files, so your
   scan wrote rows the app never read. The runner now forces an absolute path
   automatically, and the installer writes an absolute `DATABASE_URL` into
   `.env`. If you suspect this, `node scripts/doctor.mjs` shows the exact
   database file it's using, and you can re-run `npm run db:push` then scan
   again.

## "The update check says no feed is set"

On builds 0.1.9 and later this should not happen: the update link ships
inside the app and the start wrapper fills it into `.env` automatically on
launch. If you still see it, you are on an older build that never got the
link. One-time fix: set the link I send you as `RIOS_UPDATE_FEED_URL` in
`.env`, or pass it directly:

```bash
npm run update:student -- --check-only --url "<the latest.json link I sent>"
```

If the check reports that the feed "returned a web page, not JSON", the link
is a normal Dropbox page link. It needs to end in `raw=1` (or `dl=1`). Ask me
for the correct link.

If an update ever fails partway, it rolls back to your previous version
automatically and keeps a backup folder next to the app, so your data is safe.

## "No summaries or reply suggestions appear"

The summaries, action items, and reply help need an AI key, and `node
scripts/doctor.mjs` shows the **AI key** line as a warning until one is set.

- Follow [getting-ai-keys.md](./getting-ai-keys.md) to add a key (the free
  Gemini one is easiest).
- Common gotcha: if you set up a **Gemini** key, also set `AI_PROVIDER=gemini`
  in `.env`. Leaving it as `AI_PROVIDER=openai` makes the app look for an
  OpenAI key it does not have.
- After editing `.env`, restart the app and run a scan again.

## How to uninstall everything

Everything lives in one folder (`~/RelationshipInboxOS`), so removing it removes
the app:

```bash
cd ~/RelationshipInboxOS
bash scripts/uninstall-student-macos.sh          # asks to confirm
bash scripts/uninstall-student-macos.sh --yes    # skip the prompt
```

It will not remove Node, your Messages, your Chrome, or anything online. To
also clear the install logs:

```bash
rm -rf ~/Library/Logs/RelationshipInboxOS
```

---

## For Richard: hosting the one-command link

The installer is dual-mode and needs no hosting to work from an unzipped
folder (`bash scripts/install-student-macos.sh`). To enable the true
one-command `curl | bash` path:

- Host the installer script somewhere private and host the app as a `.zip`.
- Set the app zip URL the installer downloads, either by editing
  `APP_ZIP_URL_DEFAULT` near the top of `scripts/install-student-macos.sh`, or
  by exporting `RIOS_APP_ZIP_URL` in the command you send. Until that's set,
  download mode stops with a plain-English message (it never pretends to
  install from a missing URL).
- Other knobs: `RIOS_INSTALL_DIR` (default `~/RelationshipInboxOS`),
  `RIOS_OPENAI_API_KEY` (pre-fills the key into `.env`), `RIOS_NO_START=1`
  (install without launching).
