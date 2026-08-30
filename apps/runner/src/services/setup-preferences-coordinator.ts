import type { AppSettings, PlatformName } from "@inbox-os/core";
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

          return {
            ...payload,
            selectedPlatforms,
            aiEnabled
          };
        },
        async (preferences) => {
          await settingsMutation.commit(
            {
              enabledPlatforms: preferences.selectedPlatforms,
              aiEnabled: preferences.aiEnabled,
              ...additionalSettings
            },
            (settings) => deps.persistSetupState(settings, preferences)
          );
        }
      )
    );
  }

  async function update(payload: SetupPreferencesPayload): Promise<SetupPreferences> {
    return updateState(payload);
  }

  async function enableAiProvider(provider: "gemini"): Promise<SetupPreferences> {
    return updateState({ aiEnabled: true }, { aiProvider: provider });
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
