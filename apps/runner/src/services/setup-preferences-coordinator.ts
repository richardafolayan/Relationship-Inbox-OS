import type { AppSettings, PlatformName } from "@inbox-os/core";
import type {
  SetupPreferences,
  SetupPreferencesMutationOptions,
  SetupPreferencesUpdate
} from "./setup-preferences";

export interface SetupPreferencesPayload extends SetupPreferencesUpdate {
  expectedRevision?: number;
}

interface SetupPreferencesCoordinatorDeps {
  availablePlatforms: readonly PlatformName[];
  getSettings(): Promise<AppSettings>;
  updateSettings(partial: Partial<AppSettings>): Promise<unknown>;
  mutatePreferences(
    options: SetupPreferencesMutationOptions,
    buildUpdate: (current: SetupPreferences) => Promise<SetupPreferencesUpdate>
  ): Promise<SetupPreferences>;
  persistWhatsAppEnabled(enabled: boolean): void;
  applyWhatsAppEnabled(enabled: boolean): void;
}

export function createSetupPreferencesCoordinator(deps: SetupPreferencesCoordinatorDeps) {
  async function update(payload: SetupPreferencesPayload): Promise<SetupPreferences> {
    let whatsappEnabled = false;
    const preferences = await deps.mutatePreferences(
      { expectedRevision: payload.expectedRevision },
      async (current) => {
        const currentSettings = await deps.getSettings();
        const existingPilotPlatforms = currentSettings.enabledPlatforms.filter((platform) =>
          deps.availablePlatforms.includes(platform)
        );
        const selectedPlatforms = (
          payload.selectedPlatforms ??
          (current.startedAt || current.selectedPlatforms.length > 0
            ? current.selectedPlatforms
            : existingPilotPlatforms)
        ).filter((platform) => deps.availablePlatforms.includes(platform));
        const aiEnabled =
          payload.aiEnabled ??
          (current.startedAt ? current.aiEnabled : currentSettings.aiEnabled !== false);
        whatsappEnabled = selectedPlatforms.includes("WHATSAPP");

        deps.persistWhatsAppEnabled(whatsappEnabled);
        await deps.updateSettings({ enabledPlatforms: selectedPlatforms, aiEnabled });

        return {
          ...payload,
          selectedPlatforms,
          aiEnabled
        };
      }
    );

    deps.applyWhatsAppEnabled(whatsappEnabled);
    return preferences;
  }

  return { update };
}
