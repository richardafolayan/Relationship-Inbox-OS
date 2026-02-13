import { resolveSelectors } from "@inbox-os/core";
import type { PlatformAdapter, PlatformName, SelectorRegistry } from "@inbox-os/core";
import { runnerConfig } from "../config";
import type { SettingsStore } from "../types/runtime";
import { LinkedInAdapter } from "../platforms/linkedin-adapter";
import { BetaAdapter } from "../platforms/beta-adapter";
import type { ConnectStepInfo, PersonalProfileFallbackInfo } from "../platforms/browser-launch";

export function createAdapters(input: {
  settingsStore: SettingsStore;
  onConnectStep?: (info: ConnectStepInfo) => Promise<void> | void;
  onPersonalProfileFallback?: (info: PersonalProfileFallbackInfo) => Promise<void> | void;
}): {
  adapters: Record<PlatformName, PlatformAdapter>;
  resolveSelectorsForPlatform: (platform: PlatformName) => Promise<SelectorRegistry>;
} {
  async function resolveSelectorsForPlatform(platform: PlatformName): Promise<SelectorRegistry> {
    const overrides = await input.settingsStore.getSelectorOverrides();
    return resolveSelectors(platform, runnerConfig.selectorDir, overrides);
  }

  const adapters: Record<PlatformName, PlatformAdapter> = {
    LINKEDIN: new LinkedInAdapter({
      profileDir: runnerConfig.profileDirs.LINKEDIN,
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      scanMaxThreads: runnerConfig.linkedInScan.maxThreads,
      scanStableIterations: runnerConfig.linkedInScan.stableIterations,
      scanScrollWaitMs: runnerConfig.linkedInScan.scrollWaitMs,
      messageBackfillAttempts: runnerConfig.linkedInScan.messageBackfillAttempts,
      resolveSelectors: () => resolveSelectorsForPlatform("LINKEDIN"),
      getSettings: () => input.settingsStore.getSettings(),
      browserProfile: runnerConfig.browserProfile,
      onConnectStep: input.onConnectStep,
      onPersonalProfileFallback: input.onPersonalProfileFallback
    }),
    INSTAGRAM: new BetaAdapter({
      platform: "INSTAGRAM",
      profileDir: runnerConfig.profileDirs.INSTAGRAM,
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      resolveSelectors: () => resolveSelectorsForPlatform("INSTAGRAM"),
      getSettings: () => input.settingsStore.getSettings(),
      browserProfile: runnerConfig.browserProfile,
      onConnectStep: input.onConnectStep,
      onPersonalProfileFallback: input.onPersonalProfileFallback
    }),
    TIKTOK: new BetaAdapter({
      platform: "TIKTOK",
      profileDir: runnerConfig.profileDirs.TIKTOK,
      screenshotDir: runnerConfig.screenshotDir,
      domDumpDir: runnerConfig.domDumpDir,
      resolveSelectors: () => resolveSelectorsForPlatform("TIKTOK"),
      getSettings: () => input.settingsStore.getSettings(),
      browserProfile: runnerConfig.browserProfile,
      onConnectStep: input.onConnectStep,
      onPersonalProfileFallback: input.onPersonalProfileFallback
    })
  };

  return {
    adapters,
    resolveSelectorsForPlatform
  };
}
