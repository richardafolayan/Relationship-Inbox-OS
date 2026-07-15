import type { PlatformName } from "@inbox-os/core";
import { prisma } from "../db";
import { safeJsonParse } from "../utils/json";

const SETUP_PREFERENCES_KEY = "setup_preferences_v2";
const SETUP_PLATFORMS: PlatformName[] = ["IMESSAGE", "LINKEDIN", "WHATSAPP"];

export type SetupTranscriptionMode = "off" | "standard" | "enhanced";

export interface SetupPreferences {
  selectedPlatforms: PlatformName[];
  aiEnabled: boolean;
  transcriptionMode: SetupTranscriptionMode;
  startedAt: string;
  completedAt: string;
}

export const defaultSetupPreferences: SetupPreferences = {
  selectedPlatforms: [],
  aiEnabled: false,
  transcriptionMode: "off",
  startedAt: "",
  completedAt: ""
};

export function normalizeSetupPreferences(value: unknown): SetupPreferences {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const selectedPlatforms = Array.isArray(raw.selectedPlatforms)
    ? raw.selectedPlatforms.filter(
        (platform): platform is PlatformName =>
          typeof platform === "string" && SETUP_PLATFORMS.includes(platform as PlatformName)
      )
    : [];
  const transcriptionMode =
    raw.transcriptionMode === "standard" || raw.transcriptionMode === "enhanced"
      ? raw.transcriptionMode
      : "off";
  return {
    selectedPlatforms: [...new Set(selectedPlatforms)],
    aiEnabled: raw.aiEnabled === true,
    transcriptionMode,
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : ""
  };
}

export async function getSetupPreferences(): Promise<SetupPreferences> {
  const row = await prisma.setting.findUnique({ where: { key: SETUP_PREFERENCES_KEY } });
  return row
    ? normalizeSetupPreferences(safeJsonParse<unknown>(row.valueJson, {}))
    : { ...defaultSetupPreferences, selectedPlatforms: [] };
}

export async function updateSetupPreferences(
  partial: Partial<SetupPreferences>
): Promise<SetupPreferences> {
  const current = await getSetupPreferences();
  const next = normalizeSetupPreferences({ ...current, ...partial });
  await prisma.setting.upsert({
    where: { key: SETUP_PREFERENCES_KEY },
    update: { valueJson: JSON.stringify(next) },
    create: { key: SETUP_PREFERENCES_KEY, valueJson: JSON.stringify(next) }
  });
  return next;
}
