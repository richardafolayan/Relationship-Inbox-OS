import type { PlatformName } from "@inbox-os/core";
import { prisma } from "../db";
import { safeJsonParse } from "../utils/json";
import { createKeyedMutex } from "./keyed-mutex";

const SETUP_PREFERENCES_KEY = "setup_preferences_v2";
const SETUP_PLATFORMS: PlatformName[] = [
  "IMESSAGE",
  "LINKEDIN",
  "INSTAGRAM",
  "WHATSAPP",
  "GOOGLE_MESSAGES"
];

export type SetupTranscriptionMode = "off" | "standard" | "enhanced";

export interface SetupPreferences {
  selectedPlatforms: PlatformName[];
  aiEnabled: boolean;
  transcriptionMode: SetupTranscriptionMode;
  startedAt: string;
  completedAt: string;
  revision: number;
}

export type SetupPreferencesUpdate = Partial<Omit<SetupPreferences, "revision">>;

export interface SetupPreferencesMutationOptions {
  expectedRevision?: number;
}

export class SetupPreferencesConflictError extends Error {
  constructor(readonly current: SetupPreferences) {
    super("Setup preferences changed in another window.");
    this.name = "SetupPreferencesConflictError";
  }
}

export const defaultSetupPreferences: SetupPreferences = {
  selectedPlatforms: [],
  aiEnabled: false,
  transcriptionMode: "off",
  startedAt: "",
  completedAt: "",
  revision: 0
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
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : "",
    revision:
      typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0
        ? raw.revision
        : 0
  };
}

interface SetupPreferencesPersistence {
  read(): Promise<unknown | null>;
  write(next: SetupPreferences): Promise<void>;
}

export function createSetupPreferencesStore(persistence: SetupPreferencesPersistence) {
  const mutex = createKeyedMutex();

  async function get(): Promise<SetupPreferences> {
    const value = await persistence.read();
    return value === null
      ? { ...defaultSetupPreferences, selectedPlatforms: [] }
      : normalizeSetupPreferences(value);
  }

  async function mutate(
    options: SetupPreferencesMutationOptions,
    buildUpdate: (current: SetupPreferences) => Promise<SetupPreferencesUpdate>
  ): Promise<SetupPreferences> {
    return mutex.runExclusive(SETUP_PREFERENCES_KEY, async () => {
      const current = await get();
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== current.revision
      ) {
        throw new SetupPreferencesConflictError(current);
      }
      const partial = await buildUpdate(current);
      const next = normalizeSetupPreferences({
        ...current,
        ...partial,
        revision: current.revision + 1
      });
      await persistence.write(next);
      return next;
    });
  }

  return {
    get,
    mutate,
    update: (
      partial: SetupPreferencesUpdate,
      options: SetupPreferencesMutationOptions = {}
    ) => mutate(options, async () => partial)
  };
}

const setupPreferencesStore = createSetupPreferencesStore({
  read: async () => {
    const row = await prisma.setting.findUnique({ where: { key: SETUP_PREFERENCES_KEY } });
    return row ? safeJsonParse<unknown>(row.valueJson, {}) : null;
  },
  write: async (next) => {
    await prisma.setting.upsert({
      where: { key: SETUP_PREFERENCES_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: SETUP_PREFERENCES_KEY, valueJson: JSON.stringify(next) }
    });
  }
});

export const getSetupPreferences = setupPreferencesStore.get;

export function updateSetupPreferences(
  partial: SetupPreferencesUpdate,
  options: SetupPreferencesMutationOptions = {}
): Promise<SetupPreferences> {
  return setupPreferencesStore.update(partial, options);
}

export function mutateSetupPreferences(
  options: SetupPreferencesMutationOptions,
  buildUpdate: (current: SetupPreferences) => Promise<SetupPreferencesUpdate>
): Promise<SetupPreferences> {
  return setupPreferencesStore.mutate(options, buildUpdate);
}
