# Student Pilot: Install Guide

This is the setup guide for the Relationship Inbox OS student pilot. It is
written to be followed **on a short call with me**. You do not need to be
technical, and you do **not** need git, a GitHub account, or any coding
experience. If a step looks confusing, stop there and we will do it together.

The app runs entirely on your own Mac. Nothing is uploaded to a server.

## What you need

- A **MacBook**. The first pilot is Mac-only: iMessage support is
  macOS-only, and I want to keep the first round simple.
- **Google Chrome**, and you signed into LinkedIn in it as normal. (Don't
  have Chrome? Get it free from [google.com/chrome](https://www.google.com/chrome/).)
- **The Messages app on your Mac, signed in**, so your iMessages can be
  included. If you have ever sent an iMessage from this Mac, you are set.
- About 20 minutes, and me on a call with you.

You do **not** need a GitHub account or any developer tools. I will send you
the code as a normal download, and an AI key to paste into one file. You do
not need your own.

## Step 1: Get the code

I will send you the project as a single **ZIP file**, by AirDrop, email, or a
download link. There is no git and no GitHub account involved.

1. Save the ZIP. It normally lands in your **Downloads** folder.
2. **Double-click the ZIP** to unzip it. You will get a folder called
   `relationship-inbox-os` (the name may have some extra text on the end,
   that is fine).

Leave that folder in Downloads, that is perfectly OK. Just remember where it
is, you will point the Terminal at it in Step 3.

## Step 2: Install Node.js (one time)

The app needs a small, free tool called **Node.js** to run. You install it
once, by clicking through an installer, no typing.

1. Go to [nodejs.org](https://nodejs.org).
2. Download the macOS version labelled **LTS** (the recommended one).
3. Open the file you downloaded (it ends in `.pkg`) and click
   **Continue → Agree → Install**. Enter your Mac password if it asks.
4. When it says the install succeeded, you are done. Nothing new opens on
   screen, that is normal.

## Step 3: Open Terminal and go to the project folder

The next steps use the **Terminal** app. It is a plain, text-only window,
that is normal, not a sign anything is wrong.

1. Open it: press **⌘ + Space**, type `Terminal`, and press **Enter**.
2. In the Terminal window type `cd` followed by a space (the letters c, d,
   then a space). **Do not press Enter yet.**
3. Open **Finder**, find your unzipped `relationship-inbox-os` folder, and
   **drag it onto the Terminal window**. The folder's location fills itself
   in for you.
4. Now press **Enter**. You are now "inside" the project folder.

If you ever close Terminal and need to come back, just repeat this step to
get back into the folder.

## Step 4: Install it

First, install the app and its tools. Run these two commands one at a time,
and **wait for each to completely finish** (the prompt comes back and the
text stops scrolling) before running the next. The first one is the big one
and takes a few minutes.

```bash
npm install --include=dev
npx playwright install
```

The `--include=dev` part makes sure the small database tool the next steps
need is installed, even if your Mac is set up to skip it.

Now check the install worked. Run:

```bash
npx --no-install prisma --version
```

You should see a few lines of version numbers, starting with
`prisma : 6.x.x`. If instead you see `command not found` or `could not
determine an executable to run`, the install did not finish: run
`npm install --include=dev` again, let it complete, and check once more
before carrying on.

Once that check passes, set up the local database:

```bash
npm run db:generate
npm run db:push
```

If a command prints a wall of text and ends without the word `error`, it
worked.

## Step 5: Create your settings file

In the project folder there is a file called `.env.example`. Make a copy of
it named `.env`:

```bash
cp .env.example .env
```

Then open `.env` in a text editor. You only need to touch two things, I
will give you both on the call:

- `OPENAI_API_KEY=`: paste the key I send you after the `=`.
- `BROWSER_PROFILE_MODE=personal`: leave this as `personal` (see
  [Browser modes](#browser-modes) below).

Leave everything else as it is. We will fill in the Chrome profile details
together on the call. They depend on your Mac.

## Step 6: Turn on iMessage (Mac)

This is what makes your iMessage conversations show up next to LinkedIn. It is
already switched on in your settings file; it just needs one macOS permission.

1. **Be signed into Messages.** Open the **Messages** app on your Mac once and
   check you can see your conversations. The app only ever reads your Mac's own
   Messages, it never logs in anywhere.
2. **Give Terminal Full Disk Access.** Open **System Settings → Privacy &
   Security → Full Disk Access**, find **Terminal** in the list, and turn its
   switch **on**. If Terminal is not in the list, click **+** and add it from
   Applications → Utilities.
3. macOS will say Terminal must quit to use the new permission. **Quit
   Terminal** (⌘ + Q), reopen it, and go back into the project folder the same
   way as Step 3 (type `cd `, drag the folder onto the window, press Enter).

Your iMessages then appear after the first scan (Step 9). The first time you
send an iMessage reply, macOS asks "Terminal wants to control Messages",
click **Allow**.

## Step 7: Start the app

```bash
npm run dev
```

Leave that Terminal window open. It keeps the app running. When it settles,
open **Chrome** and go to:

```
http://localhost:3100
```

## Step 8: Set up your reply style

The first time you open it, the **Today** page shows a short welcome card
and a "Set up your reply style" card. Fill the reply-style card in: your
name and a sentence on how you usually message people. This is what makes
the app support *your* words rather than sounding generic. It takes a minute
and you can change it later in Settings.

## Step 9: Pull in your messages

The app reads your messages in the background. To pull them in the first
time, press **⌘K** to open the command bar, type `scan`, and choose
**Run scan now**. Your conversations appear on **Today** and **Inbox**.

Both your LinkedIn and iMessage conversations show up here. If iMessage threads
are missing, it is almost always Full Disk Access (Step 6) not being granted
yet, see [troubleshooting.md](./troubleshooting.md).

That is the whole setup. From here, see
[student-pilot-instructions.md](./student-pilot-instructions.md) for what to
actually test, and [troubleshooting.md](./troubleshooting.md) if something
looks stuck.

## If a command says "command not found: npm"

That means the Node.js install in Step 2 has not been picked up yet. It is an
easy fix:

1. Make sure Step 2 actually finished (the installer said it succeeded).
2. Fully quit Terminal: press **⌘ + Q** in the Terminal window.
3. Reopen Terminal and redo **Step 3** (the drag-the-folder step) to get back
   into the project folder.
4. Try the command again.

A freshly opened Terminal only notices Node.js after Node.js is installed, so
quitting and reopening it is what does the trick.

## If a command says "command not found: prisma"

This means the small database tool did not get installed, usually because
`npm install` was interrupted or did not fully finish. To fix it:

1. Run `npm install --include=dev` again.
2. **Wait for it to completely finish.** The Terminal prompt comes back and
   the text stops scrolling. This can take a few minutes, that is normal.
3. Check it with `npx --no-install prisma --version`. You should see a few
   lines of version numbers.
4. Then run `npm run db:generate` and `npm run db:push` again.

## Browser modes

The app needs a browser session to read LinkedIn. There are two modes, set
by `BROWSER_PROFILE_MODE` in your `.env` file.

- **`personal` (use this for the pilot).** The app reuses your real Chrome
  profile, so it sees the LinkedIn you are already signed into. Nothing new
  to log into. This is the gentlest option for LinkedIn: a normal,
  signed-in Chrome looks far less unusual than a fresh automated browser.
- **`isolated` (fallback only).** The app opens its own separate browser
  window and you sign into LinkedIn inside that one. Use this **only** if
  personal Chrome mode cannot be set up, for example if you do not use
  Chrome as your main browser.

Two more things, both already set for you:

- **Keep the headless browser off.** There is a toggle in Settings, leave
  it off. A visible browser (it runs quietly offscreen) looks more like a
  real person than a hidden one.
- **Chrome is preferred** for this pilot. If you mainly use Safari or
  Firefox, tell me, we will use `isolated` mode and you will sign into
  LinkedIn in the app's own window.

## A note on Windows

The app can technically run on Windows, but the first pilot is **Mac-only**
on purpose: iMessage is macOS-only, and I want a small, consistent first
round. If you only have a Windows PC, let me know and we will sort something
out. Just do not treat Windows as the normal pilot path yet.
