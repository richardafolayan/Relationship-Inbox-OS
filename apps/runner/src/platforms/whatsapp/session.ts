// Detect whether whatsapp-web.js has a persisted LocalAuth session on disk.
//
// LocalAuth writes its Chromium user-data under `<authDir>/session-<clientId>`
// (see createWhatsAppClient — dataPath = authDir, clientId defaults to
// "inbox-os"). A non-empty session dir means the operator has linked a device
// at least once and the client can reconnect WITHOUT showing a fresh QR.
//
// Used by the runner's boot-time resume: if a session exists we re-initialise
// the client so a restart doesn't silently drop a linked WhatsApp. This also
// covers the migration case where the account was linked before the platforms
// row existed (the row is the newer "operator uses WhatsApp" signal; the disk
// session is the older ground truth).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CLIENT_ID = "inbox-os";

export function whatsAppSessionDir(authDir: string, clientId = DEFAULT_CLIENT_ID): string {
  return join(authDir, `session-${clientId}`);
}

export function hasPersistedWhatsAppSession(authDir: string, clientId = DEFAULT_CLIENT_ID): boolean {
  const dir = whatsAppSessionDir(authDir, clientId);
  try {
    if (!existsSync(dir)) {
      return false;
    }
    // An empty dir (e.g. a half-written LocalAuth that never completed a scan)
    // is not a usable session — require at least one entry.
    return readdirSync(dir).length > 0;
  } catch {
    // Unreadable path (permissions, race with a concurrent teardown) — treat
    // as no session rather than throwing during boot.
    return false;
  }
}
