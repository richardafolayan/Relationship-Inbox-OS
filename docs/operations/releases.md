# Build, update, release, and rollback runbook

The verified baseline has two distribution families. Do not treat them as
interchangeable.

| Artifact | Built by | Runtime shape | Current publication |
| --- | --- | --- | --- |
| Student source ZIP plus `latest.json` and SHA-256 | `build-student-release.mjs` | Installed to `~/RelationshipInboxOS`, app-managed Node, lightweight `.app`, browser dashboard | Automatic Dropbox publish on `main`, or manual/local publish |
| Electron `.app` and architecture-specific DMG | `build-macos-dmg.mjs` | Source and dependencies inside Electron resources, bundled Node 22, Electron window | Local build only in the verified baseline |

## Developer builds

Install and generate once:

```bash
npm ci
npm run db:generate
```

Run standard gates:

```bash
npm run docs:check
npm run lint
npm run test:all
npm run build
```

`npm run build` builds core, runner, and the production Next dashboard through
Turbo. It does not create a release ZIP or DMG.

## Source pilot installation build

The source installer:

- relocates tracked app code to `RIOS_INSTALL_DIR` or
  `~/RelationshipInboxOS`;
- preserves `.env`, `data`, and `logs` on rerun;
- installs/checksums a user-owned Node 22 when needed;
- installs npm dependencies and Playwright Chromium;
- generates Prisma, applies the schema, builds core/dashboard preparation,
  and downloads the Transformers model;
- creates a lightweight `.app` launcher unless disabled.

Safe validation:

```bash
npm run install:student -- --dry-run
```

For an integration test, point `RIOS_INSTALL_DIR` and `RIOS_APP_BUNDLE_DIR` at
throwaway directories and use `RIOS_NO_START=1`. Never test relocation or
uninstall against a real pilot directory.

## Student source release

### Build locally

The builder archives only git-tracked files from the selected ref. It excludes
`.env`, data, logs, databases, browser profiles, `node_modules`, `.git`, and
local release configuration by construction, then scans the staged tree and
finished ZIP for forbidden entries and secret-like content.

```bash
npm run build:student-release
```

Outputs under `release-dist`:

- a versioned source ZIP;
- `relationship-inbox-os-student-latest.zip`;
- `latest.json`;
- SHA-256 checksum files;
- a baked `release.json` inside the ZIP containing version, build time,
  commit, and channel.

Useful builder options:

```bash
npm run build:student-release -- --ref <git-ref> --notes "Release note"
npm run build:student-release -- --manifest-only --zip <zip-path> --zip-url <https-url>
```

The second command is for a manually uploaded ZIP. It recalculates the
checksum and rewrites the manifest; never hand-edit the manifest/checksum pair.

### Release configuration

Local publishing reads gitignored `.env.release.local` unless
`RIOS_RELEASE_ENV_FILE` points elsewhere. Required Dropbox refresh-flow values
are:

- `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`;
- `RIOS_DROPBOX_ZIP_PATH`, `RIOS_DROPBOX_MANIFEST_PATH`;
- `RIOS_DROPBOX_ZIP_URL`, `RIOS_UPDATE_FEED_URL`.

Optional pilot feedback webhook values are baked into the shipped
`.env.example` as a low-value distributed token. AI keys, GitHub tokens,
Dropbox credentials, and other secrets are forbidden from the ZIP.

### Dry-run the publisher

```bash
npm run publish:student-release -- --dry-run
```

This builds and performs local safety checks but uploads nothing. It still
needs enough release configuration to construct a valid manifest.

### Publish from the operator Mac

```bash
npm run publish:student-release -- --notes "Pilot-facing change"
```

The publisher builds, writes the final stable ZIP URL into the manifest,
overwrites the two configured Dropbox files without recreating them, then
downloads the live feed and ZIP and verifies the checksum. Do not delete and
recreate the Dropbox files because their stable share links are the update
contract.

### Publish from GitHub

[`publish-student-release.yml`](../../.github/workflows/publish-student-release.yml)
runs on every push to `main` and by manual dispatch. It publishes the exact
triggering commit, serializes publishes without canceling an in-progress
upload, runs lint/tests first, uploads build artifacts, and verifies Dropbox.

[`student-release.yml`](../../.github/workflows/student-release.yml) is a
manual artifact builder. It does not upload to Dropbox.

`develop`, `staging`, `v1/strip-back-pr1`, and feature branches do not
automatically publish to pilots. Reaching `main` is the current release gate.

## Version and release checklist

Pilots see an update only when the manifest version is strictly newer.

1. Confirm the intended release commit and dependencies are merged into the
   release branch.
