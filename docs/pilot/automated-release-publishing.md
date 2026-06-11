# Automated student release publishing

Publishing happens **automatically when code reaches `main`**: every push to
`main` builds the student release, overwrites the two files in Dropbox (so the
pilots' feed URL stays the same), verifies the live feed end to end, and fails
loudly if anything is wrong. `develop`, `staging`, `v1/strip-back-pr1`, and
feature branches **never** publish, so work can land there freely; reaching
`main` is the "ship to pilots" gate. The run publishes the **exact commit**
that reached `main`.

Two important details:

- **Pilots only SEE a new build when the version changes.** The updater
  compares versions, so a release that matters to pilots is: bump `version` in
  `package.json`, then get that commit onto `main`. A push to `main` with the
  same version re-publishes the same version (pilots see no change).
- **You can still publish manually** (Actions > Publish Student Release > Run
  workflow), e.g. to re-publish or to ship with custom release notes.
  Automatic push runs use the publish script's default notes.

You can also publish from your Mac with one command (below).

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

## Publish from GitHub (automatic on main, or manual)

Add these repository secrets once (**Settings > Secrets and variables >
Actions**): `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
`RIOS_DROPBOX_ZIP_PATH`, `RIOS_DROPBOX_MANIFEST_PATH`, `RIOS_DROPBOX_ZIP_URL`,
`RIOS_UPDATE_FEED_URL`.

After that, **every push to `main` publishes automatically.** The run
typechecks and runs the full suite first, then publishes, verifies the live
feed, and uploads the zip, `latest.json`, and checksum as build artefacts. A
concurrency group serialises runs so two pushes can never overwrite Dropbox at
once.

The build also bakes the pilot distribution config into the shipped
`.env.example`: `RIOS_UPDATE_FEED_URL` (so updates work out of the box; since
0.1.9) and the `PILOT_FEEDBACK_*` token (so in-app feedback works; since
0.1.7). Both come from the same secrets/`.env.release.local`; a content scan
hard-fails the build if any other secret-like value lands in `.env.example`.
On launch the start wrapper fills these keys into an existing install's
`.env` when they are missing or blank, so already-installed pilots pick them
up with their next update too.

To ship a release: get a **version bump** onto `main` (pilots only see a change
when the version changes). To re-publish or ship with custom release notes,
run it manually: **Actions > Publish Student Release > Run workflow**.

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

## Why `main` is the publish gate

Publishing to pilots is a deliberate "yes, ship this" decision, and that
decision is "merge to `main`". Work flows freely through `develop`, `staging`,
`v1/strip-back-pr1`, and feature branches without ever touching pilots; only
reaching `main` publishes. Manual `workflow_dispatch` stays as an escape hatch
for re-publishing or custom notes. Because pilots only see a build when the
version changes, a no-op re-publish (same version) is harmless.

## Pilot feedback delivery (Apps Script webhook)

For pilots to submit in-app feedback ("Report a bug" / "Share feedback"), every
pilot's runner needs the Google Apps Script webhook URL + secret in its `.env`.
So at release time the builder bakes `PILOT_FEEDBACK_WEBHOOK_URL`,
`PILOT_FEEDBACK_SECRET`, and `PILOT_FEEDBACK_STATUS_URL` into the shipped
`.env.example` (the installer copies it to `.env`). Source them the same way as
the Dropbox config: a gitignored `.env.release.local` for local publishes, or
GitHub secrets of the same names for the Action. They are never committed.

Treat this as a **low-value, rotatable distributed token**, not a private
secret: it ships inside the pilot zip, so anyone with the build could POST
feedback to your Sheet. To **rotate** it: change the secret in the Apps Script,
update `.env.release.local` (and the `PILOT_FEEDBACK_SECRET` GitHub secret), then
publish a new build. Leave all three blank and in-app feedback is simply off
(the build still succeeds).

## Safety

- The release zip carries **no high-value secrets, no user data, no AI keys, and
  no Dropbox tokens**. It excludes `.env`, `data/`, databases, logs,
  `node_modules`, `.git`, and message history; a content scan hard-fails the
  build if any secret-like value (other than the low-value pilot-feedback token
  above) lands in `.env.example`; and the publisher re-scans the finished zip
  and refuses to upload if anything slipped in.
- Your Dropbox token and links live only in GitHub secrets or your gitignored
  `.env.release.local`, never in the repository.
- A Dropbox share link is not private authentication: anyone with the link can
  download the build, so the zip must stay free of secrets (the checks above
  enforce that).
