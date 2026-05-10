// Construction of the whatsapp-web.js Client. Wraps the library so the
// adapter only sees a small surface (we destroy + initialize) and so tests
// can stub the factory without dragging Puppeteer in.
//
// Auth strategy: LocalAuth with the runner's whatsapp profile dir. Sessions
// persist across restarts; first connection requires a QR scan from the
// operator's phone (Settings → Linked Devices → Link a Device). The whole
// dir is gitignored under /data/.

import { Client, LocalAuth } from "whatsapp-web.js";

export interface WhatsAppClientOptions {
  /** Filesystem root for the LocalAuth session. Must match runnerConfig.profileDirs.WHATSAPP. */
  authDir: string;
  /** Identifier for LocalAuth's internal storage namespace. Single-account so a constant is fine. */
  clientId?: string;
}

export function createWhatsAppClient(opts: WhatsAppClientOptions): Client {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: opts.clientId ?? "inbox-os",
      dataPath: opts.authDir
    }),
    // wweb.js spawns its own Puppeteer; the args mirror its docs for
    // headless server use. Kept conservative — we don't pass a custom
    // executablePath because the bundled Chromium is what wweb.js tests
    // against.
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    }
  });
}