2. Update the root `package.json` version, lockfile version metadata, and
   `NEXT_PUBLIC_APP_VERSION` in `.env.example` together.
3. Update release notes without private message content.
4. Run documentation, lint, full tests, and build.
5. Run the publisher dry-run and inspect ZIP contents, manifest, checksum,
   version, commit, and minimum installer version.
6. Test install/update against a throwaway existing installation and confirm
   `.env`, database, profiles, media, and logs survive.
7. Confirm the target is `main` only when ready to publish.
8. After publication, query the live feed and checksum, install/update one
   canary Mac, run doctor, launch, and verify the core reply loop.
9. Record a meaningful release tag after the release commit is known good.

## Electron macOS app and DMG

Builds must run on macOS. The builder:

- exports the selected git ref into Electron's resources;
- downloads/checksums an architecture-matched Node 22 runtime;
- runs `npm ci`, Prisma generation, and core/runner/dashboard builds;
- creates an icon, rewrites the plist, and bundles Node;
- copies the Node runtime with `ditto` so its relative npm/corepack symlinks
  remain portable;
- signs ad hoc by default or uses `RIOS_CODESIGN_IDENTITY`, with hardened
  runtime entitlements;
- runs strict code-sign verification;
- creates and verifies a compressed DMG with an Applications shortcut.

The free stable-signing release path, certificate setup, secrets, and native
updater are documented in
[`free-macos-signing.md`](free-macos-signing.md).

Plan without building:

```bash
npm run build:macos-dmg -- --dry-run
```

Build:

```bash
npm run build:macos-dmg -- --ref <git-ref>
```

Outputs are under `release-dist/macos` by default.

### Current DMG limitations

- It is architecture-specific, not a universal binary.
- Ad-hoc signing is not Developer ID signing and no notarization/stapling step
  exists.
- The automatic Dropbox source-release workflow does not publish the DMG.
- Ad-hoc packaged builds report `replace_app`. A build made with the stable
  self-signed identity and `squirrel-mac` feed uses the native updater after
  the public certificate has been trusted once.

Do not describe this DMG as consumer-distribution-ready until signing,
notarization, fresh install, permissions, replacement update, and recovery
have been verified on the final artifact.

## Update flow

The source updater:

1. fetches `latest.json` only from an allowed HTTPS URL;
2. validates required fields and semantic versions;
3. refuses an update below the manifest's minimum installer version;
4. downloads the ZIP and verifies SHA-256;
5. validates the staged app layout;
6. stops runner/dashboard processes whose cwd belongs to the install;
7. copies `.env`, `.env.bak`, `data`, and `logs` into the staged app;
8. renames the current install to `.rios-backup-<timestamp>` and swaps in the
   staged app;
9. installs dependencies and runs prepare/schema setup;
10. restores the backup automatically if post-swap setup fails;
11. retains the newest two backups by default and recreates the lightweight
   app launcher.

Check and dry-run:

```bash
npm run update:student -- --check-only
npm run update:student -- --dry-run
```

Apply:

```bash
npm run update:student -- --apply
```

The dashboard stages `data/pending-update.json` and launches a detached helper
so the running app does not replace itself. The start wrapper also consumes a
pending intent before boot and clears it first so a failed update cannot loop.

Developer checkouts containing `.git` are refused by the self-updater. Update
them with Git instead.

Ad-hoc packaged Electron builds return `applyMode: "replace_app"`. Free stable
signed builds hand the update request to Electron, which downloads a complete
pre-signed app, quits, replaces the bundle, and relaunches. Database, `.env`,
profiles, and state remain in Application Support rather than inside the
replaced app bundle.

## Rollback

### Failed local apply

The updater automatically renames the failed new install aside and restores
the previous backup when dependency/schema preparation throws. Read the
update/restart log and run doctor before retrying.

If automatic restore reports a snag:

1. stop all app processes;
2. preserve the failed current directory under a unique name;
3. identify the matching sibling `.rios-backup-<timestamp>`;
4. rename the backup to the configured install path;
5. run doctor and start without applying another update;
6. inspect the failed copy and logs before deleting either.

Do not merge data directories from two points in time while SQLite is running.

### Roll back a published release

The updater is forward-only and will not install a lower version. Prepare the
last good code by reverting the bad change or building the known-good commit,
then assign a new version higher than the bad release and publish normally.
Pilots update forward to the repaired build.

To stop pilots who have not downloaded a bad build, overwrite the live ZIP and
manifest with a validated repaired pair immediately. Keep version/checksum
consistent and still perform a forward version release for machines already
on the bad version.

### Roll back source control

Use a reviewed `git revert` on the relevant release commit or PR. Do not use a
destructive reset on shared branches. Re-run the full release checklist from
the resulting commit.
