import type { PlatformName } from "@inbox-os/core";

export const CONFIGURABLE_PLATFORMS = [
  "LINKEDIN",
  "IMESSAGE",
  "WHATSAPP",
  "GOOGLE_MESSAGES"
] as const;

export type ConfigurablePlatform = (typeof CONFIGURABLE_PLATFORMS)[number];
export type PlatformAvailability = Record<ConfigurablePlatform, boolean>;
export type StoredPlatformStatus = "CONNECTED" | "NOT_CONNECTED" | "DEGRADED" | "ERROR";
export type WhatsAppRuntimeState = "qr_ready" | "connecting" | "connected" | "disconnected";

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
    WHATSAPP: envFlag(env.WHATSAPP_ENABLED, false),
    GOOGLE_MESSAGES:
      hostPlatform === "win32" && envFlag(env.GOOGLE_MESSAGES_ENABLED, true)
  };
}

export function availablePlatformNames(availability: PlatformAvailability): PlatformName[] {
  return CONFIGURABLE_PLATFORMS.filter((platform) => availability[platform]);
}

export function effectivePlatformStatus(
  platform: PlatformName,
  storedStatus: StoredPlatformStatus | undefined,
  whatsappState: WhatsAppRuntimeState
): StoredPlatformStatus {
  if (platform === "WHATSAPP") {
    if (whatsappState !== "connected") {
      return "NOT_CONNECTED";
    }
    if (storedStatus === "DEGRADED" || storedStatus === "ERROR") {
      return storedStatus;
    }
    return "CONNECTED";
  }
  return storedStatus ?? "NOT_CONNECTED";
}

export function connectedPlatformCount(
  availablePlatforms: readonly PlatformName[],
  rows: ReadonlyArray<{ name: PlatformName; status: StoredPlatformStatus }>,
  whatsappState: WhatsAppRuntimeState
): number {
  const statusByPlatform = new Map(rows.map((row) => [row.name, row.status]));
  return availablePlatforms.filter(
    (platform) =>
      effectivePlatformStatus(platform, statusByPlatform.get(platform), whatsappState) ===
      "CONNECTED"
  ).length;
}
