# Application footprint inventory

Issue: #803
Baseline branch: `origin/v1/strip-back-pr1`
Baseline commit: `f45e049a36f99d17454c88f761d193a8282c81cc`
Measured implementation commit: `0c8403cf0408cc44d07dd620b6bc4374934eac1c`
Host: macOS arm64, Node 22.23.1 for repository installs and the bundled app runtime
App version: `0.1.15`

All directory figures below are logical bytes, calculated by recursively summing regular-file sizes. Symlink target text and filesystem directory metadata are excluded. File figures come from `stat`. The production dependency figure comes from a clean `npm ci --omit=dev` in a `git archive` of the baseline. The packaged figures come from a complete unsigned `npm run build:macos-dmg` with no skip flags.

## Baseline inventory

| Area | Baseline bytes | Files | What the figure includes |
| --- | ---: | ---: | --- |
| Tracked repository source | 9,473,332 | 798 | Every regular file in the baseline tree, before dependencies or builds |
| Repository dependencies | 1,399,197,722 | 32,155 | Clean full `node_modules` after `npm ci` |
| Production dependencies | 1,048,185,147 | 30,122 | Clean `node_modules` after `npm ci --omit=dev` |
| Electron frameworks | 267,344,597 | 253 | Frameworks in the baseline app bundle |
| Final macOS app bundle | 2,052,724,592 | 38,338 | Complete `Tovi.app` |
| DMG | 977,384,659 | 1 | Complete UDZO disk image |
| Packaged application resources | 1,785,343,478 | 38,082 | `Contents/Resources`, including app payload and bundled Node |
| Packaged dependencies | 1,441,296,059 | 32,165 | Packaged `node_modules` after Prisma generation and all builds |
| Bundled Node runtime | 184,863,435 | 4,750 | Complete official Node 22 distribution copied into the app |
| Generated Next build | 146,990,894 | 194 | Entire packaged `.next` directory |
| Generated Next build cache | 142,739,086 | 9 | Build cache, 97.11% of the generated Next build |
| Generated runner build | 2,097,817 | 136 | `apps/runner/dist` |
| Generated core build | 64,418 | 36 | `packages/core/dist` |
| Generated Prisma client | 22,768,545 | 18 | `node_modules/.prisma`, also counted inside packaged dependencies |
| Source maps | 172,579,454 | 7,698 | Every `*.map` in the final app, mostly dependency maps |
| Packaged design-review screenshots | 3,257,549 | 39 | Historical review images, not runtime UI assets |
| Packaged tests | 1,539,415 | 354 | Test sources copied by `git archive` |
| Packaged docs | 372,093 | 43 | Repository documentation copied by `git archive` |
| Packaged icon | 175,893 | 1 | Generated `app.icns` |

These rows are not additive. For example, source maps and the generated Prisma client are subsets of packaged dependencies.

## Before and after

Both packages were built unsigned from the same baseline commit with the same Node 22.23.1 runtime and complete DMG path. The optimized package uses only the changes in this branch.

| Area | Before bytes | After bytes | Reduction | Reduction % |
| --- | ---: | ---: | ---: | ---: |
| Repository dependencies | 1,399,197,722 | 1,386,163,783 | 13,033,939 | 0.93% |
| Production dependencies | 1,048,185,147 | 1,035,027,092 | 13,158,055 | 1.26% |
| macOS app bundle | 2,052,724,592 | 1,272,571,068 | 780,153,524 | 38.01% |
| DMG | 977,384,659 | 662,838,006 | 314,546,653 | 32.18% |
| Packaged application resources | 1,785,343,478 | 1,005,189,954 | 780,153,524 | 43.70% |
| Packaged dependencies | 1,441,296,059 | 864,260,771 | 577,035,288 | 40.04% |
| Bundled Node runtime | 184,863,435 | 129,613,755 | 55,249,680 | 29.89% |
| Generated Next build | 146,990,894 | 4,287,162 | 142,703,732 | 97.08% |
| Generated Next build cache | 142,739,086 | 0 | 142,739,086 | 100.00% |
| Source maps | 172,579,454 | 149,609,878 | 22,969,576 | 13.31% |
| Packaged tests | 1,539,415 | 0 | 1,539,415 | 100.00% |
| Packaged design-review screenshots | 3,257,549 | 0 | 3,257,549 | 100.00% |

The runner build (2,097,817 bytes), core build (64,418 bytes), Prisma client (22,768,647 bytes), documentation (384,066 bytes), runtime app icon (175,893 bytes), npm CLI and Patchright runtime remain packaged. Source maps were not removed wholesale; their reduction is only the consequence of removing unused modules.

## Runtime storage inventory

The clean package contains no user database, logs, browser profiles, message attachments, snapshots, retained backups or app-owned temporary files. Runtime storage is intentionally outside the release archive.

