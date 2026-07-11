# ADR 0007: Forward-only pilot updates

Status: Accepted

## Context

Pilot installations contain local messages, settings, browser sessions, and
models. An update must replace code without replacing that state, and a bad
release needs a safe recovery path.

## Decision

Publish a tracked-source ZIP and `latest.json` manifest over HTTPS. Validate
manifest shape and SHA-256 before installing. Stop processes, stage the new
copy, preserve `.env`, `.env.bak`, `data/`, and `logs/`, retain a sibling
backup, then run dependency and schema preparation. Restore the backup on a
failed apply.

The updater only advances semantic versions. Release rollback therefore ships
the last good code as a new, higher version rather than asking pilots to
downgrade.

## Consequences

- User state survives normal updates.
- A developer checkout with `.git` is refused by the self-updater.
- Release operators must keep the manifest and ZIP checksum paired.
- A bad published version is repaired by a new forward release, while a local
  failed apply can restore its on-disk backup.

## Verification

- [`scripts/update-student.mjs`](../../scripts/update-student.mjs)
- [`scripts/lib/release-manifest.mjs`](../../scripts/lib/release-manifest.mjs)
- [`scripts/publish-student-release.mjs`](../../scripts/publish-student-release.mjs)
- [`tests/student-updater.test.mjs`](../../tests/student-updater.test.mjs)
- [Release runbook](../operations/releases.md)
