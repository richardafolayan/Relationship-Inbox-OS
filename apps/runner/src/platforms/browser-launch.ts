import type { PlatformName } from "@inbox-os/core";
import type { BrowserContext } from "patchright";
import type { BrowserProfileConfig } from "../config";
import {
  preparePersonalProfileMirror as preparePersonalProfileMirrorDefault,
  type PersonalProfileMirrorInput,
  type PersonalProfileMirrorResult
} from "./personal-profile-mirror.js";

interface LaunchPersistentContextOptions {
  headless: boolean;
  viewport: null;
  args?: string[];
  channel?: string;
  // Playwright/Patchright default this to false, which injects
  // --no-sandbox and shows Chrome's "unsupported command-line flag"
  // infobar — both are loud automation tells. Real Chrome runs
  // sandboxed; we force it on. (No Docker/CI sandbox constraint here
  // — this runs on the operator's macOS machine.)
  chromiumSandbox?: boolean;
  // Playwright/Patchright still inject some detectable args by
  // default even though Patchright strips the big --enable-automation
  // one. Strip the leftovers explicitly: --disable-blink-features=
  // AutomationControlled (trips Chrome's bad-flags banner; redundant
  // since Patchright patches navigator.webdriver natively) and
  // --disable-infobars (an automation tell real Chrome never sets).
  ignoreDefaultArgs?: string[];
}

interface LaunchPersistentContext {
  (userDataDir: string, options: LaunchPersistentContextOptions): Promise<BrowserContext>;
}

export type ConnectStepAction =
  | "CONNECT_PROFILE_PREP_START"
  | "CONNECT_PROFILE_PREP_OK"
  | "CONNECT_PROFILE_PREP_FAIL"
  | "CONNECT_BROWSER_LAUNCH_START"
  | "CONNECT_BROWSER_LAUNCH_OK"
  | "CONNECT_BROWSER_LAUNCH_FAIL";

export interface ConnectStepInfo {
  platform: PlatformName;
  action: ConnectStepAction;
  status: "OK" | "FAIL";
  details?: Record<string, unknown>;
}

export interface PersonalProfileFallbackInfo {
  platform: PlatformName;
  reason: string;
  personalChromeUserDataDir: string;
  personalChromeLaunchUserDataDir: string;
  personalChromeProfileDirectory: string;
  personalChromeProfileName: string;
  personalChromeProfileResolutionStrategy: string;
  mirrorResult?: PersonalProfileMirrorResult;
  fallbackProfileDir: string;
}

export function buildPersonalChromeArgs(baseArgs: string[], profileDirectory: string): string[] {
  const args = baseArgs.filter((arg) => !arg.startsWith("--profile-directory="));
  args.push(`--profile-directory=${profileDirectory}`);
  return args;
}

