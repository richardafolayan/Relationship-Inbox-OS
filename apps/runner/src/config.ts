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

export type AiProvider = "openai" | "glm";

export interface RunnerConfig {
  port: number;
  openAiApiKey?: string;
  openAiModel: string;
  aiProvider: AiProvider;
  zAiApiKey?: string;
  zAiBaseUrl: string;
  glmModel: string;
  dbFile: string;
  profileDirs: {
    LINKEDIN: string;
    INSTAGRAM: string;
    TIKTOK: string;
    IMESSAGE: string;
  };
  imessage: {
    enabled: boolean;
    dbPath: string;
    pollMs: number;
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
  linkedInScan: {
    maxThreads: number;
    stableIterations: number;
    scrollWaitMs: number;
    messageBackfillAttempts: number;
  };
  /**
   * Min ms between LinkedIn profile-enrichment visits. Default 30s.
   * Tunable up only after observation, never down — see Phase 2 brief.
   */
  enrichPaceMs: number;
  /** Max enrichment jobs processed per drain pass. Default 30. */
  enrichBatchMax: number;
  /** Days before an enriched profile is considered stale. Default 30. */
  enrichRefreshDays: number;
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
    personalChromeProfileName: env.PERSONAL_CHROME_PROFILE_NAME ?? "Richard Afolayan",
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
    // OpenAI-compatible endpoint.
    aiProvider: env.AI_PROVIDER?.toLowerCase() === "glm" ? "glm" : "openai",
    zAiApiKey: env.Z_AI_API_KEY?.trim() || undefined,
    // Z.AI free-tier flash models are not listed in /v4/models but are
    // accessible at chat/completions. Default to glm-4.7-flash; override
    // via Z_AI_MODEL or the dashboard.
    zAiBaseUrl: env.Z_AI_BASE_URL?.trim() || "https://api.z.ai/api/paas/v4",
    glmModel: env.Z_AI_MODEL?.trim() || "glm-4.7-flash",
    linkedInUsername: env.LINKEDIN_USERNAME?.trim() || undefined,
    linkedInPassword: env.LINKEDIN_PASSWORD || undefined,
    dbFile: resolve(dataDir, "inbox-os.sqlite"),
    profileDirs: {
      LINKEDIN: resolve(dataDir, "profiles", "linkedin"),
      INSTAGRAM: resolve(dataDir, "profiles", "instagram"),
      TIKTOK: resolve(dataDir, "profiles", "tiktok"),
      IMESSAGE: resolve(dataDir, "profiles", "imessage")
    },
    imessage: {
      // Mac-only adapter. Default off so Linux/CI runners don't try to open
      // a non-existent chat.db. Set IMESSAGE_ENABLED=true on a Mac with
      // Full Disk Access granted to the runner's parent process.
      enabled: env.IMESSAGE_ENABLED === "true" && process.platform === "darwin",
      dbPath: env.IMESSAGE_DB_PATH?.trim() || resolve(env.HOME ?? "/Users/richard", "Library", "Messages", "chat.db"),
      pollMs: parseIntOrDefault(env.IMESSAGE_POLL_MS, 5_000),
      contactsVcfPath: env.IMESSAGE_CONTACTS_VCF?.trim() || resolve(dataDir, "contacts.vcf")
    },
    screenshotDir: resolve(dataDir, "screenshots"),
    domDumpDir: resolve(dataDir, "dom_dumps"),
    selectorDir: resolve(projectRoot, "packages", "core", "selectors"),
    browserProfile: resolveBrowserProfileConfig(env),
    linkedInScan: {
      maxThreads: parseIntOrDefault(env.LINKEDIN_SCAN_MAX_THREADS, 200),
      stableIterations: parseIntOrDefault(env.LINKEDIN_SCAN_STABLE_ITERATIONS, 3),
      scrollWaitMs: parseIntOrDefault(env.LINKEDIN_SCAN_SCROLL_WAIT_MS, 1000),
      messageBackfillAttempts: parseIntOrDefault(env.LINKEDIN_SCAN_MESSAGE_BACKFILL_ATTEMPTS, 8)
    },
    enrichPaceMs: parseIntOrDefault(env.ENRICH_PACE_MS, 30_000),
    enrichBatchMax: parseIntOrDefault(env.ENRICH_BATCH_MAX, 30),
    enrichRefreshDays: parseIntOrDefault(env.ENRICH_REFRESH_DAYS, 30)
  };
}

export const runnerConfig = resolveRunnerConfig();
