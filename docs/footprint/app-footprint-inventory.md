# Application footprint inventory

Issue: #803  
Baseline branch: `origin/v1/strip-back-pr1`  
Baseline commit: `fcf51204a5642e5ca123c075e921e33f5e1ae2d1`  
Host: macOS arm64, Node 25.4.0 for the repository install, bundled Node 22 for the app build  
App version: `0.1.14`

All directory figures below are logical bytes, calculated by recursively summing regular-file sizes. Symlink target text and filesystem directory metadata are excluded. File figures come from `stat`. The production dependency figure comes from a clean `npm ci --omit=dev` in a `git archive` of the baseline. The packaged figures come from a complete unsigned `npm run build:macos-dmg` with no skip flags.

## Baseline inventory

| Area | Baseline bytes | Files | What the figure includes |
| --- | ---: | ---: | --- |
| Tracked repository source | 9,127,137 | 749 | Every file returned by `git ls-files`, before dependencies or builds |
| Repository dependencies | 1,414,196,404 | 32,181 | Clean full `node_modules` after `npm ci` |
| Production dependencies | 1,063,183,175 | 30,148 | Clean `node_modules` after `npm ci --omit=dev` |
| Electron template app | 267,762,841 | 258 | The Electron-provided `Electron.app` copied by the packager |
| Final macOS app bundle | 2,057,808,166 | 38,280 | Complete `Relationship Inbox OS.app` |
| DMG | 895,896,142 | 1 | Complete UDZO disk image |
| Packaged application resources | 1,604,386,160 | 33,271 | `Contents/Resources/app`, including dependencies, source, tests and builds |
| Packaged dependencies | 1,441,297,708 | 32,165 | Packaged `node_modules` after Prisma generation and all builds |
| Bundled Node runtime | 184,863,925 | 4,750 | Complete official Node 22 distribution copied into the app |
| Generated Next build | 151,862,691 | 194 | Entire packaged `.next` directory |
| Generated Next build cache | 147,557,403 | 9 | `.next/cache`, 97.17% of the generated Next build |
| Generated runner build | 2,034,206 | 127 | `apps/runner/dist` |
| Generated core build | 64,418 | 36 | `packages/core/dist` |
| Generated Prisma client | 22,768,731 | 18 | `node_modules/.prisma`, also counted inside packaged dependencies |
| Source maps | 172,579,454 | 7,698 | Every `*.map` in the final app, mostly dependency maps |
| Packaged design-review screenshots | 3,257,549 | 39 | Historical review images, not runtime UI assets |
| Packaged tests | 1,516,487 | 349 | Test sources copied by `git archive` |
| Packaged docs | 174,112 | 16 | Repository documentation copied by `git archive` |
| Packaged icon | 795,167 | 1 | Generated `app.icns`; source SVG is 2,085 bytes |

These rows are not additive. For example, source maps and the generated Prisma client are subsets of packaged dependencies.

## Runtime storage inventory

The clean package contains no user database, logs, browser profiles, message attachments, snapshots, retained backups or app-owned temporary files. Runtime storage is intentionally outside the release archive.

| Area | Clean bytes | Measured growth or bound | Current retention contract |
| --- | ---: | --- | --- |
| Database | 229,376 | 1,191,936 bytes at 1,000 representative messages; 9,904,128 bytes at 10,000; 968.02 bytes per additional message between those points | Message history and audit data are retained. There is no destructive compaction policy. |
| Browser/session caches | 0 | Workload-dependent. Chrome, Patchright and WhatsApp profiles store authentication and offline state under `data/profiles`. | Retained as user/recovery data. Never delete as generic cache. |
| Local transcription models | 0 | Model-size dependent under `data/models`. | Retained for offline transcription. User-controlled removal only. |
| Next build cache | 147,557,403 packaged | Nine build-only files; no runtime request reads this directory. | Safe to omit from the packaged app after the build completes. |
| Run logs and diagnostic captures | 0 | Workload-dependent under `logs/runs`, `data/screenshots`, `data/dom_dumps` and `data/repair`. | Existing explicit cleanup keeps the newest 20 items per source and everything from the last 7 days. Cleanup is opt-in via `npm run cleanup:artifacts -- --apply`. |
| Desktop/install logs | 0 | One file per desktop or installer launch under `~/Library/Logs/RelationshipInboxOS`; size is workload-dependent. `/tmp/runner-restart.log` appends across restarts. | No automatic deletion yet. These are useful diagnostics, so this workstream will not silently remove them. Log rotation belongs with #806. |
| Voice snapshots | 0 | Byte-for-byte copies under `data/imessage-voice-snapshots` and `data/linkedin-voice-messages`. | Recovery assets for expiring platform media. Retain until the source message is explicitly retracted or a user-facing policy exists. |
| WhatsApp media | 0 | Byte-for-byte media copies under `data/whatsapp-media`. | Message media and offline history. Retain. |
| Outgoing attachment staging | 0 | Maximum accepted upload is 10 files at 50 MiB each, so one request can stage up to 524,288,000 bytes. | Scheduled, pending and failed sends must retain files for delivery/retry. Terminal sent/cancelled staging can be removed only after the database transition is durable. Originals are never app-owned. |
| Dictation uploads | 0 | One upload, capped at 25 MiB. | Removed in a `finally` block after transcription. |
| iMessage conversion cache | 0 | Converted HEIC/CAF/video output in the OS temp directory, approximately the encoded output size. | Reproducible cache. Partial temp files are removed on failure; the OS owns eventual temp-directory cleanup. |
| Packaging/install temporary files | 0 | During the baseline build, packaging temporarily duplicated the app for the DMG source directory. | Packaging JavaScript uses `finally`; installer extraction/download paths are removed after success. No temp content is shipped. |
| Installer swap backup | 0 | At most one full install during the atomic swap. | Deleted after a successful install; restored on failure. |
| Updater recovery backups | 0 | Default maximum is two prior installs. At the baseline app size, two same-size backups would be 4,115,616,332 logical bytes. | Keep two by default for rollback. `--keep-backups` is explicit; never delete the only recoverable copy during a failed update. |

The database sample uses the real Prisma-generated SQLite schema and privacy-safe synthetic records. Each message contained 592 bytes of representative text, raw metadata and attachment metadata. The test inserts one person, one thread and 10,000 messages, checkpoints SQLite and measures the main database file after 1,000 and 10,000 rows.

## Removal proof required by this workstream

The initial measurements identify four large candidates that can be tested without changing a supported feature:

1. The staged `node_modules/electron` contains a second complete Electron runtime even though the outer app is already executing under Electron and `require("electron")` resolves Electron's built-in module.
2. `.next/cache` consists only of build cache packs. `next start` consumes the completed server/static output, not the cache.
3. `onnxruntime-node` ships Windows, Linux, Intel macOS and arm64 macOS binaries together. This DMG is arm64-only and can execute only the Darwin arm64 binding.
4. The bundled arm64 Node distribution carries OpenSSL headers for Windows, Linux, Solaris, AIX, BSD, Intel macOS and arm64 macOS. Offline native rebuild support needs the target Darwin arm64 headers, not other operating systems or architectures.

Each removal will receive a focused manifest test plus startup/import verification against the final packaged app. Source maps that remain useful for runtime diagnostics will not be removed wholesale.
