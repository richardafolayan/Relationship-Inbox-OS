# Student Pilot: Troubleshooting

> Use the [technical troubleshooting playbook](../troubleshooting/playbook.md)
> when the quick pilot checks here do not resolve the symptom.

Quick fixes for the common snags while **using** the app. For **install-time**
problems (Node version, ports, "inbox empty after install", uninstall), see
[student-install-troubleshooting.md](./student-install-troubleshooting.md), or
just run `npm run doctor` from `~/RelationshipInboxOS` for a plain-English
health check.

None of this is your fault. It is an early build, and a thing not working *is*
useful pilot feedback. If a fix here does not sort it, open a bug from the
**Feedback** button in the sidebar (it walks you through it) or message me.

## The app keeps the Terminal window busy

Older installs kept Terminal busy while the app was running. Current installs
create **Tovi.app** in Applications, so you can open the app
from Applications or Launchpad and close Terminal once the browser is open.

If the app icon was not created, use the Terminal fallback:
`cd ~/RelationshipInboxOS && npm run start:student`.

## The page says "Can't reach the runner"

The app has two halves and one of them is not up. Almost always: Relationship
Tovi is not running, or it crashed during startup.

1. Open **Tovi** from Applications or Launchpad.
2. Wait for it to settle, then reload `http://localhost:3100`.

## A scan finished but no messages showed up

- Give it a moment. A first LinkedIn scan can take a minute or two.
- Make sure you are **signed into LinkedIn in Chrome** (the normal Chrome
  window, not a private one).
- Press **⌘K**, type `scan`, and run **Full LinkedIn rescan** once.
- iMessage threads need Full Disk Access for Tovi (see "My iMessage
  conversations don't show up" below).

## My iMessage conversations don't show up

iMessage needs one macOS permission that LinkedIn does not. Check these, in
order:

1. **Full Disk Access.** Tovi must have it.
   Open **System Settings → Privacy & Security → Full Disk Access** and make
   sure **Tovi** is switched on. If it is not listed, click
   **+** and add `~/Applications/Tovi.app`.
2. **Restart the app after granting it.** The permission only takes effect on
   a fresh start: quit Tovi, then open it again.
3. **Be signed into Messages.** Open the **Messages** app once and confirm you
   can see your chats.
4. **Run a scan.** Press **⌘K**, type `scan`, choose **Run scan now**.

LinkedIn works without any of this, so if only iMessage is missing, it is
almost always step 1.

## LinkedIn wants me to log in again

Your LinkedIn session expired. Open Chrome, sign back into LinkedIn as you
normally would, then run a scan again (**⌘K → Run scan now**).

If it keeps happening, tell me. That is worth knowing.

## "Port already in use"

Another copy of the app is still running. Quit any other running copy of
Tovi, then start it once more. If it persists, restart your
Mac and try again.

## macOS asked for permission

Two different macOS permissions are involved with iMessage, and both are
expected:

- **Full Disk Access** lets the app *read* your iMessages. You grant this
  yourself in System Settings (see "My iMessage conversations don't show up"
  above).
- **"Tovi wants to control Messages"** appears the first time
  you *send* an iMessage reply. Click **Allow**. If you dismissed it by
  accident, sending will fail, tell me and we will re-trigger it.

You can decline both and LinkedIn still works fine on its own.

## A conversation won't open ("Can't open this thread")

That thread could not be loaded. Use the **Back to Today** link on that
screen and carry on. If a specific person's thread never opens, that is a
bug worth reporting.

## I want to start completely fresh

1. Quit Tovi.
2. Open it again from Applications or Launchpad.

That is usually enough. A full data reset is a bigger step, ask me first
rather than doing it yourself.

## The "Platforms" page

There is an advanced page at `http://localhost:3100/platforms` for checking
the LinkedIn / iMessage connection. It is **not** part of the normal flow
and is deliberately kept out of the sidebar. You should not need it for the
pilot. If a scan misbehaves and I ask you to, you can open that address
directly. Otherwise, ignore it.

## How to tell me something is wrong

Use the **Feedback** button at the bottom of the sidebar (on every page),
or the buttons in the **Pilot** section of **Settings**:

- **Report a bug**: for something broken.
- **Share feedback**: for how it felt to use.

Fill in the short form and press **Submit report**. You will get a
confirmation with a report number. If submitting fails, your text stays in
the form, so use the **Copy report** button and send it to me directly.
Reports never include your message content.
