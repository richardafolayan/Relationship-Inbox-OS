import { resolveSelectors } from "@inbox-os/core";
import type { PlatformAdapter, PlatformName, SelectorRegistry } from "@inbox-os/core";
import { resolve, dirname } from "node:path";
import { runnerConfig } from "../config";
import type { SettingsStore } from "../types/runtime";
import { LinkedInAdapter } from "../platforms/linkedin-adapter";
import { BetaAdapter } from "../platforms/beta-adapter";
import { IMessageAdapter } from "../platforms/imessage-adapter";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "../platforms/browser-launch";
import { createSessionManager } from "./session-manager";

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
    // WhatsApp is wired in Phase B (whatsapp-web.js adapter). Phase A only
    // adds the platform value + schema columns + plumbing. The stub
    // implements the PlatformAdapter contract without doing any DOM /
    // network work, so the runner boots cleanly with WHATSAPP enabled but
    // any operator-triggered scan / send / open against it surfaces a
    // clear error instead of silently launching Chrome at the wrong target.
    WHATSAPP: createNotImplementedAdapter("WHATSAPP")
  };

  return {
    adapters,
    resolveSelectorsForPlatform,
    sessionManager
  };
}
