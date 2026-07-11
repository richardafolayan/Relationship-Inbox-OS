# Headless mode

This compatibility page preserves an older documentation URL. The canonical
current behavior is in [Platform adapters](developer/platform-adapters.md) and
[Environment variables](developer/configuration.md).

## Current behavior

- LinkedIn and the beta browser adapters use the shared Playwright session
  manager and honor the persisted browser headless setting when a session is
  launched.
- iMessage reads local macOS databases and sends through Messages.app. It needs
  a signed-in graphical macOS session for sending, regardless of the browser
  headless setting.
- WhatsApp uses `whatsapp-web.js` with its own Puppeteer session. Its client is
  currently launched headless and is not controlled by the LinkedIn headless
  toggle.

Changing a browser session setting can require that adapter's session to be
restarted. Do not apply browser-mode advice to iMessage or assume that the
LinkedIn toggle controls WhatsApp.
