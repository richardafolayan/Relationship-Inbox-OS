import { resolveSelectors } from "@inbox-os/core";
import type { PlatformAdapter, PlatformName, SelectorRegistry } from "@inbox-os/core";
import { resolve, dirname } from "node:path";
import { runnerConfig } from "../config";
import type { SettingsStore } from "../types/runtime";
import { LinkedInAdapter } from "../platforms/linkedin-adapter";
import { BetaAdapter } from "../platforms/beta-adapter";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "../platforms/browser-launch";
import { createSessionManager } from "./session-manager";

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
    })
  };

  return {
    adapters,
    resolveSelectorsForPlatform,
    sessionManager
  };
}
