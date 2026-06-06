# Automated student release publishing

One command (or one manual GitHub Action) builds the student release,
overwrites the two files in Dropbox so the pilots' feed URL stays the same,
then verifies the live feed end to end. It fails loudly if anything is wrong.

This replaces the manual upload + re-stamp dance in
[releasing-student-builds.md](./releasing-student-builds.md).

## How the feed URL stays stable

The publisher **overwrites** the same two Dropbox files. It never deletes and
recreates them. Dropbox keeps each file's identity on an overwrite, so the
existing share links keep working and serve the new content. That is why
`RIOS_UPDATE_FEED_URL` can stay the same across every release.

Do not delete those two files in Dropbox, or every pilot's feed link breaks.

## One-time setup

### 1. A Dropbox app and a refresh token

App Console access tokens are short-lived (about 4 hours), so use a refresh
token, which does not expire.

1. Create an app at <https://www.dropbox.com/developers/apps> (Scoped access).
2. In the **Permissions** tab, tick: `files.content.write`,
   `files.content.read`, `sharing.write`, `sharing.read`, then **Submit**.
   (Set these before authorising; adding a scope later needs re-authorising.)
3. Get a refresh token once (offline flow). Open this in a browser (one line,
   with your app key):

   ```
   https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&response_type=code&token_access_type=offline&scope=files.content.write%20files.content.read%20sharing.write%20sharing.read
   ```

   Click **Allow**, copy the code, then exchange it:

   ```bash
   curl https://api.dropboxapi.com/oauth2/token \
     -d code=THE_CODE -d grant_type=authorization_code -u APP_KEY:APP_SECRET
   ```

   Save the `refresh_token` from the response. (Requesting it again only
   matters if you change scopes or revoke it.)

### 2. Upload the two files once, then get durable links

Upload `relationship-inbox-os-student-latest.zip` and `latest.json` to a
Dropbox folder once (any way). Then get durable links with the script:

```bash
npm run publish:student-release -- --print-links
```

It prints `RIOS_DROPBOX_ZIP_URL` and `RIOS_UPDATE_FEED_URL` in the durable
`?rlkey=...&dl=1` (or `raw=1`) form. It deliberately strips the `st=` token
that website "Copy link" URLs add, because `st=` is undocumented and can
expire; `rlkey` is the stable access key.

### 3. Local config (gitignored)

Create `.env.release.local` in the repo root. It is gitignored and must never
be committed.

```
DROPBOX_APP_KEY=...
DROPBOX_APP_SECRET=...
DROPBOX_REFRESH_TOKEN=...
RIOS_DROPBOX_ZIP_PATH=/Relationship Inbox OS Pilot Releases/relationship-inbox-os-student-latest.zip
RIOS_DROPBOX_MANIFEST_PATH=/Relationship Inbox OS Pilot Releases/latest.json
RIOS_DROPBOX_ZIP_URL=...        # from --print-links
RIOS_UPDATE_FEED_URL=...        # from --print-links
```

## Publish from your Mac

```bash
npm run publish:student-release
```

It builds, refuses to publish if the zip would leak anything secret,
overwrites both Dropbox files, then downloads the live feed and zip and checks
the checksum. Useful flags:

- `--notes "First pilot build"` (repeatable) for release notes.
- `--dry-run` to rehearse: build and check locally, upload nothing.

Bump `version` in `package.json` before publishing when you want pilots to see
a new version.

## Publish from GitHub (manual)

Add these repository secrets (**Settings > Secrets and variables > Actions**):
`DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
`RIOS_DROPBOX_ZIP_PATH`, `RIOS_DROPBOX_MANIFEST_PATH`, `RIOS_DROPBOX_ZIP_URL`,
`RIOS_UPDATE_FEED_URL`.

Then **Actions > Publish Student Release > Run workflow** (optionally paste
release notes). It runs the typecheck and full test suite first, publishes,
verifies the live feed, and uploads the zip, `latest.json`, and checksum as
build artefacts.

## Check that pilots see the latest version

```bash
node scripts/update-student.mjs --check-only --url "<your RIOS_UPDATE_FEED_URL>"
```

It reports the version the live feed serves. A pilot already on it sees "up to
date"; an older install sees the update.

## Rolling back

The updater only moves pilots forward (it never downgrades), so rolling back
means publishing a **new, higher** version that contains the good (older)
code:

1. Check out the good commit (or revert the bad change) and bump `version` in
   `package.json` to one above the bad release.
2. `npm run publish:student-release`.

Because it overwrites the same files, the feed serves the fixed build at the
same URL, and pilots update forward to it. (To stop pilots who have not yet
updated from getting a bad build, you can also just re-publish the previous
good build over it straight away.)

## Why it is manual-triggered

Publishing to pilots is a deliberate "yes, ship this to people" decision, so
the workflow is `workflow_dispatch` only. It never auto-publishes on a merge.
You decide when a build is ready.

## Safety

- The release zip never contains `.env`, `data/`, databases, logs,
  `node_modules`, `.git`, API keys, or message history. The builder excludes
  them and the publisher re-scans the finished zip and refuses to upload if
  anything slipped in.
- Your Dropbox token and links live only in GitHub secrets or your gitignored
  `.env.release.local`, never in the repository.
- A Dropbox share link is not private authentication: anyone with the link can
  download the build, so the zip must stay free of secrets (the checks above
  enforce that).
