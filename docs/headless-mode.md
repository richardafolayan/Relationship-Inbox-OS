# Headless mode

Per-platform support and current status.

## LinkedIn (Playwright) - SUPPORTED

Toggle in Settings -> "Headless browser". The setting is read on session
launch in [session-manager.ts](../apps/runner/src/services/session-manager.ts)
and passed to `chromium.launchPersistentContext` via
[browser-launch.ts](../apps/runner/src/platforms/browser-launch.ts).

Caveats:
- Personal-profile mirror mode (BROWSER_PROFILE_MODE=personal) and
  isolated mode both honour the flag.
- Playwright's headless Chromium is fingerprintable and LinkedIn may
  show extra friction (more frequent auth checks). The auth-recovery
  path handles this automatically; expect occasional sign-in prompts.
- Toggling the flag tears down and relaunches the persistent context,
  so any in-flight scan is interrupted.

## iMessage (osascript / Messages.app) - BLOCKED

Cannot run headless. Reasons:
- Messages.app is a macOS GUI application; it requires the user to be
  signed into a graphical session.
- The send path in
  [imessage-send.ts](../apps/runner/src/platforms/imessage-send.ts) drives
  Messages.app via AppleScript. Many of the AppleScript verbs require
  the app to be frontmost (or at least visible) at the moment of
  execution. The accessibility-permission flow that sends file
  attachments uses UI scripting that posts keystrokes into the app
  window, which fails outright if the app is not on screen.
- Reading is via SQLite (`chat.db`), which works without the GUI - but
  there is no read-only mode for the runner; it always exposes both
  read and send.

A "send-disabled, read-only" headless mode is theoretically possible but
not on the v0.x roadmap. For server deployment, the current shape needs
a logged-in macOS session; either run on a Mac mini left signed in, or
plan a separate sender service that runs against a graphical session and
takes RPC calls from a headless reader.

## WhatsApp (Phase B foundation)

Web-based via Playwright; same toggle as LinkedIn will apply once the
adapter lands.