| Area | Clean bytes | Measured growth or bound | Current retention contract |
| --- | ---: | --- | --- |
| Database | 229,376 | 1,191,936 bytes at 1,000 representative messages; 9,904,128 bytes at 10,000; 968.02 bytes per additional message between those points | Message history and audit data are retained. There is no destructive compaction policy. |
| Browser/session caches | 0 | Workload-dependent. Chrome, Patchright and WhatsApp profiles store authentication and offline state under `data/profiles`. | Retained as user/recovery data. Never delete as generic cache. |
| Local transcription models | 0 | Model-size dependent under `data/models`. | Retained for offline transcription. User-controlled removal only. |
| Next build cache | 142,739,086 packaged | Nine build-only files; no runtime request reads this directory. | Safe to omit from the packaged app after the build completes. |
| Run logs and diagnostic captures | 0 | Workload-dependent under `logs/runs`, `data/screenshots`, `data/dom_dumps` and `data/repair`. | Existing explicit cleanup keeps the newest 20 items per source and everything from the last 7 days. Cleanup is opt-in via `npm run cleanup:artifacts -- --apply`. |
| Desktop/install logs | 0 | One file per desktop or installer launch under `~/Library/Logs/RelationshipInboxOS`; size is workload-dependent. `/tmp/runner-restart.log` appends across restarts. | No automatic deletion yet. These are useful diagnostics, so this workstream will not silently remove them. Log rotation belongs with #806. |
| Voice snapshots | 0 | Byte-for-byte copies under `data/imessage-voice-snapshots` and `data/linkedin-voice-messages`. | Recovery assets for expiring platform media. Retain until the source message is explicitly retracted or a user-facing policy exists. |
| WhatsApp media | 0 | Byte-for-byte media copies under `data/whatsapp-media`. | Message media and offline history. Retain. |
| Outgoing attachment staging | 0 | Maximum accepted upload is 10 files at 50 MiB each, so one request can stage up to 524,288,000 bytes. | Scheduled, pending and failed sends must retain files for delivery/retry. Terminal sent/cancelled staging can be removed only after the database transition is durable. Originals are never app-owned. |
| Dictation uploads | 0 | One upload, capped at 25 MiB. | Removed in a `finally` block after transcription. |
| iMessage conversion cache | 0 | Converted HEIC/CAF/video output in the OS temp directory, approximately the encoded output size. | Reproducible cache. Partial temp files are removed on failure; the OS owns eventual temp-directory cleanup. |
| Packaging/install temporary files | 0 | During the baseline build, packaging temporarily duplicated the app for the DMG source directory. | Packaging JavaScript uses `finally`; installer extraction/download paths are removed after success. No temp content is shipped. |
| Installer swap backup | 0 | At most one full install during the atomic swap. | Deleted after a successful install; restored on failure. |
| Updater recovery backups | 0 | Default maximum is two prior installs. At the baseline app size, two same-size backups would be 4,105,449,184 logical bytes. | Keep two by default for rollback. `--keep-backups` is explicit; never delete the only recoverable copy during a failed update. |

The database sample uses the real Prisma-generated SQLite schema and privacy-safe synthetic records. Each message contained 592 bytes of representative text, raw metadata and attachment metadata. The test inserts one person, one thread and 10,000 messages, checkpoints SQLite and measures the main database file after 1,000 and 10,000 rows.

## Removal proof required by this workstream

The removals are deliberately limited to payload that cannot serve a supported arm64 macOS runtime path:

1. `playwright` had no production import. The LinkedIn adapter imports `patchright`; the remaining imports were test-only and now use the same production driver. Removing `playwright` and `playwright-core` therefore removes a duplicate browser automation stack without changing runtime behavior.
2. The staged `node_modules/electron` is a second build-template Electron runtime. The installed app executes under the renamed outer Electron binary, while subprocesses use the separately bundled Node runtime. Production source contains no filesystem execution of the staged Electron binary.
3. `.next/cache` contains build cache packs. `next start` consumes the completed server and static output, not this cache.
4. `onnxruntime-web` is explicitly ignored by the Transformers Node webpack configuration. The packaged app imports `onnxruntime-node`; the web runtime has no production import or Node execution path.
5. `onnxruntime-node` platform payload is selected by OS and CPU. An arm64-only DMG cannot load Windows, Linux or Intel macOS binaries, so only `darwin/arm64` remains.
6. The bundled arm64 Node distribution carries OpenSSL headers for many operating systems and architectures. Offline native rebuild support retains the target `darwin64-arm64-cc` headers. Node's runtime, npm CLI, licenses and headers remain; release notes, the unused corepack package, `share` documentation and non-target headers do not participate in app startup or npm execution.
7. Packaged repository tests and design-review screenshots are not imported by the runner, dashboard, desktop shell or startup scripts. Runtime documentation is retained.
8. Electron's `default_app.asar` and stock `electron.icns` belong to the upstream default app. This bundle supplies its own application entry point and icon.

The manifest regression test constructs representative payload and asserts that target ONNX/OpenSSL files, npm, licenses and Patchright survive while every removal above is absent. Final-package verification additionally imports `@huggingface/transformers`, `onnxruntime-node`, `better-sqlite3` and `@prisma/client`, and runs the bundled npm CLI. Source maps remain available for useful runtime diagnostics.

## Validation record

- Full regression suite: core and runner compilation plus 2,179 tests passed.
- Focused packaging suite: 6 tests passed, including target architecture preservation and the #806 local icon assertion.
- Full packaging: clean production install, Prisma generation, core build, runner build, dashboard build and unsigned DMG creation passed for both baseline and optimized commits.
- Package contents: only ONNX `darwin/arm64` and Node OpenSSL `darwin64-arm64-cc` remain; the paths listed above are absent.
- Startup: a copied optimized app launched its Electron shell, bundled Node runtime, runner and dashboard with isolated ports and user data. `/health` reported `ONLINE`; the dashboard returned the expected `Relationship Inbox OS` title.
- DMG verification: the final image is mounted read-only and checked before publication.

Fresh empty-database preparation in the isolated package test hit the same Prisma schema-engine failure on the unmodified baseline. Startup was therefore verified with an empty database created from the generated schema. This is an existing packaging/environment risk within #806, not caused by pruning, and no schema engine or Prisma runtime files are removed here.

No runtime user-data cleanup was added. In particular, terminal outgoing attachment cleanup remains deferred to #802 because it owns the send-queue transition. Message history, recovery files, browser profiles, attachments, backups and useful diagnostics retain the policies above.
