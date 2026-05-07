import type { AppSettings, PlatformName, SelectorOverrideStore, SelectorRegistry } from "@inbox-os/core";
import { defaultSettings } from "@inbox-os/core";
import { prisma } from "../db";
import type { DemoSeedManifest, SettingsStore } from "../types/runtime";

const APP_SETTINGS_KEY = "app_settings";
const SELECTOR_OVERRIDES_KEY = "selector_overrides";
const DEMO_SEED_MANIFEST_KEY = "demo_seed_manifest";

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    enabledPlatforms: [...settings.enabledPlatforms]
  };
}

function cloneSelectorOverrides(overrides: SelectorOverrideStore): SelectorOverrideStore {
  return Object.fromEntries(
    Object.entries(overrides).map(([platform, platformOverrides]) => [
      platform,
      { ...(platformOverrides ?? {}) }
    ])
  ) as SelectorOverrideStore;
}

export function createSettingsStore(): SettingsStore {
  let settingsCache: AppSettings | null = null;
  let settingsLoadPromise: Promise<AppSettings> | null = null;
  let selectorOverridesCache: SelectorOverrideStore | null = null;
  let selectorOverridesLoadPromise: Promise<SelectorOverrideStore> | null = null;

  async function getSettings(): Promise<AppSettings> {
    if (settingsCache) {
      return cloneSettings(settingsCache);
    }

    settingsLoadPromise ??= (async () => {
      const record = await prisma.setting.findUnique({ where: { key: APP_SETTINGS_KEY } });
      if (!record) {
        await prisma.setting.upsert({
          where: { key: APP_SETTINGS_KEY },
          update: {},
          create: {
            key: APP_SETTINGS_KEY,
            valueJson: JSON.stringify(defaultSettings)
          }
        });
        settingsCache = cloneSettings(defaultSettings);
        return cloneSettings(settingsCache);
      }

      settingsCache = {
        ...defaultSettings,
        ...(JSON.parse(record.valueJson) as Partial<AppSettings>)
      };
      return cloneSettings(settingsCache);
    })().finally(() => {
      settingsLoadPromise = null;
    });

    return cloneSettings(await settingsLoadPromise);
  }

  async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    const current = await getSettings();
    const next: AppSettings = {
      ...current,
      ...partial
    };

    await prisma.setting.upsert({
      where: { key: APP_SETTINGS_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: APP_SETTINGS_KEY, valueJson: JSON.stringify(next) }
    });

    settingsCache = cloneSettings(next);
    return cloneSettings(settingsCache);
  }

  async function getSelectorOverrides(): Promise<SelectorOverrideStore> {
    if (selectorOverridesCache) {
      return cloneSelectorOverrides(selectorOverridesCache);
    }

    selectorOverridesLoadPromise ??= (async () => {
      const record = await prisma.setting.findUnique({ where: { key: SELECTOR_OVERRIDES_KEY } });
      selectorOverridesCache = record
        ? (JSON.parse(record.valueJson) as SelectorOverrideStore)
        : {};
      return cloneSelectorOverrides(selectorOverridesCache);
    })().finally(() => {
      selectorOverridesLoadPromise = null;
    });

    return cloneSelectorOverrides(await selectorOverridesLoadPromise);
  }

  async function saveSelectorOverride(
    platform: PlatformName,
    key: keyof SelectorRegistry,
    selector: string
  ): Promise<void> {
    const current = await getSelectorOverrides();
    const next: SelectorOverrideStore = {
      ...current,
      [platform]: {
        ...(current[platform] ?? {}),
        [key]: selector
      }
    };

    await prisma.setting.upsert({
      where: { key: SELECTOR_OVERRIDES_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: SELECTOR_OVERRIDES_KEY, valueJson: JSON.stringify(next) }
    });
    selectorOverridesCache = cloneSelectorOverrides(next);
  }

  async function resetSelectorOverride(platform: PlatformName, key: keyof SelectorRegistry): Promise<void> {
    const current = await getSelectorOverrides();
    const platformOverrides = { ...(current[platform] ?? {}) };
    delete platformOverrides[key];

    const next: SelectorOverrideStore = {
      ...current,
      [platform]: platformOverrides
    };

    await prisma.setting.upsert({
      where: { key: SELECTOR_OVERRIDES_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: SELECTOR_OVERRIDES_KEY, valueJson: JSON.stringify(next) }
    });
    selectorOverridesCache = cloneSelectorOverrides(next);
  }

  async function getDemoSeedManifest(): Promise<DemoSeedManifest | null> {
    const record = await prisma.setting.findUnique({ where: { key: DEMO_SEED_MANIFEST_KEY } });
    if (!record) {
      return null;
    }
    return JSON.parse(record.valueJson) as DemoSeedManifest;
  }

  async function setDemoSeedManifest(manifest: DemoSeedManifest | null): Promise<void> {
    if (!manifest) {
      await prisma.setting.deleteMany({ where: { key: DEMO_SEED_MANIFEST_KEY } });
      return;
    }

    await prisma.setting.upsert({
      where: { key: DEMO_SEED_MANIFEST_KEY },
      update: { valueJson: JSON.stringify(manifest) },
      create: { key: DEMO_SEED_MANIFEST_KEY, valueJson: JSON.stringify(manifest) }
    });
  }

  return {
    getSettings,
    updateSettings,
    getSelectorOverrides,
    saveSelectorOverride,
    resetSelectorOverride,
    getDemoSeedManifest,
    setDemoSeedManifest
  };
}
