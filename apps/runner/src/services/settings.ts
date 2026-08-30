import type { AppSettings, PlatformName, SelectorOverrideStore, SelectorRegistry } from "@inbox-os/core";
import { defaultSettings } from "@inbox-os/core";
import { safeJsonParse } from "../utils/json";
import { prisma } from "../db";
import { createKeyedMutex } from "./keyed-mutex";
import type {
  AckTemplates,
  AiHelpLevel,
  CalendarSyncSettings,
  DemoSeedManifest,
  FocusAudience,
  FocusSettings,
  FocusWindowSource,
  FocusWindowState,
  OperatorProfile,
  PersistedMutation,
  ReplyStyle,
  SettingsStore
} from "../types/runtime";

export const APP_SETTINGS_KEY = "app_settings";
const SELECTOR_OVERRIDES_KEY = "selector_overrides";
const DEMO_SEED_MANIFEST_KEY = "demo_seed_manifest";
// Kept at v1 deliberately: the voice/identity fields were added to the JSON
// shape after about/interests. A pre-existing {about,interests} row parses
// fine — the new fields just fall through to their defaults below.
export const OPERATOR_PROFILE_KEY = "operator_profile_v1";

const REPLY_STYLES: ReplyStyle[] = ["warm", "direct", "casual", "thoughtful", "concise"];
const AI_HELP_LEVELS: AiHelpLevel[] = ["memory_only", "writing_support", "full_drafts"];
const FOCUS_AUDIENCES: FocusAudience[] = ["favourites", "all_personal"];
const LEGACY_ENABLED_PLATFORMS: PlatformName[] = ["LINKEDIN", "IMESSAGE"];
const PLATFORM_NAMES: PlatformName[] = [
  "LINKEDIN",
  "INSTAGRAM",
  "TIKTOK",
  "IMESSAGE",
  "WHATSAPP",
  "GOOGLE_MESSAGES"
];

// Conservative default: full AI reply drafting is OFF until the operator
// opts in. Summaries / open loops / "shorten" + "warmer" still work.
const DEFAULT_AI_HELP_LEVEL: AiHelpLevel = "writing_support";

// Focus Reply Buffer: the operator's two default acknowledgement notes, in
// plain ASCII (no em/en dashes — the release no-ui-dashes gate). Only [Name]
// / [until] / [reason] are ever substituted; the words stay the operator's.
const DEFAULT_ACK_TEMPLATES: AckTemplates = {
  close:
    "Yo [Name], I'm locked in till [until] but I've seen this, I'll reply properly after, call me if it's urgent.",
  professional:
    "Hey [Name], I'm in a focused work block till [until] but I've seen this, I'll come back to it properly after."
};

const emptyFocusWindow: FocusWindowState = {
  active: false,
  startedAt: "",
  endsAt: "",
  reason: "",
  note: "",
  professionalNote: "",
  audience: "favourites",
  windowId: "",
  ackedPersonIds: [],
  autoSendAcknowledgements: false,
  source: "manual",
  sourceEventKey: ""
};

const defaultCalendarSync: CalendarSyncSettings = {
  url: "",
  additionalUrls: [],
  enabled: false,
  keyword: "",
  audience: "favourites",
  phraseWithAi: false
};

const defaultFocusSettings: FocusSettings = {
  reasonLabel: true,
  oneNotePerPerson: true,
  audience: "favourites"
};

