import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const currentDir = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(currentDir, "../../..");
export const dataDir = resolve(projectRoot, "data");

export type BrowserProfileMode = "isolated" | "personal";
export type BrowserProfileFallbackBehavior = "allow_isolated" | "error";
export type PersonalProfileSyncMode = "smart" | "always" | "never";
export type ChromeProfileResolutionStrategy =
  | "empty_configured"
  | "directory_exact"
  | "directory_case_insensitive"
  | "name_exact"
  | "name_case_insensitive"
  | "raw_configured"
  | "local_state_missing"
  | "local_state_unreadable";

export interface BrowserProfileConfig {
  mode: BrowserProfileMode;
  fallbackBehavior: BrowserProfileFallbackBehavior;
  personalProfileSyncMode: PersonalProfileSyncMode;
  personalProfileMirrorRoot: string;
  personalChromeUserDataDir: string;
  personalChromeProfileDirectory: string;
  personalChromeProfileName: string;
  personalChromeProfileResolutionStrategy: ChromeProfileResolutionStrategy;
}

export type AiProvider = "openai" | "glm" | "gemini";

export interface RunnerConfig {
  port: number;
  openAiApiKey?: string;
  openAiModel: string;
  aiProvider: AiProvider;
  zAiApiKey?: string;
  zAiBaseUrl: string;
  glmModel: string;
  geminiApiKey?: string;
  geminiBaseUrl: string;
  geminiModel: string;
  dbFile: string;
  profileDirs: {
    LINKEDIN: string;
    INSTAGRAM: string;
    TIKTOK: string;
    IMESSAGE: string;
    /** whatsapp-web.js LocalAuth root. Separate from the Playwright-managed
     * profiles above — WhatsApp uses its own Puppeteer instance. */
    WHATSAPP: string;
  };
  imessage: {
    enabled: boolean;
    dbPath: string;
    /**
     * Debounce window for the chat.db filesystem watcher. SQLite writes a
     * burst of WAL/SHM events per message; we collapse them into one scan
     * enqueue. 500ms is empirically enough to coalesce a single iMessage
     * arrival without noticeably delaying its appearance in the inbox.
     */
    watchDebounceMs: number;
    /**
     * Path to a vCard 3.0 export of the operator's address book. When set,
     * the iMessage adapter resolves phone numbers / emails from chat.db
     * to real display names. Default: data/contacts.vcf if present.
     */
    contactsVcfPath: string | undefined;
  };
  screenshotDir: string;
  domDumpDir: string;
  selectorDir: string;
  browserProfile: BrowserProfileConfig;
  /**
   * Optional LinkedIn auto-login credentials. When both are set, the runner
   * attempts a password-based login if the persistent profile session has
   * expired (AUTH_REQUIRED detected on a scan/connect). Treated as a
   * fallback only — the persistent Chrome profile remains the primary
   * auth path. Captcha / 2FA / verification gates surface a
   * MANUAL_LOGIN_REQUIRED failure rather than getting silently retried.
   * Read from env LINKEDIN_USERNAME / LINKEDIN_PASSWORD.
   */
  linkedInUsername?: string;
  linkedInPassword?: string;
  /**
   * When false (the default), even if username + password are set the
   * runner will not auto-fill the LinkedIn sign-in form. Operators must
   * sign in manually in the controlled Chrome window. Opt in by setting
   * LINKEDIN_AUTO_LOGIN=1 in .env once you've rebuilt account trust.
   */
  linkedInAutoLoginEnabled: boolean;
  linkedInScan: {
    maxThreads: number;
    stableIterations: number;
    scrollWaitMs: number;
    messageBackfillAttempts: number;
  };
  /**
   * Min/max ms between LinkedIn profile-enrichment visits. The queue
   * picks a uniformly random delay in [min, max] before each visit so
   * that the inter-visit interval doesn't form a regular cadence — fixed
   * pacing was the proximate cause of an automated-activity restriction
   * on 2026-05-08, see RUNNER_NOTES in README.
   */
  enrichPaceMinMs: number;
  enrichPaceMaxMs: number;
  /** Max enrichment jobs processed per drain pass. Default 6 (was 30). */
  enrichBatchMax: number;
  /**
   * Soft cap on profile visits per rolling 24h window. The worker tracks
   * recent visit timestamps in memory and defers further work once the
   * cap is hit. Resets on runner restart.
   */
  enrichDailyCap: number;
  /**
   * Every N visits, the worker takes an extended idle pause uniformly in
   * [longIdleMinMs, longIdleMaxMs] before continuing. Breaks up long
   * runs of regular activity that pattern-match as automation.
   */
  enrichLongIdleEvery: number;
  enrichLongIdleMinMs: number;
  enrichLongIdleMaxMs: number;
  /** Days before an enriched profile is considered stale. Default 30. */
  enrichRefreshDays: number;
  /**
   * Pilot feedback intake. When `webhookUrl` is unset the
   * /control/pilot-feedback route reports "not configured" and the
   * dashboard falls back to copy / the external form. Never exposed to
   * the browser — the dashboard posts to the runner, the runner forwards.
   */
  pilotFeedback: {
    webhookUrl?: string;
    secret?: string;
    statusUrl?: string;
  };
}

