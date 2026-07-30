# Signed macOS dev and pilot channels

Tovi has one macOS application identity and two isolated update feeds.

| Git branch | Public track | Release tag | Feed | Intended users |
| --- | --- | --- | --- | --- |
| `develop` | dev | `macos-free-dev` | `latest-macos.json` | Richard and development testing |
| `main` | pilot | `macos-free-pilot` | `latest-macos-pilot.json` | External pilots |

Both tracks produce `/Applications/Tovi.app` with:

- bundle identifier `com.relationshipinboxos.desktop`;
- the same `Tovi Free Update Signing` certificate and designated requirement;
- the same entitlements;
- runtime data under the same Application Support location.

The channel changes only the baked update feed and release metadata. It does not create `Tovi Dev.app` or `Tovi Pilot.app`. Installing one DMG over the other replaces the existing Tovi app.

## Normal release flow

1. Create feature branches from `develop`.
2. Merge verified feature PRs into `develop`.
3. Every push to `develop` automatically publishes a signed dev build.
4. Richard updates the installed dev build and tests the real signed artifact.
5. When the development state is ready, promote `develop` into `main` through a separate PR.
6. Every push to `main` automatically publishes a signed pilot build.
7. Pilot installations following the pilot feed receive that tested state.

Richard's installed dev build remains pinned to the dev feed. Publishing a pilot build from `main` does not offer that pilot build to the dev installation.

## Versions

Dev builds use the existing rolling format:

```text
0.1.20-dev.<git commit count>
```

Pilot builds use:

```text
0.1.20-pilot.<git commit count>
```

The commit count makes each build on its own track strictly newer without requiring a package-version edit for every promotion. The package core version should still be advanced deliberately for meaningful release milestones.

The macOS builder currently calls its non-dev distribution channel `student` internally. Pilot manifests retain that internal channel value for compatibility with the existing updater guard, while exposing `releaseTrack: pilot` and using pilot-specific assets and URLs.

## Existing installations

The current dev feed URL is preserved exactly:

```text
https://github.com/<owner>/<repo>/releases/download/macos-free-dev/latest-macos.json
```

Existing dev installations therefore continue updating without a reinstall.

An installation follows the feed baked into the signed app. A current installation already on the dev feed cannot be moved selectively to the pilot feed through that same dev feed, because doing so would move every dev user as well.

To place an existing pilot machine onto the new pilot track, install the pilot DMG over its current Tovi app once. The app name, bundle identifier and signing certificate stay unchanged, so this is a channel migration rather than a second app installation. Confirm Full Disk Access remains present after the first migration on one pilot Mac before rolling it out broadly.

After that one-time migration, all later pilot updates come from `main` through the pilot feed.

## Safety rules

- Never rotate the signing certificate for routine channel changes.
- Never change the bundle identifier for dev versus pilot.
- Never publish dev and pilot assets under the same release tag or feed filename.
- Upload the signed ZIP and DMG before replacing the feed JSON.
- A signed packaged build with a missing baked feed must fail closed rather than fall back to another channel.
- Keep database migrations backwards-compatible while Richard may switch the one installed app between dev and pilot builds.