const emptyOperatorProfile: OperatorProfile = {
  displayName: "",
  about: "",
  interests: "",
  commonPhrases: "",
  avoidedPhrases: "",
  preferredStyle: "",
  aiHelpLevel: DEFAULT_AI_HELP_LEVEL,
  setupCompletedAt: "",
  focusWindow: { ...emptyFocusWindow, ackedPersonIds: [] },
  ackTemplates: { ...DEFAULT_ACK_TEMPLATES },
  focusSettings: { ...defaultFocusSettings },
  calendarSync: { ...defaultCalendarSync }
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asReplyStyle(value: unknown): ReplyStyle | "" {
  return typeof value === "string" && (REPLY_STYLES as string[]).includes(value)
    ? (value as ReplyStyle)
    : "";
}

function asAiHelpLevel(value: unknown): AiHelpLevel {
  return typeof value === "string" && (AI_HELP_LEVELS as string[]).includes(value)
    ? (value as AiHelpLevel)
    : DEFAULT_AI_HELP_LEVEL;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asFocusAudience(value: unknown): FocusAudience {
  return typeof value === "string" && (FOCUS_AUDIENCES as string[]).includes(value)
    ? (value as FocusAudience)
    : "favourites";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asFocusWindowSource(value: unknown): FocusWindowSource {
  return value === "calendar" ? "calendar" : "manual";
}

function asFocusWindow(value: unknown): FocusWindowState {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    active: asBoolean(raw.active, false),
    startedAt: asString(raw.startedAt),
    endsAt: asString(raw.endsAt),
    reason: asString(raw.reason),
    note: asString(raw.note),
    professionalNote: asString(raw.professionalNote),
    audience: asFocusAudience(raw.audience),
    windowId: asString(raw.windowId),
    ackedPersonIds: asStringArray(raw.ackedPersonIds),
    autoSendAcknowledgements: asBoolean(raw.autoSendAcknowledgements, false),
    source: asFocusWindowSource(raw.source),
    sourceEventKey: asString(raw.sourceEventKey)
  };
}

export function mergeFocusWindowUpdate(
  current: FocusWindowState,
  requestedValue: unknown
): FocusWindowState {
  const requested = asFocusWindow(requestedValue);
  if (requested.windowId !== current.windowId) return requested;
  return {
    ...requested,
    ackedPersonIds: Array.from(new Set([
      ...current.ackedPersonIds,
      ...requested.ackedPersonIds
    ]))
  };
}

function asCalendarSync(value: unknown): CalendarSyncSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const urls = [asString(raw.url), ...asStringArray(raw.additionalUrls)]
    .map((url) => url.trim())
    .filter((url, index, all) => url.length > 0 && all.indexOf(url) === index)
    .slice(0, 12);
  return {
    url: urls[0] ?? "",
    additionalUrls: urls.slice(1),
    enabled: asBoolean(raw.enabled, defaultCalendarSync.enabled),
    keyword: asString(raw.keyword),
    audience: asFocusAudience(raw.audience),
    phraseWithAi: asBoolean(raw.phraseWithAi, defaultCalendarSync.phraseWithAi)
  };
}

function asAckTemplates(value: unknown): AckTemplates {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    close: typeof raw.close === "string" ? raw.close : DEFAULT_ACK_TEMPLATES.close,
    professional:
      typeof raw.professional === "string" ? raw.professional : DEFAULT_ACK_TEMPLATES.professional
  };
}

function asFocusSettings(value: unknown): FocusSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    reasonLabel: asBoolean(raw.reasonLabel, defaultFocusSettings.reasonLabel),
    oneNotePerPerson: true,
    audience: asFocusAudience(raw.audience)
  };
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    enabledPlatforms: [...settings.enabledPlatforms]
  };
}