export async function launchPersistentContextForPlatform(input: {
  platform: PlatformName;
  launchPersistentContext: LaunchPersistentContext;
  isolatedProfileDir: string;
  headless: boolean;
  browserProfile: BrowserProfileConfig;
  args?: string[];
  hostPlatform?: NodeJS.Platform;
  preferInstalledChrome?: boolean;
  preparePersonalProfileMirror?: (input: PersonalProfileMirrorInput) => Promise<PersonalProfileMirrorResult>;
  onConnectStep?: (info: ConnectStepInfo) => Promise<void> | void;
  onPersonalProfileFallback?: (info: PersonalProfileFallbackInfo) => Promise<void> | void;
}): Promise<BrowserContext> {
  const baseArgs = input.args ?? [];
  const baseOptions: LaunchPersistentContextOptions = {
    headless: input.headless,
    viewport: null,
    args: baseArgs,
    // Run the real Chrome sandbox so we don't ship --no-sandbox (and
    // its visible infobar). Applies to both isolated and personal
    // launches via the personalOptions spread below.
    chromiumSandbox: true,
    ignoreDefaultArgs: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars"
    ],
    ...((input.hostPlatform ?? process.platform) === "win32" || input.preferInstalledChrome
      ? { channel: "chrome" }
      : {})
  };

  if (input.browserProfile.mode !== "personal") {
    await input.onConnectStep?.({
      platform: input.platform,
      action: "CONNECT_BROWSER_LAUNCH_START",
      status: "OK",
      details: {
        profileMode: "isolated",
        launchUserDataDir: input.isolatedProfileDir
      }
    });

    try {
      const context = await input.launchPersistentContext(input.isolatedProfileDir, baseOptions);
      await input.onConnectStep?.({
        platform: input.platform,
        action: "CONNECT_BROWSER_LAUNCH_OK",
        status: "OK",
        details: {
          profileMode: "isolated",
          launchUserDataDir: input.isolatedProfileDir
        }
      });
      return context;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await input.onConnectStep?.({
        platform: input.platform,
        action: "CONNECT_BROWSER_LAUNCH_FAIL",
        status: "FAIL",
        details: {
          profileMode: "isolated",
          launchUserDataDir: input.isolatedProfileDir,
          reason
        }
      });
      throw error;
    }
  }

  const preparePersonalProfileMirror = input.preparePersonalProfileMirror ?? preparePersonalProfileMirrorDefault;
  const profilePreparationInput: PersonalProfileMirrorInput = {
    sourceUserDataDir: input.browserProfile.personalChromeUserDataDir,
    targetUserDataDir: input.isolatedProfileDir,
    profileDirectory: input.browserProfile.personalChromeProfileDirectory,
    syncMode: input.browserProfile.personalProfileSyncMode
  };
  let mirrorResult: PersonalProfileMirrorResult | undefined;

  await input.onConnectStep?.({
    platform: input.platform,
    action: "CONNECT_PROFILE_PREP_START",
    status: "OK",
    details: {
      sourceUserDataDir: profilePreparationInput.sourceUserDataDir,
      targetUserDataDir: profilePreparationInput.targetUserDataDir,
      profileDirectory: profilePreparationInput.profileDirectory,
      syncMode: profilePreparationInput.syncMode
    }
  });

  try {
    mirrorResult = await preparePersonalProfileMirror(profilePreparationInput);
    await input.onConnectStep?.({
      platform: input.platform,
      action: "CONNECT_PROFILE_PREP_OK",
      status: "OK",
      details: {
        sourceUserDataDir: mirrorResult.sourceUserDataDir,
        targetUserDataDir: mirrorResult.targetUserDataDir,
        profileDirectory: mirrorResult.profileDirectory,
        syncMode: profilePreparationInput.syncMode,
        syncPerformed: mirrorResult.syncPerformed,
        syncReason: mirrorResult.syncReason,
        sourceMarkerMtimeMs: mirrorResult.sourceMarkerMtimeMs,
        lastMirroredSourceMarkerMtimeMs: mirrorResult.lastMirroredSourceMarkerMtimeMs,
        durationMs: mirrorResult.durationMs
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await input.onConnectStep?.({
      platform: input.platform,
      action: "CONNECT_PROFILE_PREP_FAIL",
      status: "FAIL",
      details: {
        sourceUserDataDir: profilePreparationInput.sourceUserDataDir,
        targetUserDataDir: profilePreparationInput.targetUserDataDir,
        profileDirectory: profilePreparationInput.profileDirectory,
        syncMode: profilePreparationInput.syncMode,
        reason
      }
    });
    await input.onPersonalProfileFallback?.({
      platform: input.platform,
      reason,
      personalChromeUserDataDir: input.browserProfile.personalChromeUserDataDir,
      personalChromeLaunchUserDataDir: input.isolatedProfileDir,
      personalChromeProfileDirectory: input.browserProfile.personalChromeProfileDirectory,
      personalChromeProfileName: input.browserProfile.personalChromeProfileName,
      personalChromeProfileResolutionStrategy: input.browserProfile.personalChromeProfileResolutionStrategy,
      fallbackProfileDir: input.isolatedProfileDir
    });

    if (input.browserProfile.fallbackBehavior === "error") {
      throw new Error(
        `Couldn't mirror your "${input.browserProfile.personalChromeProfileName}" Chrome profile (directory ${input.browserProfile.personalChromeProfileDirectory}). ` +
          `Connect cancelled to avoid switching to a Chrome for Testing fingerprint. ` +
          `Reason: ${reason}. ` +
          `Common causes: PERSONAL_CHROME_USER_DATA_DIR points at the wrong path, the profile directory has been renamed in Chrome, or the disk is full.`
      );
    }

    await input.onConnectStep?.({
      platform: input.platform,
      action: "CONNECT_BROWSER_LAUNCH_START",
      status: "OK",
      details: {
        profileMode: "isolated",
        fallbackFrom: "profile_prep_failure",
        launchUserDataDir: input.isolatedProfileDir
      }
    });

    try {
      const fallbackContext = await input.launchPersistentContext(input.isolatedProfileDir, baseOptions);
      await input.onConnectStep?.({
        platform: input.platform,
        action: "CONNECT_BROWSER_LAUNCH_OK",
        status: "OK",
        details: {
          profileMode: "isolated",
          fallbackFrom: "profile_prep_failure",
          launchUserDataDir: input.isolatedProfileDir
        }
      });
      return fallbackContext;
    } catch (fallbackError) {
      const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      await input.onConnectStep?.({
        platform: input.platform,
        action: "CONNECT_BROWSER_LAUNCH_FAIL",
        status: "FAIL",
        details: {
          profileMode: "isolated",
          fallbackFrom: "profile_prep_failure",
          launchUserDataDir: input.isolatedProfileDir,
          reason: fallbackReason
        }
      });
      throw fallbackError;
    }
  }

  const personalLaunchUserDataDir = mirrorResult.targetUserDataDir;
  const personalOptions: LaunchPersistentContextOptions = {
    ...baseOptions,
    channel: "chrome",
    args: buildPersonalChromeArgs(baseArgs, input.browserProfile.personalChromeProfileDirectory),
    ignoreDefaultArgs: [
      ...(baseOptions.ignoreDefaultArgs ?? []),
      "--password-store=basic",
      "--use-mock-keychain"
    ]
  };

  await input.onConnectStep?.({
    platform: input.platform,
    action: "CONNECT_BROWSER_LAUNCH_START",
    status: "OK",
    details: {
      profileMode: "personal",
      launchUserDataDir: personalLaunchUserDataDir,
      sourceUserDataDir: input.browserProfile.personalChromeUserDataDir,
      profileDirectory: input.browserProfile.personalChromeProfileDirectory,
      profileName: input.browserProfile.personalChromeProfileName,
      profileResolutionStrategy: input.browserProfile.personalChromeProfileResolutionStrategy
    }
  });

  try {
    const context = await input.launchPersistentContext(personalLaunchUserDataDir, personalOptions);
    await input.onConnectStep?.({
      platform: input.platform,
      action: "CONNECT_BROWSER_LAUNCH_OK",
      status: "OK",
      details: {
        profileMode: "personal",
        launchUserDataDir: personalLaunchUserDataDir,
        profileDirectory: input.browserProfile.personalChromeProfileDirectory,
        profileName: input.browserProfile.personalChromeProfileName,
        profileResolutionStrategy: input.browserProfile.personalChromeProfileResolutionStrategy
      }
    });
    return context;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await input.onConnectStep?.({
      platform: input.platform,
      action: "CONNECT_BROWSER_LAUNCH_FAIL",
      status: "FAIL",
      details: {
        profileMode: "personal",
        launchUserDataDir: personalLaunchUserDataDir,
        sourceUserDataDir: input.browserProfile.personalChromeUserDataDir,
        profileDirectory: input.browserProfile.personalChromeProfileDirectory,
        profileName: input.browserProfile.personalChromeProfileName,
        profileResolutionStrategy: input.browserProfile.personalChromeProfileResolutionStrategy,
        reason
      }
    });

    try {
      await input.onPersonalProfileFallback?.({
        platform: input.platform,
        reason,
        personalChromeUserDataDir: input.browserProfile.personalChromeUserDataDir,
        personalChromeLaunchUserDataDir: personalLaunchUserDataDir,
        personalChromeProfileDirectory: input.browserProfile.personalChromeProfileDirectory,
        personalChromeProfileName: input.browserProfile.personalChromeProfileName,
        personalChromeProfileResolutionStrategy: input.browserProfile.personalChromeProfileResolutionStrategy,
        mirrorResult,
        fallbackProfileDir: input.isolatedProfileDir
      });
    } catch {
      // Do not block fallback launch if diagnostics logging fails.
    }

    if (input.browserProfile.fallbackBehavior === "error") {
      throw new Error(
        `Couldn't launch your "${input.browserProfile.personalChromeProfileName}" Chrome profile (directory ${input.browserProfile.personalChromeProfileDirectory}). ` +
          `Connect cancelled to avoid switching to a Chrome for Testing fingerprint. ` +
          `Reason: ${reason}. ` +
          `Most often this means Chrome is currently open with that profile. Quit Chrome (or just that profile's window) and reconnect.`
      );
    }

    await input.onConnectStep?.({
      platform: input.platform,
      action: "CONNECT_BROWSER_LAUNCH_START",
      status: "OK",
      details: {
        profileMode: "isolated",
        fallbackFrom: "personal_launch_failure",
        launchUserDataDir: input.isolatedProfileDir
      }
    });

    try {
      const fallbackContext = await input.launchPersistentContext(input.isolatedProfileDir, baseOptions);
      await input.onConnectStep?.({
        platform: input.platform,
        action: "CONNECT_BROWSER_LAUNCH_OK",
        status: "OK",
        details: {
          profileMode: "isolated",
          fallbackFrom: "personal_launch_failure",
          launchUserDataDir: input.isolatedProfileDir
        }
      });
      return fallbackContext;
    } catch (fallbackError) {
      const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      await input.onConnectStep?.({
        platform: input.platform,
        action: "CONNECT_BROWSER_LAUNCH_FAIL",
        status: "FAIL",
        details: {
          profileMode: "isolated",
          fallbackFrom: "personal_launch_failure",
          launchUserDataDir: input.isolatedProfileDir,
          reason: fallbackReason
        }
      });
      throw fallbackError;
    }
  }
}
