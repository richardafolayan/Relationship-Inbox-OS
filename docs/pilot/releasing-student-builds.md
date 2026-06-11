# Releasing Student Builds (Dropbox)

This is the internal guide for publishing a new student-pilot build and
letting installed pilot apps update themselves. It is written in British
English and uses no em or en dashes (the repo lints pilot docs for them).

The model is deliberately simple:

1. You merge new code into `v1/strip-back-pr1`.
2. You build a clean release zip plus a small `latest.json` file.
3. You upload both to a Dropbox folder.
4. Pilots already have a one update URL. Their app checks `latest.json`,
   sees a newer version, and offers to update.

Nothing about this requires pilots to touch GitHub, git, or the command line
beyond the single updater command.

## What gets published

Two files live in your Dropbox release folder (suggested name:
"Relationship Inbox OS Pilot Releases"):

- `relationship-inbox-os-student-latest.zip` is the app code as a clean
  source snapshot. Pilots' apps download and install this.
- `latest.json` is the small manifest describing the latest version, where
  the zip is, and its checksum. The updater reads this first.

## Safety: read this before you upload anything

A Dropbox shared link is **not private authentication**. Anyone who has the
link can download the file. Treat the release folder as public.

Therefore the release zip must never contain:

- `.env` or any secrets or API keys
- the `data/` folder, the SQLite database, or any message history
- logs
- `node_modules`
- the `.git` folder

The release builder enforces this. It only packages git-tracked files (so
`.env`, `data/`, logs and `node_modules` are excluded because they are
gitignored and never tracked), and it then scans the finished zip and refuses
to publish if anything forbidden slipped in. If the builder ever stops with a
"forbidden files" message, do not work around it: something secret has been
committed to the repo, and that is the real problem to fix.

## Option A: build a release locally

From a clean checkout of the branch you are releasing (normally
`v1/strip-back-pr1`):

```bash
npm run build:student-release
```

This writes, into `release-dist/`:

- `relationship-inbox-os-student-<version>.zip` (versioned copy)
- `relationship-inbox-os-student-latest.zip` (the one you upload)
- `relationship-inbox-os-student-<version>.zip.sha256` (the checksum)
- `latest.json` (with a placeholder zip URL for now)

The version comes from `package.json`. Bump it there before building when you
want pilots to see a new version.

## Option B: build a release with the GitHub Action

If you would rather not build locally:

1. On GitHub, open **Actions** then **Student Release**.
2. Click **Run workflow**. You can optionally paste release notes. You can
   leave the Dropbox URL blank for now.
3. When it finishes, open the run and download the **student-release**
   artifact. It contains the same zip, `latest.json`, and checksum.

The Action runs the typecheck and the full test suite first, so a release
only builds from green code. It does not upload to Dropbox; you do that step.

## Uploading to Dropbox and wiring up the links

1. Upload `relationship-inbox-os-student-latest.zip` to your Dropbox release
   folder.
2. Get its shared link (Dropbox: **Copy link**). It will end in `dl=0`.
   Change `dl=0` to `dl=1` so it downloads directly:

   ```text
   https://www.dropbox.com/scl/fi/.../...-latest.zip?rlkey=...&dl=0   <- as copied
   https://www.dropbox.com/scl/fi/.../...-latest.zip?rlkey=...&dl=1   <- use this
   ```

3. Put that `dl=1` link into `latest.json` and regenerate the manifest so its
   checksum still matches the exact zip you uploaded:

   ```bash
   npm run build:student-release -- --manifest-only --zip-url "https://www.dropbox.com/...?dl=1"
   ```

   (`--manifest-only` does not rebuild the zip. It reuses the existing zip's
   checksum and only rewrites `latest.json`.)

4. Upload the updated `latest.json` to the same Dropbox folder.
5. Get `latest.json`'s shared link and make it fetchable as raw JSON by using
   `raw=1` (or `dl=1`):

   ```text
   https://www.dropbox.com/scl/fi/.../latest.json?rlkey=...&raw=1
   ```

   This `raw=1` link is the **update feed URL**. It is the one thing pilots
   need. It does not change between releases, so you only share it once.

Dropbox direct and raw links may redirect before serving the file. The
updater follows redirects, so that is fine.

## Where the update feed URL is configured

The updater reads the feed URL from, in order:

1. the `--url` flag, or
2. the `RIOS_UPDATE_FEED_URL` environment variable.

Nothing is hard-coded in the source. Since 0.1.9 the release build bakes the
feed link into the shipped `.env.example` (from `RIOS_UPDATE_FEED_URL` at
release time, exactly like the pilot-feedback token), the installer copies it
into a fresh install's `.env`, and the start wrapper fills it into an
existing install's `.env` on launch when the key is missing or blank. So
pilots get updates out of the box; the manual `.env` / `--url` path remains
as a fallback for pre-0.1.9 installs that never received the link.

## How a pilot updates

Check only:

```bash
npm run update:student -- --check-only
```

Apply an update (downloads, verifies the checksum, backs up the current app,
preserves `.env` and `data/`, swaps in the new code, reinstalls dependencies,
and rolls back automatically if anything fails):

```bash
npm run update:student -- --apply
```

`--dry-run` prints exactly what an apply would do without changing anything.

The update replaces app code and dependencies only. It never touches the
pilot's `.env`, their `data/` folder (database, browser profiles,
screenshots), or their logs.

## Testing an update before you tell pilots

1. Make a throwaway copy of an installed app folder.
2. Bump `package.json` version and build a release, or point `--url` at a
   `latest.json` whose version is higher than the copy's.
3. Run `npm run update:student -- --check-only --url "<your latest.json link>"`
   and confirm it reports an update.
4. Run `--apply` against the copy and confirm the app still starts and the
   copy's `.env` and `data/` survived.

## What not to do

- Do not upload the zip with secrets in it. The builder guards against this,
  but never disable that guard.
- Do not edit `latest.json` by hand to point at a zip without updating the
  checksum. A mismatched checksum makes the updater refuse the file, which is
  the safe behaviour, not a bug.
- Do not rename the files in Dropbox after sharing the links, or the links
  break.
- Do not treat the Dropbox folder as private. Assume anyone with a link can
  read it.

## Roadmap note

Automating the Dropbox upload (or moving to S3 / Cloudflare R2 with a signed
URL) is deliberately left for later. There is a clearly marked place for it in
`.github/workflows/student-release.yml`. Manual dispatch plus manual upload is
the safe first version. The in-app "Update available" banner and one-click
relaunch are a separate, later change; this guide and the updater script are
the engine they will drive.
