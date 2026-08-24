import { resolveSelectors } from "@inbox-os/core";
import type { PlatformAdapter, PlatformName, SelectorRegistry } from "@inbox-os/core";
import { basename, resolve, dirname } from "node:path";
import { resolveConnectTimeoutMs, runnerConfig } from "../config";
import type { BrowserProfileConfig } from "../config";
import type { PlatformAvailability } from "../platform-availability";
import type { SettingsStore } from "../types/runtime";
import { LinkedInAdapter } from "../platforms/linkedin-adapter";
import { InstagramAdapter } from "../platforms/instagram-adapter";
import { IMessageAdapter } from "../platforms/imessage-adapter";
import { WhatsAppAdapter } from "../platforms/whatsapp-adapter";
import { GoogleMessagesAdapter } from "../platforms/google-messages-adapter";
import type { SendGuardPrisma } from "../platforms/whatsapp/sendGuard";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "../platforms/browser-launch";
import { createSessionManager } from "./session-manager";

/** WhatsApp connect-state machine (#774), surfaced to the dashboard QR flow. */
export type WhatsAppConnectState = "qr_ready" | "connecting" | "connected" | "disconnected";

export interface PlatformSessionRoute {
  sessionManager: ReturnType<typeof createSessionManager>;
  personKey: string;
  profileDir: string;
}

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
    collectionBoundary: {
      beginCycle: () => undefined,
      getMetrics: () => ({
        totalFound: 0,
        unreadFound: 0,
        completeness: "incomplete",
        nativeStopReason: "adapter_not_implemented"
      })
    },
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
  platformAvailability?: PlatformAvailability;
  instagramBrowserProfile?: BrowserProfileConfig;
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
  resolvePlatformSession: (platform: PlatformName) => PlatformSessionRoute;
} {
  async function resolveSelectorsForPlatform(platform: PlatformName): Promise<SelectorRegistry> {
    const overrides = await input.settingsStore.getSelectorOverrides();
    return resolveSelectors(platform, runnerConfig.selectorDir, overrides);
  }

  const availability = input.platformAvailability ?? runnerConfig.platformAvailability;
  const instagramBrowserProfile = input.instagramBrowserProfile ?? runnerConfig.browserProfile;
  const managedProfileRoot = resolve(dirname(runnerConfig.profileDirs.LINKEDIN), "__managed_person_profiles");
  const sessionManager = createSessionManager({
    profileRootDir: managedProfileRoot,
    browserProfile: runnerConfig.browserProfile,
    getSettings: () => input.settingsStore.getSettings(),
    onConnectStep: input.onConnectStep,
    onPersonalProfileFallback: input.onPersonalProfileFallback
  });
  const instagramPersonKey = basename(runnerConfig.profileDirs.INSTAGRAM);
  const instagramSessionManager = createSessionManager({
    profileRootDir: dirname(runnerConfig.profileDirs.INSTAGRAM),
    browserProfile: {
      ...instagramBrowserProfile,
      personalProfileSyncMode:
        instagramBrowserProfile.mode === "personal"
          ? "once"
          : instagramBrowserProfile.personalProfileSyncMode,
      fallbackBehavior: "error"
    },
    preferInstalledChrome: true,
    getSettings: () => input.settingsStore.getSettings(),
    onConnectStep: input.onConnectStep,
    onPersonalProfileFallback: input.onPersonalProfileFallback
  });

  function resolvePlatformSession(platform: PlatformName): PlatformSessionRoute {
    const manager = platform === "INSTAGRAM" ? instagramSessionManager : sessionManager;
    const personKey = platform === "INSTAGRAM" ? instagramPersonKey : "default";
    return {
      sessionManager: manager,
      personKey,
      profileDir: manager.getProfileDir(personKey)
    };
  }

  const adapters: Partial<Record<PlatformName, PlatformAdapter>> = {};

  if (availability.LINKEDIN) {
    adapters.LINKEDIN = new LinkedInAdapter({
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
    });
  }

  if (availability.INSTAGRAM) {
    const route = resolvePlatformSession("INSTAGRAM");
    adapters.INSTAGRAM = new InstagramAdapter({
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      resolveSelectors: () => resolveSelectorsForPlatform("INSTAGRAM"),
      sessionManager: route.sessionManager,
      personKey: route.personKey,
      connectTimeoutMs: resolveConnectTimeoutMs("personal"),
      personalProfile:
        instagramBrowserProfile.mode === "personal"
          ? {
              sourceUserDataDir: instagramBrowserProfile.personalChromeUserDataDir,
              profileDirectory: instagramBrowserProfile.personalChromeProfileDirectory
            }
          : undefined
    });
  }

  if (availability.IMESSAGE) {
    adapters.IMESSAGE = new IMessageAdapter({
      dbPath: runnerConfig.imessage.dbPath,
      contactsVcfPath: runnerConfig.imessage.contactsVcfPath
    });
  }

  if (availability.WHATSAPP && input.whatsappPrisma) {
    adapters.WHATSAPP = new WhatsAppAdapter({
      authDir: runnerConfig.profileDirs.WHATSAPP,
      mediaDir: runnerConfig.whatsapp.mediaDir,
      sendGuardConfig: runnerConfig.whatsapp.send,
      prisma: input.whatsappPrisma,
      onQr: input.onWhatsAppQr,
      onStateChange: input.onWhatsAppStateChange,
      onIncomingMessage: input.onWhatsAppIncomingMessage
    });
  }

  if (availability.GOOGLE_MESSAGES) {
    adapters.GOOGLE_MESSAGES = new GoogleMessagesAdapter({
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      mediaDir: runnerConfig.googleMessages.mediaDir,
      resolveSelectors: () => resolveSelectorsForPlatform("GOOGLE_MESSAGES"),
      sessionManager
    });
  }

  return {
    adapters,
    resolveSelectorsForPlatform,
    sessionManager,
    resolvePlatformSession
  };
}
