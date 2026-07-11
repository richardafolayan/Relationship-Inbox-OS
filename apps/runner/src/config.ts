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
  bindHost: string;
  openAiApiKey?: string;
  openAiModel: string;
  aiProvider: AiProvider;
  zAiApiKey?: string;
  zAiBaseUrl: string;
  glmModel: string;
  geminiApiKey?: string;
  geminiBaseUrl: string;
  geminiModel: string;
  /**
   * Update feed for the in-app updater: the URL of the published latest.json
   * (a Dropbox raw=1 / dl=1 link for the pilot). Read from RIOS_UPDATE_FEED_URL.
   * Undefined when unset, in which case /system/update-check reports the app as
   * up to date and the dashboard shows no update banner. Never hard-coded.
   */
  updateFeedUrl?: string;
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
  /** WhatsApp Web adapter config (#774). Off by default. */
  whatsapp: {
    enabled: boolean;
    mediaDir: string;
    send: { dailyCap: number; minIntervalMs: number };
  };
  imessage: {
    enabled: boolean;
    dbPath: string;
    /**
     * Debounce window for the chat.db filesystem watcher. SQLite writes a
     * burst of WAL/SHM events per message; we collapse them into one scan
     * enqueue. 200ms is enough to coalesce a single iMessage
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
  contacts: {
    /**
     * Sync contact birthdays from the macOS AddressBook into Person rows.
     * Mac-only (the AddressBook databases exist only on macOS); the reader
     * degrades to a no-op when Contacts data is absent or unreadable. On by
     * default on macOS; set CONTACTS_BIRTHDAY_SYNC=false to disable.
     */
    birthdaySyncEnabled: boolean;
  };
  audioTranscription: {
    /**
     * Master switch. Default false so the runner never starts an audio
     * transcription run (local or remote) without an explicit opt-in.
     * When false the scan-side enqueue path short-circuits before any
     * provider is consulted, mirroring how AI features are gated
     * elsewhere.
     */
    enabled: boolean;
    /**
     * Selects which transcription provider the runner uses.
     *   - "local-whisper": runs `whisper.cpp` locally via the
     *     `LOCAL_WHISPER_COMMAND` CLI. No OpenAI request is made. This
     *     is the near-zero-cost path for ongoing use.
     *   - "openai": uses the existing /v1/audio/transcriptions endpoint.
     *     Kept as an explicit fallback / quality-comparison option,
     *     never auto-used when local-whisper is selected.
     * Default is "local-whisper" so ongoing transcription is cost-
     * safe — the runner never spends OpenAI tokens unless the operator
     * explicitly sets AUDIO_TRANSCRIPTION_PROVIDER=openai. Unknown or
     * mis-spelled values also fall through to local-whisper.
     */
    provider: "openai" | "local-whisper" | "transformers";
    /**
     * OpenAI provider model. Default `gpt-4o-mini-transcribe`. Override
     * to `gpt-4o-transcribe` for higher accuracy at higher cost. Other
     * audio model ids accepted by /v1/audio/transcriptions also pass
     * through unchanged but are unsupported.
     */
    model: string;
    /**
     * Soft cap. Audio files larger than this are recorded as `skipped`
     * so the runner never streams a multi-hour file at OpenAI. Default
     * 25 MiB, matching the documented OpenAI request-size ceiling. Also
     * applies to local-whisper to keep a single, predictable cap.
     */
    maxBytes: number;
    /**
     * Duration cap in seconds. Applied only when the source attachment
     * exposes a duration (iMessage's chat.db does not, so this acts as
     * a second line of defence behind maxBytes). Default 600 (10 min).
     */
    maxSeconds: number;
    /**
     * BCP-47 language hint. Forwarded to OpenAI's endpoint or to
     * `whisper.cpp` (`-l`). Default `en`.
     */
    language: string;
    /**
     * transformers.js + ONNX local provider (the pilot default). Needs no
     * external binary or build tools; the ONNX model is downloaded into
     * `modelDir` on install and reused across app updates.
     */
    transformers: {
      /** transformers.js model id, e.g. "Xenova/whisper-base.en". */
      modelId: string;
      /** Absolute dir the model is cached in (under data/, survives updates). */
      modelDir: string;
      /** Per-call + model-load timeout in ms. */
      timeoutMs: number;
    };
    localWhisper: {
      /**
       * Path / name of the whisper.cpp CLI binary. Default `whisper-cli`
       * (the binary `make` produces in a vanilla whisper.cpp build);
       * point at an absolute path on systems where it isn't on PATH.
       */
      command: string;
      /**
       * Absolute path to the local whisper.cpp `ggml-*.bin` model file.
       * Empty when not configured; the runner short-circuits the
       * provider in that case so we never invoke whisper-cli with a
       * missing model. Used only when progressive mode is OFF — when
       * progressive is ON the per-tier `progressive.fast/standard/max`
       * model paths take over and this single path is ignored.
       */
      modelPath: string;
      /**
       * Per-call timeout. Default 120 seconds covers most iMessage
       * voice notes (typically under a minute of audio) without
       * letting the CLI hang the runner indefinitely.
       */
      timeoutMs: number;
      /**
       * Thread count passed to whisper.cpp's `-t`. Default 4.
       */
      threads: number;
      /**
       * Extra CLI arguments appended verbatim. Operators can use this
       * to flip non-default whisper.cpp options without code changes.
       * Parsed with whitespace as a separator; no shell interpretation.
       */
      extraArgs: string[];
    };
    /**
     * Progressive (multi-tier) local-whisper mode. When `enabled` is
     * true the runner runs three local Whisper models in sequence per
     * voice note — fast, then standard, then max — so a transcript
     * appears quickly and improves silently in the background. Each
     * tier writes its own attempt row in
     * `MessageAudioTranscriptionAttempt` so we can always inspect the
     * raw output of every model; the selected text on the parent
     * `MessageAudioTranscription.transcript` always reflects the best
     * valid attempt under the never-downgrade rule.
     *
     * Default `enabled=true` only when at least one tier path is
     * configured AND the master `enabled` switch is on; missing tier
     * paths are skipped without failing the run. When all three paths
     * are blank the runner falls back to the single-model
     * `localWhisper.modelPath` shape so existing installs keep
     * working unchanged.
     */
    progressive: {
      enabled: boolean;
      /** small.en model path — first transcript shown to the user. */
      fastModelPath: string;
      /** large-v3-turbo-q5_0 model path — the standard "good" pass. */
      standardModelPath: string;
      /** large-v3 model path — best local quality, slowest. */
      maxModelPath: string;
    };
    /**
     * Optional GPT-5-nano text refinement. Receives the local model
     * attempts (text only — never the audio bytes) plus nearby thread
     * messages and asks the chat model to correct likely ASR errors.
     * Cost-safe: off by default, only invoked after at least the
     * `standard` tier has succeeded, and never on threads where no
     * local transcript exists. Output is post-parse sanitised so a
     * runaway refinement can't overwrite a good local transcript with
     * gibberish.
     */
    refinement: {
      enabled: boolean;
      /** Chat model id. Default `gpt-5-nano`. */
      model: string;
      /**
       * Max number of nearby thread messages (each direction) shipped
       * to the refiner as conversation context. Default 8 either side.
       * Capped low because GPT-5-nano is cheap-but-not-free and most
       * useful context lives in the immediately adjacent turns.
       */
      maxContextMessages: number;
      /** Per-call wall-clock budget. Default 30 seconds. */
      timeoutMs: number;
    };
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
  /**
   * GitHub integration for the pilot-feedback flow. When `token` and
   * `repo` are set, the runner auto-attaches each screenshot to the
   * GitHub issue the Apps Script creates (uploads to repo/pilot-
   * feedback-attachments/ then posts an issue comment with inline
   * image refs). Without these, the Drive-linked Sheet row remains
   * the only screenshot surface. Best-effort; webhook succeeds
   * regardless.
   */
  github: {
    token?: string;
    repo: string;
    attachmentsBranch: string;
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

/**
 * Normalise the runner's DATABASE_URL to an absolute SQLite `file:` URL.
 *
 * Prisma resolves a *relative* `file:` path in DATABASE_URL against the
 * schema directory (packages/core/prisma/), NOT the project root — so the
 * `DATABASE_URL=file:./data/inbox-os.sqlite` shipped in .env.example points
 * the runner at packages/core/prisma/data/inbox-os.sqlite, a different
 * (empty) database from the one `npm run db:push` writes to: that script
 * overrides DATABASE_URL with an absolute `file:$(pwd)/data/...` path. A
 * student who copies .env.example verbatim then sees an empty inbox even
 * though the scan wrote rows — the two halves were looking at two files.
 *
 * Collapse the ambiguity here, once, before the Prisma client is built:
 *   - unset / blank  → the absolute dbFile (resolve(dataDir, ...)).
 *   - relative file: → resolved against the project root.
 *   - absolute file: → trusted as-is.
 *   - any non-file:  → trusted as-is (e.g. a remote libsql/turso URL).
 */
export function resolveDatabaseUrl(
  rawUrl: string | undefined,
  rootDir: string,
  absoluteDbFile: string
): string {
  const trimmed = rawUrl?.trim();
  if (!trimmed) {
    return `file:${absoluteDbFile}`;
  }
  const filePrefix = "file:";
  if (!trimmed.startsWith(filePrefix)) {
    return trimmed;
  }
  const path = trimmed.slice(filePrefix.length);
  // file:/abs, file:///abs — already absolute, trust it.
  if (path.startsWith("/")) {
    return trimmed;
  }
  // file:./data/... or file:data/... or file:../data/... — relative, and
  // therefore schema-dir-relative under Prisma. Re-anchor on the project
  // root so the runner and db:push always agree on a single database file.
  const normalizedRelative = path.replace(/^\.\//, "");
  return `file:${resolve(rootDir, normalizedRelative)}`;
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
    port: parseIntOrDefault(env.RUNNER_PORT, 4001),
    bindHost: env.RUNNER_HOST?.trim() || "127.0.0.1",
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
    // Gemini is the cold-start default (2026-07-04, PM-confirmed): its
    // summaries read clearly better than gpt-5-nano's in side-by-side use,
    // and pilots should get that quality out of the box. Runtime failures
    // still fall back to OpenAI, and pickActiveProvider falls back by key
    // presence, so an install with only an OPENAI_API_KEY keeps working.
    aiProvider:
      env.AI_PROVIDER?.toLowerCase() === "glm"
        ? "glm"
        : env.AI_PROVIDER?.toLowerCase() === "openai"
          ? "openai"
          : "gemini",
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
    // gemma-4-31b-it: Richard's explicit call (2026-07-04) — the gemini
    // provider defaults to the FREE-tier Gemma family, never the
    // Gemini-branded models. The Gemini flash models (2.5/3/3.5) sit in
    // ~20-request free-tier quota buckets, so sustained traffic silently
    // runs on the OpenAI fallback and the operator gets nano output while
    // believing they are on Gemini. Gemma's free quota is generous enough
    // for real app traffic. Quality note: Gemma is weaker than Gemini
    // flash on hard attribution/recency threads — the fidelity disciplines
    // in services/ai.ts carry more of the load. Smoke-check via
    // apps/runner/src/scripts/gemini-smoke.ts.
    geminiModel: env.GEMINI_MODEL?.trim() || "gemma-4-31b-it",
    // Update feed (published latest.json URL). Never hard-coded; the pilot
    // sets the Dropbox raw=1 link as RIOS_UPDATE_FEED_URL.
    updateFeedUrl: env.RIOS_UPDATE_FEED_URL?.trim() || undefined,
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
    whatsapp: {
      // WhatsApp Web adapter via whatsapp-web.js (#774). OFF by default: it
      // spins up its own headless Chromium and needs a one-time QR scan, so
      // it must never boot for pilots who haven't opted in. Set
      // WHATSAPP_ENABLED=true to turn it on, then connect via Settings.
      enabled: (env.WHATSAPP_ENABLED ?? "").trim().toLowerCase() === "true",
      mediaDir: resolve(dataDir, "whatsapp-media"),
      // Send guard: cap outbound volume + minimum spacing so an automation
      // bug can't blast a WhatsApp number (ban-sensitive). Conservative
      // defaults, overridable via env.
      send: {
        dailyCap: parseIntOrDefault(env.WHATSAPP_MAX_PER_DAY, 40),
        minIntervalMs: parseIntOrDefault(env.WHATSAPP_MIN_INTERVAL_MS, 15_000)
      }
    },
    imessage: {
      // Mac-only adapter. Default off so Linux/CI runners don't try to open
      // a non-existent chat.db. Set IMESSAGE_ENABLED=true on a Mac with
      // Full Disk Access granted to the runner's parent process.
      enabled: (env.IMESSAGE_ENABLED ?? "").trim().toLowerCase() === "true" && process.platform === "darwin",
      dbPath: env.IMESSAGE_DB_PATH?.trim() || resolve(env.HOME ?? "/Users/richard", "Library", "Messages", "chat.db"),
      watchDebounceMs: parseIntOrDefault(env.IMESSAGE_WATCH_DEBOUNCE_MS, 200),
      contactsVcfPath: env.IMESSAGE_CONTACTS_VCF?.trim() || resolve(dataDir, "contacts.vcf")
    },
    contacts: {
      // Mac-only. Enabled by default on macOS; the AddressBook reader is a
      // no-op when Contacts data is missing or unreadable, so leaving it on
      // is safe. Disable explicitly with CONTACTS_BIRTHDAY_SYNC=false.
      birthdaySyncEnabled:
        process.platform === "darwin" &&
        !["false", "0", "no", "off"].includes(
          (env.CONTACTS_BIRTHDAY_SYNC ?? "").trim().toLowerCase()
        )
    },
    audioTranscription: {
      // Off by default. The runner never starts a transcription run
      // (local or remote) unless this is flipped on; the service also
      // skips safely when the active provider is mis-configured, so a
      // wrong env doesn't crash ingestion.
      enabled:
        (env.AUDIO_TRANSCRIPTION_ENABLED ?? "").trim().toLowerCase() === "true",
      // Provider options:
      //   - "transformers": local transformers.js + ONNX (the pilot
      //     default in .env.example). No external binary or build tools;
      //     the model is downloaded into data/models on install.
      //   - "local-whisper": whisper.cpp CLI (advanced — needs a
      //     separately built binary + ggml model).
      //   - "openai": /v1/audio/transcriptions (paid; explicit opt-in).
      // The CODE default stays `local-whisper` so the cost-safe path is
      // chosen when the var is unset/mis-spelled; pilots get
      // `transformers` from .env.example.
      provider: ((): "openai" | "local-whisper" | "transformers" => {
        const value = env.AUDIO_TRANSCRIPTION_PROVIDER?.trim().toLowerCase();
        if (value === "openai") return "openai";
        if (value === "transformers") return "transformers";
        return "local-whisper";
      })(),
      // Default to gpt-4o-mini-transcribe: the cheaper, sufficiently
      // accurate OpenAI transcription model. Operators wanting higher
      // quality can set AUDIO_TRANSCRIPTION_MODEL=gpt-4o-transcribe.
      // Realtime / streaming models (gpt-realtime-whisper) are not used
      // for stored voice notes; see the audio transcription section of
      // docs/reference.md.
      model: env.AUDIO_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe",
      maxBytes: parseIntOrDefault(env.AUDIO_TRANSCRIPTION_MAX_BYTES, 25 * 1024 * 1024),
      maxSeconds: parseIntOrDefault(env.AUDIO_TRANSCRIPTION_MAX_SECONDS, 600),
      language: env.AUDIO_TRANSCRIPTION_LANGUAGE?.trim() || "en",
      localWhisper: {
        command: env.LOCAL_WHISPER_COMMAND?.trim() || "whisper-cli",
        modelPath: env.LOCAL_WHISPER_MODEL_PATH?.trim() || "",
        timeoutMs: parseIntOrDefault(env.LOCAL_WHISPER_TIMEOUT_MS, 120_000),
        threads: parseIntOrDefault(env.LOCAL_WHISPER_THREADS, 4),
        // Whitespace-separated extra args. No shell interpretation —
        // the local provider spawns whisper.cpp directly, so each
        // token is a literal argv entry.
        extraArgs: (env.LOCAL_WHISPER_EXTRA_ARGS ?? "")
          .trim()
          .split(/\s+/)
          .filter((arg) => arg.length > 0)
      },
      // transformers.js + ONNX local provider (the pilot default). No
      // external binary; the model is downloaded into `modelDir` on
      // install. `modelDir` lives under data/ so it survives app updates.
      transformers: {
        modelId: env.AUDIO_TRANSCRIPTION_LOCAL_MODEL?.trim() || "Xenova/whisper-base.en",
        modelDir: env.TRANSCRIPTION_MODEL_DIR?.trim() || resolve(dataDir, "models"),
        timeoutMs: parseIntOrDefault(env.AUDIO_TRANSCRIPTION_LOCAL_TIMEOUT_MS, 120_000)
      },
      progressive: (() => {
        // Auto-enable progressive mode when the operator has set at
        // least one tier path AND not explicitly disabled it. Empty
        // tier paths fall through safely — the orchestrator only
        // schedules tiers whose model path is configured.
        const explicit = (env.AUDIO_TRANSCRIPTION_PROGRESSIVE_MODE ?? "")
          .trim()
          .toLowerCase();
        const fastModelPath = env.AUDIO_TRANSCRIPTION_FAST_MODEL_PATH?.trim() || "";
        const standardModelPath =
          env.AUDIO_TRANSCRIPTION_STANDARD_MODEL_PATH?.trim() || "";
        const maxModelPath = env.AUDIO_TRANSCRIPTION_MAX_MODEL_PATH?.trim() || "";
        const anyConfigured =
          fastModelPath !== "" || standardModelPath !== "" || maxModelPath !== "";
        const enabled =
          explicit === "true"
            ? true
            : explicit === "false"
              ? false
              : anyConfigured;
        return {
          enabled,
          fastModelPath,
          standardModelPath,
          maxModelPath
        };
      })(),
      refinement: {
        // Default off in code so the runner never spends OpenAI text
        // tokens unless the operator opts in. When on, the refiner
        // only fires after at least the standard local tier has
        // succeeded — see transcription-service progressive logic.
        enabled:
          (env.AUDIO_TRANSCRIPTION_REFINEMENT_ENABLED ?? "").trim().toLowerCase() === "true",
        model: env.AUDIO_TRANSCRIPTION_REFINEMENT_MODEL?.trim() || "gpt-5-nano",
        maxContextMessages: parseIntOrDefault(
          env.AUDIO_TRANSCRIPTION_REFINEMENT_MAX_CONTEXT_MESSAGES,
          8
        ),
        timeoutMs: parseIntOrDefault(env.AUDIO_TRANSCRIPTION_REFINEMENT_TIMEOUT_MS, 30_000)
      }
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
    },
    // GitHub integration for the pilot-feedback flow. When both are
    // set, the runner auto-attaches screenshots to the GitHub issue
    // the Apps Script creates (uploads to repo /pilot-feedback-
    // attachments/, then posts an issue comment with inline image
    // refs). Without these, the Apps Script's Sheet row + Drive link
    // is the only screenshot surface. See services/github-attachments.ts.
    github: {
      // PAT with `repo` scope. Falls back to GH_TOKEN to match the
      // gh CLI's env convention so operators can reuse the same token.
      token: env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim() || undefined,
      // "owner/name" — defaults to the project's main repo if unset.
      repo: env.GITHUB_REPO?.trim() || "richardafolayan/Relationship-Inbox-OS",
      // Where to commit the screenshot file. Defaults to the v1
      // integration branch; operators can pin a different branch
      // (e.g. "main" once v1 lands) without touching code.
      attachmentsBranch: env.GITHUB_ATTACHMENTS_BRANCH?.trim() || "v1/strip-back-pr1"
    }
  };
}

export const runnerConfig = resolveRunnerConfig();
