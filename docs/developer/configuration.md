# Configuration and environment variables

The root `.env` is loaded by the source launchers and runner. Copy
`.env.example` for a new source install. Do not commit `.env`, release
credentials, API keys, or private feed URLs.

Configuration has three layers:

1. environment values set process, provider, integration, and distribution
   behavior;
2. the SQLite `app_settings` row stores live UI choices such as provider,
   model override, headless mode, scan interval, and enabled platforms;
3. browser local storage holds client-only choices such as whether the user
   has turned auto-scan on.

Persisted Settings wins where a field exists. API keys and provider clients
are created at runner startup, so key changes require a restart.

## Runtime and database

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | absolute `file:<root>/data/inbox-os.sqlite` | Prisma database. Relative `file:` paths are re-anchored to root. |
| `RUNNER_PORT` | `4001` | Express port. |
| `RUNNER_HOST` | `127.0.0.1` | Express bind host. Keep loopback unless adding independent authentication and TLS. |
| `DASHBOARD_PORT` | `3100` | Next.js and desktop dashboard port. |
| `RUNNER_ORIGIN` | `http://127.0.0.1:<RUNNER_PORT>` | Dashboard server-side runner proxy override. |
| `NODE_ENV` | set by the command | Production/development gates. |
| `APP_COMMIT` | empty | Optional build commit reported by system version. |

## AI providers

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_PROVIDER` | config fallback `gemini` | Cold configuration fallback. The persisted `app_settings.aiProvider` wins; a new settings row currently seeds `openai`. |
| `OPENAI_API_KEY` | empty | Creates the OpenAI client and also supports explicit OpenAI transcription/refinement. |
| `OPENAI_MODEL` | `gpt-5-nano` | OpenAI chat model. |
| `GEMINI_API_KEY` | empty | Creates the Gemini API client. |
| `GEMINI_BASE_URL` | Google OpenAI-compatible v1beta URL | Gemini API endpoint. |
| `GEMINI_MODEL` | `gemma-4-31b-it` | Gemini-provider chat model; persisted Settings can override it. |
| `GEMINI_FALLBACK_MODEL` | `gemini-3-flash-preview` in smoke script only | Secondary model used by the standalone Gemini smoke command, not normal routing. |
| `Z_AI_API_KEY` | empty | Creates the Z.AI GLM client. |
| `Z_AI_BASE_URL` | `https://api.z.ai/api/paas/v4` | Z.AI OpenAI-compatible endpoint. |
| `Z_AI_MODEL` | `glm-4.7-flash` | GLM chat model; persisted Settings can override it. |

See [AI processing](ai.md) for effective-provider selection, retries, runtime
fallback, racing, and voice controls.

## Audio transcription