interface ChromeLocalStateProfileInfo {
  name?: string;
}

interface ChromeLocalState {
  profile?: {
    info_cache?: Record<string, ChromeLocalStateProfileInfo>;
  };
}

function resolveChromeProfileDirectory(
  userDataDir: string,
  configuredDirectory: string
): { profileDirectory: string; resolutionStrategy: ChromeProfileResolutionStrategy } {
  const requested = configuredDirectory.trim();
  if (!requested) {
    return {
      profileDirectory: configuredDirectory,
      resolutionStrategy: "empty_configured"
    };
  }

  const localStatePath = resolve(userDataDir, "Local State");
  if (!existsSync(localStatePath)) {
    return {
      profileDirectory: requested,
      resolutionStrategy: "local_state_missing"
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(localStatePath, "utf8")) as ChromeLocalState;
    const cache = parsed.profile?.info_cache ?? {};
    const entries = Object.entries(cache);

    const hasExactDirectory = Object.hasOwn(cache, requested);
    if (hasExactDirectory) {
      return {
        profileDirectory: requested,
        resolutionStrategy: "directory_exact"
      };
    }

    const lowerRequested = requested.toLowerCase();
    const caseInsensitiveDirectory = entries.find(([directory]) => directory.toLowerCase() === lowerRequested)?.[0];
    if (caseInsensitiveDirectory) {
      return {
        profileDirectory: caseInsensitiveDirectory,
        resolutionStrategy: "directory_case_insensitive"
      };
    }

    const exactNameMatch = entries.find(([, info]) => info?.name === requested)?.[0];
    if (exactNameMatch) {
      return {
        profileDirectory: exactNameMatch,
        resolutionStrategy: "name_exact"
      };
    }

    const caseInsensitiveNameMatch = entries.find(([, info]) => info?.name?.toLowerCase() === lowerRequested)?.[0];
    if (caseInsensitiveNameMatch) {
      return {
        profileDirectory: caseInsensitiveNameMatch,
        resolutionStrategy: "name_case_insensitive"
      };
    }
  } catch {
    return {
      profileDirectory: requested,
      resolutionStrategy: "local_state_unreadable"
    };
  }

  return {
    profileDirectory: requested,
    resolutionStrategy: "raw_configured"
  };
}

function resolvePersonalProfileSyncMode(raw: string | undefined): PersonalProfileSyncMode {
  const normalized = raw?.toLowerCase();
  if (normalized === "always") {
    return "always";
  }
  if (normalized === "never") {
    return "never";
  }
  return "smart";
}

function parseTimeoutOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export function resolveConnectTimeoutMs(profileMode: BrowserProfileMode, env: NodeJS.ProcessEnv = process.env): number {
  const isolatedTimeoutMs = parseTimeoutOrDefault(env.CONNECT_OPERATION_TIMEOUT_MS, 25_000);
  const personalTimeoutMs = parseTimeoutOrDefault(env.CONNECT_OPERATION_TIMEOUT_MS_PERSONAL, 90_000);
  return profileMode === "personal" ? personalTimeoutMs : isolatedTimeoutMs;
}

