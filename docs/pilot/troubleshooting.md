# Student Pilot — Troubleshooting

Quick fixes for the common snags. None of this is your fault — it is an
early build, and a thing not working *is* useful pilot feedback. If a fix
here does not sort it, open a bug from the **Feedback** button in the
sidebar (it walks you through it) or message me.

## The app keeps the Terminal window busy

That is normal. The Terminal window running `npm run dev` has to stay open
the whole time you are using the app. To stop the app, click that window
and press `Ctrl + C`. To start it again, run `npm run dev`.

## The page says "Can't reach the runner"

The app has two halves and one of them is not up. Almost always: the
Terminal running `npm run dev` was closed or crashed.

1. Open Terminal, `cd` into the project folder, run `npm run dev` again.
2. Wait for it to settle, then reload `http://localhost:3100`.

## A scan finished but no messages showed up

- Give it a moment — a first LinkedIn scan can take a minute or two.
- Make sure you are **signed into LinkedIn in Chrome** (the normal Chrome
  window, not a private one).
- Press **⌘K**, type `scan`, and run **Full LinkedIn rescan** once.
- iMessage messages only appear on a Mac, and only after you have allowed
  the macOS permission prompt.

## LinkedIn wants me to log in again

Your LinkedIn session expired. Open Chrome, sign back into LinkedIn as you
normally would, then run a scan again (**⌘K → Run scan now**).

If it keeps happening, tell me — that is worth knowing.

## "Port already in use"

Another copy of the app is still running. Close any other Terminal windows
running `npm run dev`, then start it once more. If it persists, restart your
Mac and try again.

## macOS asked for permission

The first time the app reads iMessage, macOS may ask to allow access to your
Messages. Allowing it lets the app show your iMessage threads. If you would
rather not, decline — LinkedIn still works fine on its own.

## A conversation won't open ("Can't open this thread")

That thread could not be loaded. Use the **Back to Today** link on that
screen and carry on. If a specific person's thread never opens, that is a
bug worth reporting.

## I want to start completely fresh

1. Stop the app (`Ctrl + C` in the Terminal).
2. Start it again: `npm run dev`.

That is usually enough. A full data reset is a bigger step — ask me first
rather than doing it yourself.

## The "Platforms" page

There is an advanced page at `http://localhost:3100/platforms` for checking
the LinkedIn / iMessage connection. It is **not** part of the normal flow
and is deliberately kept out of the sidebar — you should not need it for the
pilot. If a scan misbehaves and I ask you to, you can open that address
directly. Otherwise, ignore it.

## How to tell me something is wrong

Use the **Feedback** button at the bottom of the sidebar (on every page):

- **Report a bug** — for something broken.
- **Share feedback** — for how it felt to use.

Either one lets you **Open a GitHub issue** (it pre-fills a form you review
and submit yourself — nothing is sent automatically), or **Copy** the notes
to send me directly if you would rather not use GitHub. It never includes
your message content.
