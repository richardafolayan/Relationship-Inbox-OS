import type { PlatformName } from "@inbox-os/core";

export const CONFIGURABLE_PLATFORMS = ["LINKEDIN", "IMESSAGE", "WHATSAPP"] as const;

export type ConfigurablePlatform = (typeof CONFIGURABLE_PLATFORMS)[number];
export type PlatformAvailability = Record<ConfigurablePlatform, boolean>;

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolvePlatformAvailability(
  env: NodeJS.ProcessEnv,
  hostPlatform: NodeJS.Platform = process.platform
): PlatformAvailability {
  return {
    LINKEDIN: envFlag(env.LINKEDIN_ENABLED, true),
    IMESSAGE: envFlag(env.IMESSAGE_ENABLED, false) && hostPlatform === "darwin",
    WHATSAPP: envFlag(env.WHATSAPP_ENABLED, false)
  };
}

export function availablePlatformNames(availability: PlatformAvailability): PlatformName[] {
  return CONFIGURABLE_PLATFORMS.filter((platform) => availability[platform]);
}
