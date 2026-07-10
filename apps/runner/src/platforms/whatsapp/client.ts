// Construction of the whatsapp-web.js Client. Wraps the library so the
// adapter only sees a small surface (we destroy + initialize) and so tests
// can stub the factory without dragging Puppeteer in.
//
// Auth strategy: LocalAuth with the runner's whatsapp profile dir. Sessions
// persist across restarts; first connection requires a QR scan from the
// operator's phone (Settings → Linked Devices → Link a Device). The whole
// dir is gitignored under /data/.

// whatsapp-web.js is a CommonJS package — under the runner's ESM build
// the named imports `{ Client, LocalAuth }` resolve to undefined. Pull the
// default export and destructure the constructors off it instead. Type-only
// imports still work because TypeScript reads the .d.ts directly.
import wweb from "whatsapp-web.js";
import type { Client as ClientType } from "whatsapp-web.js";
const { Client, LocalAuth } = wweb;

export interface WhatsAppClientOptions {
  /** Filesystem root for the LocalAuth session. Must match runnerConfig.profileDirs.WHATSAPP. */
  authDir: string;
  /** Identifier for LocalAuth's internal storage namespace. Single-account so a constant is fine. */
  clientId?: string;
}

export function createWhatsAppClient(opts: WhatsAppClientOptions): ClientType {
  return new Client({
    authStrategy: new LocalAuth({
      clientId: opts.clientId ?? "inbox-os",
      dataPath: opts.authDir
    }),
    // wweb.js spawns its own Puppeteer; the args mirror its docs for
    // headless server use. Kept conservative — we don't pass a custom
    // executablePath because the bundled Chromium is what wweb.js tests
    // against.
    //
    // protocolTimeout: the default (30s) is too short for getChats() on
    // accounts with hundreds of chats — wweb.js evaluates a single
    // page.evaluate that loads every chat, and Puppeteer's CDP call
    // exceeds 30s on busy accounts. Bumping to 180s keeps the happy
    // path snappy (sub-second response on small accounts) while letting
    // big-history accounts complete their first scan.
    puppeteer: {
      headless: true,
      protocolTimeout: 180_000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    }
  });
}
