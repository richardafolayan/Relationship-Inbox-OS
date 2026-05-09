import { resolveSelectors } from "@inbox-os/core";
import type { PlatformAdapter, PlatformName, SelectorRegistry } from "@inbox-os/core";
import { resolve, dirname } from "node:path";
import { runnerConfig } from "../config";
import type { SettingsStore } from "../types/runtime";
import { LinkedInAdapter } from "../platforms/linkedin-adapter";
import { BetaAdapter } from "../platforms/beta-adapter";
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
  adapters: Record<PlatformName, PlatformAdapter>;
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

  const adapters: Record<PlatformName, PlatformAdapter> = {
    LINKEDIN: new LinkedInAdapter({
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      scanMaxThreads: runnerConfig.linkedInScan.maxThreads,
      scanStableIterations: runnerConfig.linkedInScan.stableIterations,
      scanScrollWaitMs: runnerConfig.linkedInScan.scrollWaitMs,
      messageBackfillAttempts: runnerConfig.linkedInScan.messageBackfillAttempts,
      resolveSelectors: () => resolveSelectorsForPlatform("LINKEDIN"),
      sessionManager,
      // Optional fallback creds. Both must be set or we don't pass anything,
      // which keeps the auto-login codepath inert in dev / CI / first-run.
      linkedInCredentials:
        runnerConfig.linkedInUsername && runnerConfig.linkedInPassword
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