export function mergePersistedAppSettings(value: unknown): {
  settings: AppSettings;
  shouldPersistUpgrade: boolean;
} {
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const raw = isObject ? (value as Partial<AppSettings>) : {};
  const isRecognizedSettingsRow =
    isObject &&
    typeof raw.scanIntervalSeconds === "number" &&
    Number.isInteger(raw.scanIntervalSeconds) &&
    raw.scanIntervalSeconds >= 10 &&
    raw.scanIntervalSeconds <= 3600 &&
    (raw.automaticUpdates === undefined || typeof raw.automaticUpdates === "boolean") &&
    typeof raw.amberHours === "number" &&
    Number.isInteger(raw.amberHours) &&
    raw.amberHours >= 1 &&
    raw.amberHours <= 72 &&
    typeof raw.redHours === "number" &&
    Number.isInteger(raw.redHours) &&
    raw.redHours >= 1 &&
    raw.redHours <= 168 &&
    typeof raw.headless === "boolean" &&
    typeof raw.maxMessagesPerThread === "number" &&
    Number.isInteger(raw.maxMessagesPerThread) &&
    raw.maxMessagesPerThread >= 5 &&
    raw.maxMessagesPerThread <= 100;
  if (!isRecognizedSettingsRow) {
    return {
      settings: cloneSettings(defaultSettings),
      shouldPersistUpgrade: true
    };
  }
  const hasEnabledPlatforms = Object.prototype.hasOwnProperty.call(raw, "enabledPlatforms");
  const hasAiEnabled = Object.prototype.hasOwnProperty.call(raw, "aiEnabled");
  const persistedPlatforms = hasEnabledPlatforms && Array.isArray(raw.enabledPlatforms)
    ? Array.from(new Set(raw.enabledPlatforms.filter(
        (platform): platform is PlatformName =>
          typeof platform === "string" && PLATFORM_NAMES.includes(platform as PlatformName)
      )))
    : [];
  const enabledPlatformsAreValid =
    !hasEnabledPlatforms ||
    (Array.isArray(raw.enabledPlatforms) &&
      raw.enabledPlatforms.length === persistedPlatforms.length);
  const aiEnabledIsValid = !hasAiEnabled || typeof raw.aiEnabled === "boolean";
  return {
    settings: {
      ...defaultSettings,
      ...raw,
      enabledPlatforms: hasEnabledPlatforms
        ? persistedPlatforms
        : [...LEGACY_ENABLED_PLATFORMS],
      aiEnabled: hasAiEnabled && typeof raw.aiEnabled === "boolean"
        ? raw.aiEnabled
        : hasAiEnabled
          ? defaultSettings.aiEnabled
          : true
    },
    shouldPersistUpgrade:
      raw.automaticUpdates === undefined ||
      !hasEnabledPlatforms ||
      !hasAiEnabled ||
      !enabledPlatformsAreValid ||
      !aiEnabledIsValid
  };
}

