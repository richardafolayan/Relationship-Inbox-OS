import { resolveSelectors } from "@inbox-os/core";
import type { PlatformAdapter, PlatformName, SelectorRegistry } from "@inbox-os/core";
import { resolve, dirname } from "node:path";
import { runnerConfig } from "../config";
import type { SettingsStore } from "../types/runtime";
import { LinkedInAdapter } from "../platforms/linkedin-adapter";
import { BetaAdapter } from "../platforms/beta-adapter";
import { IMessageAdapter } from "../platforms/imessage-adapter";
import { WhatsAppAdapter } from "../platforms/whatsapp-adapter";
import type { SendGuardPrisma } from "../platforms/whatsapp/sendGuard";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "../platforms/browser-launch";
import { createSessionManager } from "./session-manager";

/** WhatsApp connect-state machine (#774), surfaced to the dashboard QR flow. */
export type WhatsAppConnectState = "qr_ready" | "connecting" | "connected" | "disconnected";

/**
 * Lazy-throwing adapter shell used while a platform is in scaffolding.
 * Conforms to PlatformAdapter so the factory's Record stays well-typed and
 * the runner boots, but every operation rejects with a clear error rather
 * than silently doing the wrong thing (e.g. launching Chrome at a stub
 * selector). Replaced with the real adapter as that platform's phase lands.
 */
export function createNotImplementedAdapter(platform: PlatformName): PlatformAdapter {
  const reject = async (op: string): Promise<never> => {
    throw new Error(`${platform} adapter not yet implemented (${op})`);
  };
  return {
    platform,
    ensureConnected: () => reject("ensureConnected"),
    scanUnreadThreads: () => reject("scanUnreadThreads"),
    fetchRecentThreads: () => reject("fetchRecentThreads"),
    fetchThreadMessages: () => reject("fetchThreadMessages"),
    sendMessage: () => reject("sendMessage"),
    openThread: () => reject("openThread"),
    closeSession: () => reject("closeSession")
  };
}