export function resolveBrowserProfileConfig(env: NodeJS.ProcessEnv = process.env): BrowserProfileConfig {
  const homeDir = env.HOME ?? "/Users/richard";
  const defaultChromeUserDataDir = resolve(homeDir, "Library", "Application Support", "Google", "Chrome");
  const mode = env.BROWSER_PROFILE_MODE?.toLowerCase() === "personal" ? "personal" : "isolated";
  const fallbackRaw = env.PERSONAL_PROFILE_FALLBACK?.toLowerCase();
  const fallbackBehavior =
    fallbackRaw === "allow_isolated" || fallbackRaw === "allow" || fallbackRaw === "isolated"
      ? "allow_isolated"
      : fallbackRaw === "error"
        ? "error"
        : mode === "personal"
          ? "error"
          : "allow_isolated";
  const personalChromeUserDataDir = env.PERSONAL_CHROME_USER_DATA_DIR ?? defaultChromeUserDataDir;
  const configuredProfileDirectory = env.PERSONAL_CHROME_PROFILE_DIRECTORY ?? "Person 1";
  const profileDirectoryResolution = resolveChromeProfileDirectory(
    personalChromeUserDataDir,
    configuredProfileDirectory
  );
  const personalProfileMirrorRoot = env.PERSONAL_PROFILE_MIRROR_ROOT ?? resolve(dataDir, "profiles");
  const personalProfileSyncMode = resolvePersonalProfileSyncMode(env.PERSONAL_PROFILE_SYNC_MODE);

  return {
    mode,
    fallbackBehavior,
    personalProfileSyncMode,
    personalProfileMirrorRoot,
    personalChromeUserDataDir,
    personalChromeProfileDirectory: profileDirectoryResolution.profileDirectory,
    personalChromeProfileName: env.PERSONAL_CHROME_PROFILE_NAME ?? "",
    personalChromeProfileResolutionStrategy: profileDirectoryResolution.resolutionStrategy
  };
}