function mergeOperatorProfile(
  current: OperatorProfile,
  partial: Partial<OperatorProfile>
): OperatorProfile {
  return {
    displayName: typeof partial.displayName === "string" ? partial.displayName : current.displayName,
    about: typeof partial.about === "string" ? partial.about : current.about,
    interests: typeof partial.interests === "string" ? partial.interests : current.interests,
    commonPhrases:
      typeof partial.commonPhrases === "string" ? partial.commonPhrases : current.commonPhrases,
    avoidedPhrases:
      typeof partial.avoidedPhrases === "string" ? partial.avoidedPhrases : current.avoidedPhrases,
    preferredStyle:
      partial.preferredStyle !== undefined
        ? asReplyStyle(partial.preferredStyle)
        : current.preferredStyle,
    aiHelpLevel:
      partial.aiHelpLevel !== undefined ? asAiHelpLevel(partial.aiHelpLevel) : current.aiHelpLevel,
    setupCompletedAt:
      typeof partial.setupCompletedAt === "string"
        ? partial.setupCompletedAt
        : current.setupCompletedAt,
    focusWindow:
      partial.focusWindow !== undefined
        ? mergeFocusWindowUpdate(current.focusWindow, partial.focusWindow)
        : current.focusWindow,
    ackTemplates:
      partial.ackTemplates !== undefined
        ? asAckTemplates(partial.ackTemplates)
        : current.ackTemplates,
    focusSettings:
      partial.focusSettings !== undefined
        ? asFocusSettings(partial.focusSettings)
        : current.focusSettings,
    calendarSync:
      partial.calendarSync !== undefined
        ? asCalendarSync(partial.calendarSync)
        : current.calendarSync
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

export function createSettingsStore(
  database: Pick<typeof prisma, "setting"> = prisma
): SettingsStore {
  const writeMutex = createKeyedMutex();
  let settingsCache: AppSettings | null = null;
  let settingsLoadPromise: Promise<AppSettings> | null = null;
  let selectorOverridesCache: SelectorOverrideStore | null = null;
  let selectorOverridesLoadPromise: Promise<SelectorOverrideStore> | null = null;

  async function getSettings(): Promise<AppSettings> {
    if (settingsCache) {
      return cloneSettings(settingsCache);
    }

    // Concurrency note: a writer (`updateSettings`) running while we're
    // mid-DB-read can populate `settingsCache` before our promise resolves.
    // The tail of the load promise must not clobber that fresher value, so
    // we only assign when the cache is still empty (`??=`). Same pattern in
    // `getSelectorOverrides`. The earlier in-place `settingsCache = ...`
    // had a real write-race here.
    settingsLoadPromise ??= (async () => {
      const record = await database.setting.findUnique({ where: { key: APP_SETTINGS_KEY } });
      if (!record) {
        await database.setting.upsert({
          where: { key: APP_SETTINGS_KEY },
          update: {},
          create: {
            key: APP_SETTINGS_KEY,
            valueJson: JSON.stringify(defaultSettings)
          }
        });
        settingsCache ??= cloneSettings(defaultSettings);
        return cloneSettings(settingsCache);
      }

      let parsed: Partial<AppSettings> | null = null;
      try {
        const candidate: unknown = JSON.parse(record.valueJson);
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          parsed = candidate as Partial<AppSettings>;
        }
      } catch {
        parsed = null;
      }
      const { settings: loaded, shouldPersistUpgrade } = parsed
        ? mergePersistedAppSettings(parsed)
        : { settings: cloneSettings(defaultSettings), shouldPersistUpgrade: true };
      if (shouldPersistUpgrade) {
        await database.setting.upsert({
          where: { key: APP_SETTINGS_KEY },
          update: { valueJson: JSON.stringify(loaded) },
          create: { key: APP_SETTINGS_KEY, valueJson: JSON.stringify(loaded) }
        });
      }
      settingsCache ??= cloneSettings(loaded);
      return cloneSettings(settingsCache);
    })().finally(() => {
      settingsLoadPromise = null;
    });

    return cloneSettings(await settingsLoadPromise);
  }

  async function mutateSettings<T>(
    work: (mutation: PersistedMutation<AppSettings>) => Promise<T>
  ): Promise<T> {
    return writeMutex.runExclusive(APP_SETTINGS_KEY, async () => {
      const current = await getSettings();
      let committed = false;
      return work({
        current,
        commit: async (partial, persist) => {
          if (committed) {
            throw new Error("Settings mutation already committed.");
          }
          const next: AppSettings = { ...current, ...partial };
          const write = persist ?? (async (value: AppSettings) => {
            await database.setting.upsert({
              where: { key: APP_SETTINGS_KEY },
              update: { valueJson: JSON.stringify(value) },
              create: { key: APP_SETTINGS_KEY, valueJson: JSON.stringify(value) }
            });
          });
          await write(next);
          committed = true;
          settingsCache = cloneSettings(next);
          settingsLoadPromise = null;
          return cloneSettings(settingsCache);
        }
      });
    });
  }

  async function updateSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
    return mutateSettings(({ commit }) => commit(partial));
  }

  async function getSelectorOverrides(): Promise<SelectorOverrideStore> {
    if (selectorOverridesCache) {
      return cloneSelectorOverrides(selectorOverridesCache);
    }

    selectorOverridesLoadPromise ??= (async () => {
      const record = await database.setting.findUnique({ where: { key: SELECTOR_OVERRIDES_KEY } });
      const loaded: SelectorOverrideStore = record
        ? safeJsonParse<SelectorOverrideStore>(record.valueJson, {})
        : {};
      selectorOverridesCache ??= cloneSelectorOverrides(loaded);
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

    await database.setting.upsert({
      where: { key: SELECTOR_OVERRIDES_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: SELECTOR_OVERRIDES_KEY, valueJson: JSON.stringify(next) }
    });
    selectorOverridesCache = cloneSelectorOverrides(next);
    selectorOverridesLoadPromise = null;
  }

  async function resetSelectorOverride(platform: PlatformName, key: keyof SelectorRegistry): Promise<void> {
    const current = await getSelectorOverrides();
    const platformOverrides = { ...(current[platform] ?? {}) };
    delete platformOverrides[key];

    const next: SelectorOverrideStore = {
      ...current,
      [platform]: platformOverrides
    };

    await database.setting.upsert({
      where: { key: SELECTOR_OVERRIDES_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: SELECTOR_OVERRIDES_KEY, valueJson: JSON.stringify(next) }
    });
    selectorOverridesCache = cloneSelectorOverrides(next);
    selectorOverridesLoadPromise = null;
  }

  async function getDemoSeedManifest(): Promise<DemoSeedManifest | null> {
    const record = await database.setting.findUnique({ where: { key: DEMO_SEED_MANIFEST_KEY } });
    if (!record) {
      return null;
    }
    return safeJsonParse<DemoSeedManifest | null>(record.valueJson, null);
  }

  async function setDemoSeedManifest(manifest: DemoSeedManifest | null): Promise<void> {
    if (!manifest) {
      await database.setting.deleteMany({ where: { key: DEMO_SEED_MANIFEST_KEY } });
      return;
    }

    await database.setting.upsert({
      where: { key: DEMO_SEED_MANIFEST_KEY },
      update: { valueJson: JSON.stringify(manifest) },
      create: { key: DEMO_SEED_MANIFEST_KEY, valueJson: JSON.stringify(manifest) }
    });
  }

  async function getOperatorProfile(): Promise<OperatorProfile> {
    const record = await database.setting.findUnique({ where: { key: OPERATOR_PROFILE_KEY } });
    if (!record) return { ...emptyOperatorProfile };
    try {
      const parsed = JSON.parse(record.valueJson) as Record<string, unknown>;
      return {
        displayName: asString(parsed.displayName),
        about: asString(parsed.about),
        interests: asString(parsed.interests),
        commonPhrases: asString(parsed.commonPhrases),
        avoidedPhrases: asString(parsed.avoidedPhrases),
        preferredStyle: asReplyStyle(parsed.preferredStyle),
        aiHelpLevel: asAiHelpLevel(parsed.aiHelpLevel),
        setupCompletedAt: asString(parsed.setupCompletedAt),
        focusWindow: asFocusWindow(parsed.focusWindow),
        ackTemplates: asAckTemplates(parsed.ackTemplates),
        focusSettings: asFocusSettings(parsed.focusSettings),
        calendarSync: asCalendarSync(parsed.calendarSync)
      };
    } catch {
      return { ...emptyOperatorProfile };
    }
  }

  async function mutateOperatorProfile<T>(
    work: (mutation: PersistedMutation<OperatorProfile>) => Promise<T>
  ): Promise<T> {
    return writeMutex.runExclusive(OPERATOR_PROFILE_KEY, async () => {
      const current = await getOperatorProfile();
      let committed = false;
      return work({
        current,
        commit: async (partial, persist) => {
          if (committed) {
            throw new Error("Operator profile mutation already committed.");
          }
          const next = mergeOperatorProfile(current, partial);
          const write = persist ?? (async (value: OperatorProfile) => {
            await database.setting.upsert({
              where: { key: OPERATOR_PROFILE_KEY },
              update: { valueJson: JSON.stringify(value) },
              create: { key: OPERATOR_PROFILE_KEY, valueJson: JSON.stringify(value) }
            });
          });
          await write(next);
          committed = true;
          return next;
        }
      });
    });
  }

  async function updateOperatorProfile(partial: Partial<OperatorProfile>): Promise<OperatorProfile> {
    return mutateOperatorProfile(({ commit }) => commit(partial));
  }

  async function acknowledgeFocusWindowPerson(
    windowId: string,
    personId: string
  ): Promise<boolean> {
    return writeMutex.runExclusive(OPERATOR_PROFILE_KEY, async () => {
      const current = await getOperatorProfile();
      if (current.focusWindow.windowId !== windowId) {
        return false;
      }
      if (current.focusWindow.ackedPersonIds.includes(personId)) return true;
      const next: OperatorProfile = {
        ...current,
        focusWindow: {
          ...current.focusWindow,
          ackedPersonIds: [...current.focusWindow.ackedPersonIds, personId]
        }
      };
      await database.setting.upsert({
        where: { key: OPERATOR_PROFILE_KEY },
        update: { valueJson: JSON.stringify(next) },
        create: { key: OPERATOR_PROFILE_KEY, valueJson: JSON.stringify(next) }
      });
      return true;
    });
  }

  return {
    getSettings,
    updateSettings,
    mutateSettings,
    getSelectorOverrides,
    saveSelectorOverride,
    resetSelectorOverride,
    getDemoSeedManifest,
    setDemoSeedManifest,
    getOperatorProfile,
    updateOperatorProfile,
    mutateOperatorProfile,
    acknowledgeFocusWindowPerson
  };
}
