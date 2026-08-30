import type { AppSettings, PlatformName } from "@inbox-os/core";
import { z } from "zod";
import type { OperatorProfile, PersistedMutation } from "../types/runtime";
import type {
  SetupPreferences,
  SetupPreferencesMutationOptions,
  SetupPreferencesUpdate,
  SetupPreferencesWriter
} from "./setup-preferences";

export interface SetupPreferencesPayload extends SetupPreferencesUpdate {
  expectedRevision?: number;
}

export interface CompleteSetupPayload {
  completedAt: string;
  expectedRevision?: number;
}

const setupPreferencesRequestSchema = z.object({
  selectedPlatforms: z
    .array(z.enum(["IMESSAGE", "LINKEDIN", "INSTAGRAM", "WHATSAPP", "GOOGLE_MESSAGES"]))
    .optional(),
  aiEnabled: z.boolean().optional(),
  startedAt: z.string().max(100).optional(),
  completedAt: z.string().datetime().optional(),
  expectedRevision: z.number().int().nonnegative().optional()
}).superRefine((payload, context) => {
  if (
    payload.completedAt !== undefined &&
    (payload.selectedPlatforms !== undefined ||
      payload.aiEnabled !== undefined ||
      payload.startedAt !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A completion request cannot include other setup changes."
    });
  }
});

export function parseSetupPreferencesRequest(body: unknown):
  | { kind: "complete"; payload: CompleteSetupPayload }
  | { kind: "update"; payload: SetupPreferencesPayload } {
  const parsed = setupPreferencesRequestSchema.parse(body);
  if (parsed.completedAt !== undefined) {
    return {
      kind: "complete",
      payload: {
        completedAt: parsed.completedAt,
        expectedRevision: parsed.expectedRevision
      }
    };
  }
  return {
    kind: "update",
    payload: {
      selectedPlatforms: parsed.selectedPlatforms,
      aiEnabled: parsed.aiEnabled,
      startedAt: parsed.startedAt,
      expectedRevision: parsed.expectedRevision
    }
  };
}

interface SetupPreferencesCoordinatorDeps {
  availablePlatforms: readonly PlatformName[];
  mutateSettings<T>(
    work: (mutation: PersistedMutation<AppSettings>) => Promise<T>
  ): Promise<T>;
  mutateOperatorProfile<T>(
    work: (mutation: PersistedMutation<OperatorProfile>) => Promise<T>
  ): Promise<T>;
  mutatePreferences(
    options: SetupPreferencesMutationOptions,
    buildUpdate: (current: SetupPreferences) => Promise<SetupPreferencesUpdate>,
    persist?: SetupPreferencesWriter
  ): Promise<SetupPreferences>;
  persistSetupState(settings: AppSettings, preferences: SetupPreferences): Promise<void>;
  persistCompletedState(
    operatorProfile: OperatorProfile,
    preferences: SetupPreferences
  ): Promise<void>;
}

export function createSetupPreferencesCoordinator(deps: SetupPreferencesCoordinatorDeps) {
  async function updateState(
    payload: SetupPreferencesPayload,
    additionalSettings: Partial<AppSettings> = {}
  ): Promise<SetupPreferences> {
    let settingsUpdate: Partial<AppSettings> = { ...additionalSettings };
    return deps.mutateSettings(async (settingsMutation) =>
      deps.mutatePreferences(
        { expectedRevision: payload.expectedRevision },
        async (current) => {
          const existingPilotPlatforms = settingsMutation.current.enabledPlatforms.filter(
            (platform) => deps.availablePlatforms.includes(platform)
          );
          const selectedPlatforms = (
            payload.selectedPlatforms ??
            (current.startedAt || current.selectedPlatforms.length > 0
              ? current.selectedPlatforms
              : existingPilotPlatforms)
          ).filter((platform) => deps.availablePlatforms.includes(platform));
          const aiEnabled =
            payload.aiEnabled ??
            (current.startedAt
              ? current.aiEnabled
              : settingsMutation.current.aiEnabled !== false);

          if (payload.selectedPlatforms !== undefined || !current.startedAt) {
            settingsUpdate.enabledPlatforms = selectedPlatforms;
          }
          if (payload.aiEnabled !== undefined || !current.startedAt) {
            settingsUpdate.aiEnabled = aiEnabled;
          }

          return {
            selectedPlatforms,
            aiEnabled,
            ...(payload.transcriptionMode !== undefined
              ? { transcriptionMode: payload.transcriptionMode }
              : {}),
            ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
            ...(payload.completedAt !== undefined ? { completedAt: payload.completedAt } : {})
          };
        },
        async (preferences) => {
          await settingsMutation.commit(
            settingsUpdate,
            (settings) => deps.persistSetupState(settings, preferences)
          );
        }
      )
    );
  }

  async function update(payload: SetupPreferencesPayload): Promise<SetupPreferences> {
    return updateState(payload);
  }

  async function enableAiProvider(
    provider: "gemini",
    expectedRevision: number
  ): Promise<SetupPreferences> {
    return updateState({ aiEnabled: true, expectedRevision }, { aiProvider: provider });
  }

  async function complete(payload: CompleteSetupPayload): Promise<{
    preferences: SetupPreferences;
    operatorProfile: OperatorProfile;
  }> {
    return deps.mutateOperatorProfile(async (profileMutation) => {
      let operatorProfile: OperatorProfile | null = null;
      const preferences = await deps.mutatePreferences(
        { expectedRevision: payload.expectedRevision },
        async () => ({ completedAt: payload.completedAt }),
        async (nextPreferences) => {
          operatorProfile = await profileMutation.commit(
            { setupCompletedAt: payload.completedAt },
            (nextProfile) => deps.persistCompletedState(nextProfile, nextPreferences)
          );
        }
      );
      if (!operatorProfile) {
        throw new Error("Setup completion did not persist the operator profile.");
      }
      return { preferences, operatorProfile };
    });
  }

  return { update, enableAiProvider, complete };
}