export function createAdapters(input: {
  settingsStore: SettingsStore;
  onConnectStep?: (info: ConnectStepInfo) => Promise<void> | void;
  onPersonalProfileFallback?: (info: PersonalProfileFallbackInfo) => Promise<void> | void;
  /** Prisma client for the WhatsApp send guard (#774). Omit to keep the stub. */
  whatsappPrisma?: SendGuardPrisma;
  /** Fired with the whatsapp-web.js QR string when a scan is needed. */
  onWhatsAppQr?: (qr: string) => void;
  /** WhatsApp connect-state transitions, for the dashboard QR flow. */
  onWhatsAppStateChange?: (state: WhatsAppConnectState) => void;
  /** Fired when whatsapp-web.js reports an inbound message; the runner
   *  debounces it into a WhatsApp scan (real-time inbox flow). */
  onWhatsAppIncomingMessage?: (input: {
    platformThreadId: string;
    sourceChangedAt: string;
  }) => void;
}): {
  // `Partial` because not every PlatformName has an adapter on main today.
  // IMESSAGE was added to PlatformName so prisma can read existing iMessage
  // rows (ingested by a separate line of work); the runner's
  // `requireAdapter` guard (services/index.ts, added in #135 / #140)
  // surfaces a clean "platform not supported" error if anything tries to
  // dispatch on an unsupported platform.
  adapters: Partial<Record<PlatformName, PlatformAdapter>>;
  resolveSelectorsForPlatform: (platform: PlatformName) => Promise<SelectorRegistry>;
  sessionManager: ReturnType<typeof createSessionManager>;
} {
  async function resolveSelectorsForPlatform(platform: PlatformName): Promise<SelectorRegistry> {
    const overrides = await input.settingsStore.getSelectorOverrides();
    return resolveSelectors(platform, runnerConfig.selectorDir, overrides);
  }

  const managedProfileRoot = resolve(dirname(runnerConfig.profileDirs.LINKEDIN), "__managed_person_profiles");
  const sessionManager = createSessionManager({
    profileRootDir: managedProfileRoot,
    browserProfile: runnerConfig.browserProfile,
    getSettings: () => input.settingsStore.getSettings(),
    onConnectStep: input.onConnectStep,
    onPersonalProfileFallback: input.onPersonalProfileFallback
  });

  const adapters: Partial<Record<PlatformName, PlatformAdapter>> = {
    LINKEDIN: new LinkedInAdapter({
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      scanMaxThreads: runnerConfig.linkedInScan.maxThreads,
      scanStableIterations: runnerConfig.linkedInScan.stableIterations,
      scanScrollWaitMs: runnerConfig.linkedInScan.scrollWaitMs,
      messageBackfillAttempts: runnerConfig.linkedInScan.messageBackfillAttempts,
      resolveSelectors: () => resolveSelectorsForPlatform("LINKEDIN"),
      sessionManager,
      // Optional fallback creds. Both must be set AND auto-login must be
      // explicitly opted in via LINKEDIN_AUTO_LOGIN=1 — auto-filling the
      // sign-in form when the persistent session expires can re-trip an
      // automated-activity restriction (see 2026-05-08 incident in README),
      // so the safer default is to surface AUTH_REQUIRED and let the
      // operator log in manually in the controlled Chrome window.
      linkedInCredentials:
        runnerConfig.linkedInAutoLoginEnabled &&
        runnerConfig.linkedInUsername &&
        runnerConfig.linkedInPassword
          ? {
              username: runnerConfig.linkedInUsername,
              password: runnerConfig.linkedInPassword
            }
          : undefined,
      // Personal-mode only: lets the cookie bridge decrypt the live
      // LinkedIn session out of the real Chrome profile and inject it into
      // the launched (mirrored) context, since a Playwright-launched Chrome
      // can't transparently decrypt the Keychain-encrypted profile cookies.
      personalProfile:
        runnerConfig.browserProfile.mode === "personal"
          ? {
              sourceUserDataDir: runnerConfig.browserProfile.personalChromeUserDataDir,
              profileDirectory: runnerConfig.browserProfile.personalChromeProfileDirectory
            }
          : undefined
    }),
    INSTAGRAM: new BetaAdapter({
      platform: "INSTAGRAM",
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      resolveSelectors: () => resolveSelectorsForPlatform("INSTAGRAM"),
      sessionManager
    }),
    TIKTOK: new BetaAdapter({
      platform: "TIKTOK",
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      resolveSelectors: () => resolveSelectorsForPlatform("TIKTOK"),
      sessionManager
    }),
    IMESSAGE: new IMessageAdapter({
      dbPath: runnerConfig.imessage.dbPath,
      contactsVcfPath: runnerConfig.imessage.contactsVcfPath
    }),
    // WhatsApp (#774): the real whatsapp-web.js adapter, but ONLY when the
    // operator has opted in (WHATSAPP_ENABLED=true) AND a prisma client was
    // threaded through for the send guard. Otherwise the not-implemented
    // stub keeps the runner booting cleanly with a clear error on any
    // WhatsApp op - the calm "not connected" state, never a crash.
    WHATSAPP:
      runnerConfig.whatsapp.enabled && input.whatsappPrisma
        ? new WhatsAppAdapter({
            authDir: runnerConfig.profileDirs.WHATSAPP,
            mediaDir: runnerConfig.whatsapp.mediaDir,
            sendGuardConfig: runnerConfig.whatsapp.send,
            prisma: input.whatsappPrisma,
            onQr: input.onWhatsAppQr,
            onStateChange: input.onWhatsAppStateChange,
            onIncomingMessage: input.onWhatsAppIncomingMessage
          })
        : createNotImplementedAdapter("WHATSAPP")
  };

  return {
    adapters,
    resolveSelectorsForPlatform,
    sessionManager
  };
}