| Variable | Default in code / pilot example | Purpose |
| --- | --- | --- |
| `AUDIO_TRANSCRIPTION_ENABLED` | code `false` / example `true` | Master gate. |
| `AUDIO_TRANSCRIPTION_PROVIDER` | code `local-whisper` / example `transformers` | `transformers`, `local-whisper`, or explicit `openai`. Unknown values fall to local Whisper. |
| `AUDIO_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | OpenAI audio model. |
| `AUDIO_TRANSCRIPTION_MAX_BYTES` | `26214400` | Per-file cap for all providers. |
| `AUDIO_TRANSCRIPTION_MAX_SECONDS` | `600` | Duration cap when metadata exists. |
| `AUDIO_TRANSCRIPTION_LANGUAGE` | `en` | Provider language hint. |
| `AUDIO_TRANSCRIPTION_LOCAL_MODEL` | `Xenova/whisper-base.en` | Transformers model ID. |
| `TRANSCRIPTION_MODEL_DIR` | `data/models` | Transformers cache directory. |
| `AUDIO_TRANSCRIPTION_LOCAL_TIMEOUT_MS` | `120000` | Transformers load/call timeout. |
| `LOCAL_WHISPER_COMMAND` | `whisper-cli` | Whisper.cpp executable. |
| `LOCAL_WHISPER_MODEL_PATH` | empty | Single-model ggml path when progressive mode is off. |
| `LOCAL_WHISPER_THREADS` | `4` | Whisper.cpp thread count. |
| `LOCAL_WHISPER_TIMEOUT_MS` | `120000` | Whisper.cpp call timeout. |
| `LOCAL_WHISPER_EXTRA_ARGS` | empty | Whitespace-separated literal argv, no shell evaluation. |
| `AUDIO_TRANSCRIPTION_PROGRESSIVE_MODE` | auto when a tier path exists | Explicit `true`/`false` override for tiered local Whisper. |
| `AUDIO_TRANSCRIPTION_FAST_MODEL_PATH` | empty | Fast-tier model. |
| `AUDIO_TRANSCRIPTION_STANDARD_MODEL_PATH` | empty | Standard-tier model. |
| `AUDIO_TRANSCRIPTION_MAX_MODEL_PATH` | empty | Max-tier model. |
| `AUDIO_TRANSCRIPTION_REFINEMENT_ENABLED` | `false` | Optional OpenAI text refinement after a standard local result. |
| `AUDIO_TRANSCRIPTION_REFINEMENT_MODEL` | `gpt-5-nano` | Refinement chat model. |
| `AUDIO_TRANSCRIPTION_REFINEMENT_MAX_CONTEXT_MESSAGES` | `8` | Nearby messages supplied on each side. |
| `AUDIO_TRANSCRIPTION_REFINEMENT_TIMEOUT_MS` | `30000` | Refiner wall-clock budget. |

## Browser profiles and platform access

| Variable | Default | Purpose |
| --- | --- | --- |
| `BROWSER_PROFILE_MODE` | `isolated` in code / `personal` in example | Browser mode for managed LinkedIn, Google Messages, and Instagram sessions. Every platform still launches an app-owned profile. |
| `PERSONAL_PROFILE_FALLBACK` | `error` in personal mode | `error` or `allow_isolated` when mirror launch cannot proceed. |
| `PERSONAL_PROFILE_SYNC_MODE` | `smart` | `smart`, `always`, `once`, or `never` mirror refresh. Instagram uses seed-once behavior in personal mode so restarts preserve later manual sign-ins. |
| `PERSONAL_PROFILE_MIRROR_ROOT` | `data/profiles` | Mirror storage root. |
| `PERSONAL_CHROME_USER_DATA_DIR` | Chrome Application Support path | Source Chrome user-data directory. |
| `PERSONAL_CHROME_PROFILE_DIRECTORY` | `Person 1` | Directory or display name resolved through Chrome Local State. |
| `PERSONAL_CHROME_PROFILE_NAME` | empty | Optional profile-name hint. |
| `CONNECT_OPERATION_TIMEOUT_MS` | `25000` | Isolated connection timeout. |
| `CONNECT_OPERATION_TIMEOUT_MS_PERSONAL` | `90000` | Personal mirror and interactive Instagram connection timeout. |
| `RIOS_VISIBLE_BROWSER_LAUNCH` | off | Debug option to bring a runner browser launch visibly onscreen. |
| `INSTAGRAM_ENABLED` | `false` | Enables the dedicated Instagram profile, setup choice, scans, and manual text sending. |
| `IMESSAGE_ENABLED` | off in code, true in pilot example on macOS | Gates iMessage boot probe, watcher, attachments, and related services. |
| `IMESSAGE_DB_PATH` | `~/Library/Messages/chat.db` | Messages database override. |
| `IMESSAGE_WATCH_DEBOUNCE_MS` | `500` | Filesystem event debounce. |
| `IMESSAGE_CONTACTS_VCF` | `data/contacts.vcf` | Optional contact override vCard. |
| `CONTACTS_BIRTHDAY_SYNC` | enabled on macOS | Set false/0/no/off to disable birthday sync. |
| `WHATSAPP_ENABLED` | `false` | Constructs the real opt-in adapter. |
| `WHATSAPP_MAX_PER_DAY` | `40` | Rolling send cap. |
| `WHATSAPP_MIN_INTERVAL_MS` | `15000` | Per-recipient send spacing. |

WhatsApp's own Puppeteer is always headless in the verified adapter and does
not read the persisted dashboard headless toggle.

Instagram is opt-in and keeps its session in `data/profiles/instagram`. It
always requests the installed stable Chrome channel and never falls back to
Chrome for Testing. In personal mode, the dedicated Instagram profile is
seeded once from the configured Chrome profile so its established cookies and
device history can be reused. On macOS, the runner uses the same local
Keychain-backed cookie bridge as LinkedIn because copied Chrome cookies remain
encrypted. Cookie values stay in memory and are never logged. The runner never
controls or deletes the live source profile.
Missing, blank, false, or unrecognised `INSTAGRAM_ENABLED` values leave it
disabled. Login and any Instagram security check happen manually in the
runner-controlled browser. Resetting Instagram clears only the app-owned copy and
does not sign LinkedIn or Google Messages out.

## LinkedIn scanning and enrichment

| Variable | Default | Purpose |
| --- | --- | --- |
| `LINKEDIN_SCAN_MAX_THREADS` | `50` | Maximum list candidates for a normal scan. |
| `LINKEDIN_SCAN_STABLE_ITERATIONS` | `3` | Stable-list iterations before stopping discovery. |
| `LINKEDIN_SCAN_SCROLL_WAIT_MS` | `1000` | Inbox scroll settle time. |
| `LINKEDIN_SCAN_MESSAGE_BACKFILL_ATTEMPTS` | `8` | Attempts to load older thread messages. |
| `LINKEDIN_UNCHANGED_STREAK_LIMIT` | `5` | Update-scan consecutive unchanged-row stop threshold. |
| `LINKEDIN_USERNAME`, `LINKEDIN_PASSWORD` | empty | Optional fallback credentials. |
| `LINKEDIN_AUTO_LOGIN` | off | Required opt-in before fallback credentials can fill the form. |
| `ENRICH_AUTO_ENABLED` | off | Enables automatic enrichment queue recovery, first-seen work, and periodic tick. Manual enrichment remains available. |
| `ENRICH_DAILY_CAP` | `10` | Rolling profile visit cap. |
| `ENRICH_BATCH_MAX` | `6` | Jobs per drain pass. |
| `ENRICH_REFRESH_DAYS` | `30` | Staleness threshold. |
| `ENRICH_PACE_MIN_MS` | `60000` | Random pacing lower bound. |
| `ENRICH_PACE_MAX_MS` | `180000` | Random pacing upper bound. |
| `ENRICH_LONG_IDLE_EVERY` | `10` | Visits between longer pauses. |
| `ENRICH_LONG_IDLE_MIN_MS` | `300000` | Long-pause lower bound. |
| `ENRICH_LONG_IDLE_MAX_MS` | `900000` | Long-pause upper bound. |

`ENRICH_PACE_MS` remains in `.env.example` but is not read by the current
runner. Use the min/max variables above. Do not claim the legacy key changes
behavior.

## Development scan and dashboard gates

| Variable | Default | Purpose |
| --- | --- | --- |
| `LINKEDIN_DEV_SCAN_MAX_THREADS` | unset | Development-only scan cap. |
| `LINKEDIN_DEV_SCAN_MAX_OPENS` | unset | Development-only open cap. |
| `LINKEDIN_DEV_SCAN_DISABLE_DEEP_SCROLL` | false | Development-only discovery limit. |
| `LINKEDIN_DEV_DISABLE_AUTOSCAN` | true in runner development | Disables the runner scheduler in development. |
| `LINKEDIN_DEV_LOG_STAGE_HEADLINES` | true in development | Console stage headlines. |
| `ENABLE_SCAN_FALLBACK` | true in development | Runner fallback scan gate. |
| `NEXT_PUBLIC_DISABLE_AUTOSCAN` | unset | Truthy disables dashboard auto-scan; `0` explicitly allows it. |
| `NEXT_PUBLIC_LINKEDIN_DEV_DISABLE_AUTOSCAN` | unset | Legacy dashboard-side disable gate. |
| `NEXT_PUBLIC_AUTO_SCAN_HOUR_START` | `8` | Dashboard local active-window start. |
| `NEXT_PUBLIC_AUTO_SCAN_HOUR_END` | `19` | Active-window end, exclusive. |
| `NEXT_PUBLIC_AUTO_SCAN_WEEKENDS` | off | Enables weekend dashboard auto-scan when truthy. |

`NEXT_PUBLIC_ENABLE_SCAN_FALLBACK` remains in `.env.example` but the current
runner reads `ENABLE_SCAN_FALLBACK`. The public-prefixed key is a no-op in the
verified baseline.

## Feedback and optional GitHub attachment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PILOT_FEEDBACK_WEBHOOK_URL` | empty | Server-side feedback destination. |
| `PILOT_FEEDBACK_SECRET` | empty | Low-value distributed webhook token. |
| `PILOT_FEEDBACK_STATUS_URL` | empty | Safe recent-report status read. |
| `NEXT_PUBLIC_FEEDBACK_FORM_URL` | empty | Browser-visible fallback form. |
| `NEXT_PUBLIC_APP_VERSION` | package version in releases | Safe version stamped into reports. |
| `GITHUB_TOKEN`, `GH_TOKEN` | empty | Optional screenshot attachment credential, checked in that order before local `gh` fallback. |
| `GITHUB_REPO` | project repository | Attachment target `owner/name`. |
| `GITHUB_ATTACHMENTS_BRANCH` | `develop` | Attachment commit branch. |

