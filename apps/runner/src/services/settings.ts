import type { AppSettings, PlatformName, SelectorOverrideStore, SelectorRegistry } from "@inbox-os/core";
import { defaultSettings } from "@inbox-os/core";
import { safeJsonParse } from "../utils/json";
import { prisma } from "../db";
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
  ReplyStyle,
  SettingsStore
} from "../types/runtime";

const APP_SETTINGS_KEY = "app_settings";
const SELECTOR_OVERRIDES_KEY = "selector_overrides";
const DEMO_SEED_MANIFEST_KEY = "demo_seed_manifest";
// Kept at v1 deliberately: the voice/identity fields were added to the JSON
// shape after about/interests. A pre-existing {about,interests} row parses
// fine — the new fields just fall through to their defaults below.
const OPERATOR_PROFILE_KEY = "operator_profile_v1";

const REPLY_STYLES: ReplyStyle[] = ["warm", "direct", "casual", "thoughtful", "concise"];
const AI_HELP_LEVELS: AiHelpLevel[] = ["memory_only", "writing_support", "full_drafts"];
const FOCUS_AUDIENCES: FocusAudience[] = ["favourites", "all_personal"];

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
    source: asFocusWindowSource(raw.source),
    sourceEventKey: asString(raw.sourceEventKey)
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
    oneNotePerPerson: asBoolean(raw.oneNotePerPerson, defaultFocusSettings.oneNotePerPerson),
    audience: asFocusAudience(raw.audience)
  };
}

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

    // Concurrency note: a writer (`updateSettings`) running while we're
    // mid-DB-read can populate `settingsCache` before our promise resolves.
    // The tail of the load promise must not clobber that fresher value, so
    // we only assign when the cache is still empty (`??=`). Same pattern in
    // `getSelectorOverrides`. The earlier in-place `settingsCache = ...`
    // had a real write-race here.
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
        settingsCache ??= cloneSettings(defaultSettings);
        return cloneSettings(settingsCache);
      }

      const loaded: AppSettings = {
        ...defaultSettings,
        // A corrupt app_settings row must not throw out of getSettings — it's
        // read at boot and on many control routes. Fall back to defaults.
        ...safeJsonParse<Partial<AppSettings>>(record.valueJson, {})
      };
      settingsCache ??= cloneSettings(loaded);
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

    // Set cache *and* drop any in-flight load promise so a concurrent
    // load-in-progress doesn't seal a stale value over ours via the
    // load promise's tail assignment (which now uses `??=`, but
    // dropping the promise is belt-and-braces).
    settingsCache = cloneSettings(next);
    settingsLoadPromise = null;
    return cloneSettings(settingsCache);
  }

  async function getSelectorOverrides(): Promise<SelectorOverrideStore> {
    if (selectorOverridesCache) {
      return cloneSelectorOverrides(selectorOverridesCache);
    }

    selectorOverridesLoadPromise ??= (async () => {
      const record = await prisma.setting.findUnique({ where: { key: SELECTOR_OVERRIDES_KEY } });
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

    await prisma.setting.upsert({
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

    await prisma.setting.upsert({
      where: { key: SELECTOR_OVERRIDES_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: SELECTOR_OVERRIDES_KEY, valueJson: JSON.stringify(next) }
    });
    selectorOverridesCache = cloneSelectorOverrides(next);
    selectorOverridesLoadPromise = null;
  }

  async function getDemoSeedManifest(): Promise<DemoSeedManifest | null> {
    const record = await prisma.setting.findUnique({ where: { key: DEMO_SEED_MANIFEST_KEY } });
    if (!record) {
      return null;
    }
    return safeJsonParse<DemoSeedManifest | null>(record.valueJson, null);
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

  async function getOperatorProfile(): Promise<OperatorProfile> {
    const record = await prisma.setting.findUnique({ where: { key: OPERATOR_PROFILE_KEY } });
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

  async function updateOperatorProfile(partial: Partial<OperatorProfile>): Promise<OperatorProfile> {
    const current = await getOperatorProfile();
    const next: OperatorProfile = {
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
        partial.focusWindow !== undefined ? asFocusWindow(partial.focusWindow) : current.focusWindow,
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
    await prisma.setting.upsert({
      where: { key: OPERATOR_PROFILE_KEY },
      update: { valueJson: JSON.stringify(next) },
      create: { key: OPERATOR_PROFILE_KEY, valueJson: JSON.stringify(next) }
    });
    return next;
  }

  return {
    getSettings,
    updateSettings,
    getSelectorOverrides,
    saveSelectorOverride,
    resetSelectorOverride,
    getDemoSeedManifest,
    setDemoSeedManifest,
    getOperatorProfile,
    updateOperatorProfile
  };
}