export function resolveRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    port: Number(env.RUNNER_PORT ?? 4001),
    openAiApiKey: env.OPENAI_API_KEY,
    // Default to gpt-5-nano: cheapest GPT-5 family member, sufficient for the
    // dashboard's short generations (summary, 3 reply drafts, classifier,
    // SHORTEN/MAKE_WARMER rewrites). Note nano accepts reasoning_effort
    // "minimal" (not "none" — that's gpt-5.4-only) and does NOT accept
    // top_p; ai.ts handles the param shape per model family. Override via
    // OPENAI_MODEL for accounts wanting more power: gpt-5.4-mini, gpt-5.4,
    // gpt-4o-mini, gpt-4o.
    openAiModel: env.OPENAI_MODEL ?? "gpt-5-nano",
    // AI_PROVIDER seeds the cold-start default. The dashboard /settings page
    // can override per-call without a restart (read from SettingsStore in
    // services/ai.ts -> resolveActive). "glm" routes through Z.AI's
    // OpenAI-compatible endpoint; "gemini" routes through Google's.
    aiProvider:
      env.AI_PROVIDER?.toLowerCase() === "glm"
        ? "glm"
        : env.AI_PROVIDER?.toLowerCase() === "gemini"
          ? "gemini"
          : "openai",
    zAiApiKey: env.Z_AI_API_KEY?.trim() || undefined,
    // Z.AI free-tier flash models are not listed in /v4/models but are
    // accessible at chat/completions. Default to glm-4.7-flash; override
    // via Z_AI_MODEL or the dashboard.
    zAiBaseUrl: env.Z_AI_BASE_URL?.trim() || "https://api.z.ai/api/paas/v4",
    glmModel: env.Z_AI_MODEL?.trim() || "glm-4.7-flash",
    // Google Gemini API. Default model is gemma-4-31b-it. The smoke test
    // (apps/runner/src/scripts/gemini-smoke.ts) confirmed Gemma 4 ships
    // with thinking traces ON by default, but Google's OpenAI-compat
    // endpoint accepts `extra_body.google.thinking_config.thinking_level`
    // = "MINIMAL" to suppress them. The runner spreads that flag at every
    // Gemma call site via `geminiExtraBody` in services/ai.ts. Operators
    // who want to use a Gemini model instead of Gemma can set
    // GEMINI_MODEL=gemini-3-flash-preview (also smoke-confirmed clean).
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    geminiBaseUrl:
      env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai/",
    geminiModel: env.GEMINI_MODEL?.trim() || "gemma-4-31b-it",
    linkedInUsername: env.LINKEDIN_USERNAME?.trim() || undefined,
    linkedInPassword: env.LINKEDIN_PASSWORD || undefined,
    linkedInAutoLoginEnabled:
      (env.LINKEDIN_AUTO_LOGIN ?? "").trim().toLowerCase() === "1" ||
      (env.LINKEDIN_AUTO_LOGIN ?? "").trim().toLowerCase() === "true",
    dbFile: resolve(dataDir, "inbox-os.sqlite"),
    profileDirs: {
      LINKEDIN: resolve(dataDir, "profiles", "linkedin"),
      INSTAGRAM: resolve(dataDir, "profiles", "instagram"),
      TIKTOK: resolve(dataDir, "profiles", "tiktok"),
      IMESSAGE: resolve(dataDir, "profiles", "imessage"),
      WHATSAPP: resolve(dataDir, "profiles", "whatsapp")
    },
    imessage: {
      // Mac-only adapter. Default off so Linux/CI runners don't try to open
      // a non-existent chat.db. Set IMESSAGE_ENABLED=true on a Mac with
      // Full Disk Access granted to the runner's parent process.
      enabled: env.IMESSAGE_ENABLED === "true" && process.platform === "darwin",
      dbPath: env.IMESSAGE_DB_PATH?.trim() || resolve(env.HOME ?? "/Users/richard", "Library", "Messages", "chat.db"),
      watchDebounceMs: parseIntOrDefault(env.IMESSAGE_WATCH_DEBOUNCE_MS, 500),
      contactsVcfPath: env.IMESSAGE_CONTACTS_VCF?.trim() || resolve(dataDir, "contacts.vcf")
    },
    screenshotDir: resolve(dataDir, "screenshots"),
    domDumpDir: resolve(dataDir, "dom_dumps"),
    selectorDir: resolve(projectRoot, "packages", "core", "selectors"),
    browserProfile: resolveBrowserProfileConfig(env),
    linkedInScan: {
      // Lowered from 200 → 50: 200 unread threads opened in one go is
      // a recruiter-tool volume signature. 50 is no longer in the
      // danger zone, but it's still on the high end of what a person
      // casually clicks through in one sitting — if your realistic
      // daily ceiling is 10-20, tune this down further.
      maxThreads: parseIntOrDefault(env.LINKEDIN_SCAN_MAX_THREADS, 50),
      stableIterations: parseIntOrDefault(env.LINKEDIN_SCAN_STABLE_ITERATIONS, 3),
      scrollWaitMs: parseIntOrDefault(env.LINKEDIN_SCAN_SCROLL_WAIT_MS, 1000),
      messageBackfillAttempts: parseIntOrDefault(env.LINKEDIN_SCAN_MESSAGE_BACKFILL_ATTEMPTS, 8)
    },
    enrichPaceMinMs: parseIntOrDefault(env.ENRICH_PACE_MIN_MS, 60_000),
    enrichPaceMaxMs: parseIntOrDefault(env.ENRICH_PACE_MAX_MS, 180_000),
    enrichBatchMax: parseIntOrDefault(env.ENRICH_BATCH_MAX, 6),
    // Lowered from 40 → 10: profile enrichment is the closest thing
    // we do to "scraping" — visiting strangers' profiles to lift their
    // posts/reactions. 40/day is a recruiter-tool footprint and the
    // most fingerprint-able activity in the app. 10/day is closer to
    // a real person clicking through to a few profiles a day.
    enrichDailyCap: parseIntOrDefault(env.ENRICH_DAILY_CAP, 10),
    enrichLongIdleEvery: parseIntOrDefault(env.ENRICH_LONG_IDLE_EVERY, 10),
    enrichLongIdleMinMs: parseIntOrDefault(env.ENRICH_LONG_IDLE_MIN_MS, 300_000),
    enrichLongIdleMaxMs: parseIntOrDefault(env.ENRICH_LONG_IDLE_MAX_MS, 900_000),
    enrichRefreshDays: parseIntOrDefault(env.ENRICH_REFRESH_DAYS, 30),
    pilotFeedback: {
      webhookUrl: env.PILOT_FEEDBACK_WEBHOOK_URL?.trim() || undefined,
      secret: env.PILOT_FEEDBACK_SECRET?.trim() || undefined,
      statusUrl: env.PILOT_FEEDBACK_STATUS_URL?.trim() || undefined
    }
  };
}

export const runnerConfig = resolveRunnerConfig();