The feedback token ships to pilot machines and is not a high-value secret.
AI, Dropbox, and GitHub credentials must never be baked into the release.

## Diagnostics and guarded maintenance

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEV_LOG` | example `1` | Enables development/smoke logging. |
| `DEV_LOG_PII` | `0` | Explicit PII logging gate. Keep off for normal use. |
| `RUN_TRACE` | off | Enables structured scan run artifacts. |
| `RUN_TRACE_DIR` | `./logs/runs` relative to runner cwd | Trace output override. |
| `RUN_TRACE_PII` | off | Explicit trace PII gate. |
| `ADMIN_RESET_ENABLED` | off | Enables destructive admin reset only with the remaining guards. |
| `ADMIN_RESET_TOKEN` | empty | Required token for reset route/script. |
| `OPERATOR_PROFILE_SEED_FILE` | example seed path | Private local seed override. |

## Source install, desktop, update, and release

| Variable | Default | Purpose |
| --- | --- | --- |
| `RIOS_INSTALL_DIR` | `~/RelationshipInboxOS` | Source installer/uninstaller target. |
| `RIOS_APP_ZIP_URL` | placeholder | Private installer download source. |
| `RIOS_OPENAI_API_KEY` | empty | Optional installer-only OpenAI key prefill. |
| `RIOS_NO_START` | off | Install without starting. |
| `RIOS_NO_APP_BUNDLE` | off | Skip lightweight `.app` creation. |
| `RIOS_APP_BUNDLE_DIR` | `~/Applications` | Lightweight bundle/update helper location. |
| `RIOS_NODE_DIR` | `~/.rios-node` | App-managed Node directory. |
| `RIOS_NODE_PATH` | auto candidates | Explicit desktop/source launcher Node executable. |
| `RIOS_DEV` | off | Force source launcher development mode. |
| `RIOS_REBUILD` | off | Ignore preparation stamps. |
| `RIOS_CONFIG_DIR`, `RIOS_DATA_DIR`, `RIOS_STATE_DIR` | project paths for source; macOS user directories when packaged | Launcher-owned path overrides that keep packaged writes outside the signed bundle. Set them manually only for isolated testing. |
| `RIOS_DESKTOP`, `RIOS_PACKAGED_APP`, `RIOS_RECLAIM_EXISTING` | launcher-owned | Internal desktop/lifecycle flags. Do not add them to normal `.env` configuration. |
| `RIOS_UPDATE_FEED_URL` | empty in source, injected in pilot release | HTTPS `latest.json` feed. |
| `RIOS_CODESIGN_IDENTITY` | ad-hoc `-` when absent | DMG app signing identity. No notarization is performed. |
| `RIOS_RELEASE_ENV_FILE` | `.env.release.local` | Gitignored local release configuration. |
| `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` | required for publish | Preferred Dropbox OAuth refresh flow. |
| `DROPBOX_ACCESS_TOKEN` | optional | Direct short-lived token fallback. |
| `RIOS_DROPBOX_ZIP_PATH`, `RIOS_DROPBOX_MANIFEST_PATH` | required for publish | Stable overwrite destinations. |
| `RIOS_DROPBOX_ZIP_URL`, `RIOS_UPDATE_FEED_URL` | required for publish | Stable public ZIP and manifest URLs. |
| `RIOS_DROPBOX_API_BASE`, `RIOS_DROPBOX_CONTENT_BASE` | Dropbox endpoints | Test/advanced endpoint override. |
| `RIOS_PUBLISH_VERIFY_RETRIES` | `5` | Live artifact verification attempts. |
| `RIOS_PUBLISH_VERIFY_DELAY_MS` | `3000` | Delay between verification attempts. |

## Safe configuration workflow

1. Edit only the installation's `.env` for machine-local values.
2. Restart the runner after changing keys, database, ports, profile, iMessage,
   WhatsApp, or transcription configuration.
3. Use Settings for supported live provider/model/headless/platform choices.
4. Run `npm run doctor` and query `/data/ai-status` or `/data/platforms` as
   appropriate.
5. Keep `DEV_LOG_PII` and `RUN_TRACE_PII` off unless diagnosing a private local
   case, and remove sensitive artifacts afterward.
