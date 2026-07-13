// Construction of the whatsapp-web.js Client. Wraps the library so the
// adapter only sees a small surface (we destroy + initialize) and so tests
// can stub the factory without dragging Puppeteer in.
//
// Auth strategy: LocalAuth with the runner's whatsapp profile dir. Sessions
// persist across restarts; first connection requires a QR scan from the
// operator's phone (Settings → Linked Devices → Link a Device). The whole
// dir is gitignored under /data/.

// whatsapp-web.js (and its bundled Puppeteer/Chromium) loads LAZILY - only
// when a client is actually constructed, i.e. WHATSAPP_ENABLED is on and the
// operator hits Connect. A top-level import would drag Puppeteer into every
// runner boot and CRASH the runner on startup for anyone who hasn't installed
// the dep, breaking the off-by-default promise (the platform stub must let the
// runner boot with the package absent). createRequire keeps this a synchronous
// factory while deferring the module load. whatsapp-web.js is CommonJS, so
// `require` gives the default export; the named exports (`Client`,
// `LocalAuth`) hang off it. Type-only imports read the .d.ts and are erased.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { Client as ClientType } from "whatsapp-web.js";

const lazyRequire = createRequire(import.meta.url);

export interface WhatsAppClientOptions {
  /** Filesystem root for the LocalAuth session. Must match runnerConfig.profileDirs.WHATSAPP. */
  authDir: string;
  /** Identifier for LocalAuth's internal storage namespace. Single-account so a constant is fine. */
  clientId?: string;
}

export function resolveWindowsChromeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  pathExists: (path: string) => boolean = existsSync
): string | undefined {
  if (platform !== "win32") return undefined;
  const candidates = [
    env.LOCALAPPDATA
      ? win32.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    env.PROGRAMFILES
      ? win32.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")
      : "",
    env["PROGRAMFILES(X86)"]
      ? win32.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")
      : ""
  ].filter(Boolean);
  return candidates.find(pathExists);
}

export function createWhatsAppClient(opts: WhatsAppClientOptions): ClientType {
  const { Client, LocalAuth } = lazyRequire("whatsapp-web.js");
  const executablePath = resolveWindowsChromeExecutable();
  return new Client({
    authStrategy: new LocalAuth({
      clientId: opts.clientId ?? "inbox-os",
      dataPath: opts.authDir
    }),
    // wweb.js spawns its own Puppeteer; the args mirror its docs for
    // headless server use. Packaged Windows builds reuse the Chrome install
    // already required by LinkedIn because Puppeteer's download cache is not
    // part of the installer.
    puppeteer: {
      headless: true,
      ...(executablePath ? { executablePath } : {}),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
      ]
    }
  });
}
