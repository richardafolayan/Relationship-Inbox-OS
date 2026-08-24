import type { PlatformName } from "@inbox-os/core";

export interface PlatformSessionResetPlan {
  resetScope: "ISOLATED_PLATFORM" | "SHARED_PERSON" | "GLOBAL";
  resetSharedSession: boolean;
  resetInstagramSession: boolean;
  statusPlatforms: PlatformName[];
}

export function planPlatformSessionReset(
  availablePlatforms: PlatformName[],
  requestedPlatform?: PlatformName
): PlatformSessionResetPlan {
  const sharedPlatforms = availablePlatforms.filter(
    (platform) => platform !== "INSTAGRAM" && platform !== "WHATSAPP"
  );

  if (requestedPlatform === "INSTAGRAM") {
    return {
      resetScope: "ISOLATED_PLATFORM",
      resetSharedSession: false,
      resetInstagramSession: true,
      statusPlatforms: availablePlatforms.includes("INSTAGRAM") ? ["INSTAGRAM"] : []
    };
  }

  if (requestedPlatform) {
    return {
      resetScope: "SHARED_PERSON",
      resetSharedSession: true,
      resetInstagramSession: false,
      statusPlatforms: sharedPlatforms
    };
  }

  return {
    resetScope: "GLOBAL",
    resetSharedSession: true,
    resetInstagramSession: availablePlatforms.includes("INSTAGRAM"),
    statusPlatforms: availablePlatforms.filter((platform) => platform !== "WHATSAPP")
  };
}
