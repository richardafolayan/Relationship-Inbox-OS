# Current Build Status

_Volatile. Update this whenever branches, commits, or build state change. Last updated: 2026-08-24._

This file holds fast-moving build state on purpose. Branch tips and commit
hashes go stale quickly, so verify live refs before starting work rather than
trusting an old local remote-tracking branch.

## Branch baseline

- Active development and integration branch: `develop`.
- Stable production and release branch: `main`.
- Create normal feature, fix, chore, refactor, and documentation branches from
  the latest `origin/develop`.
- Merge normal pull requests into `develop`.
- Promote release-ready work from `develop` to `main` through a separate pull
  request after the combined development state is verified.
- `v1/strip-back-pr1` is retired and deleted. Its final commit history is already
  contained in `main`; do not recreate or target it.
- `develop` was aligned with the complete `main` history before becoming the
  permanent development branch. It may now be ahead of `main` with newer work,
  which is expected.
- Do not force-push shared `develop` or `main` branches during normal work.

Refresh local state before making branch decisions:

```bash
git fetch origin --prune
git rev-parse origin/develop
git rev-parse origin/main
git log --oneline --left-right origin/main...origin/develop
```

A stale local `origin/develop` value is not evidence that the remote branch is
wrong. Fetch first, then compare the live refs.

## Build and release routing

- Development builds publish from pushes to `develop` through
  `.github/workflows/publish-dev-release.yml`.
- Pull requests into `develop` receive the normal CI and Windows installer
  checks.
- Pilot and production publication remains gated by `main`.
- A feature merged into `develop` is not automatically ready for `main`.
- Promotion to `main` must account for every commit currently present on
  `develop`, not only the newest feature.

## Current product state

- Tovi is being prepared for a small 3-5 student pilot.
- Action-items-first thread workspace, user voice setup, feedback intake,
  protected same-Wi-Fi phone access, responsive phone layouts, dictation,
  WhatsApp, LinkedIn, iMessage, Windows packaging, and Google Messages work are
  present in the repository history.
- Sending remains user-triggered by default.
- Private conversation content must not be placed in logs, feedback, commits,
  pull requests, or test fixtures.
- Current feature truth belongs in
  [`docs/developer/features.md`](../developer/features.md); this page only tracks
  the moving branch and verification state.

## Last recorded live verification

The following checks were recorded before the branch-policy migration and remain
historical evidence rather than a guarantee about the newest `develop` tip:

- The dictation hotfix passed its focused dictation and audio-signal tests.
- The complete GitHub test suite and signed macOS dev release workflow passed
  for the then-current verified build.
- LinkedIn, iMessage, and WhatsApp reported connected in the installed runner.
- A user-approved WhatsApp message was sent, reached `SENT`, and was read back
  from WhatsApp by a targeted rescan.
- The installed mobile audit passed its recorded phone routes without
  horizontal overflow or actionable browser errors.
- Protected phone pairing returned the thread successfully and rendered the
  composer.

Re-run relevant checks against the current feature branch and merged `develop`
before claiming those guarantees still hold.

## Active Instagram integration gate

- Pull request: [#1045](https://github.com/richardafolayan/Relationship-Inbox-OS/pull/1045),
  `feat/instagram-platform` into `develop`.
- Reviewed local integration branch: `fix/instagram-integration-gate`.
- Base: `origin/develop` at
  `ddfba09f44470852c349e0a7f82c12230ba7d32d`.
- The complete bounded-concurrency suite passes: 2,962 tests, zero failures,
  zero skips, zero cancellations, and zero todos.
- Dashboard, runner, and core type checks pass. The production dashboard build,
  Prisma generation, documentation checks, schema-upgrade checks, and diff
  whitespace check pass.
- Instagram targeted coverage includes exact thread identity, pre-click
  recipient revalidation, late GraphQL response isolation, stable message
  reconciliation, delivery-uncertain failures, persisted send provenance,
  retry safety, session-reset isolation, privacy-safe diagnostics, and the
  explicit selector-diagnostics limitation.
- The final adversarial pass reopened eight integration claims. The corrected
  branch now fails closed on ambiguous message identity, prevents message-shaped
  GraphQL objects from becoming threads, preserves request-start ordering across
  out-of-order responses, verifies the exact composer text, binds Send to the
  verified document, and treats every post-click error as delivery uncertain.
- A second exact-head adversarial pass reopened four upgrade and send-boundary
  claims. The corrected branch reads both configured DOM message-ID variants,
  rejects multiline Instagram text before any key event can submit it, and
  reconciles predecessor message keys only when timestamp or automation-receipt
  evidence proves the identity. Ambiguous legacy history fails closed.
- Focus acknowledgements are excluded from Instagram and persist their own
  provenance instead of appearing manual. A durable repair marker now ensures
  every pre-marker send row is relabelled `legacy_unknown` transactionally,
  including databases already opened by the preceding integration head. Fresh
  databases receive the marker before first launch succeeds, and future writes
  have no schema-level manual-provenance default.
- A third exact-head adversarial pass found sliding-window receipt drift,
  thread-wide blocking around unresolved predecessor identity, a transcription
  creation race, and the missing migration decision record. Receipt matching
  now considers every exact-layout automation receipt by timestamp and fails
  closed when more than one is plausible. An unresolved predecessor mapping
  blocks only that canonical message write, while independently safe messages
  continue. Rekeys and transcription creation share a per-message lock, and
  ADR 0008 records the repair, rollback, quarantine, and atomicity rules.
- Scheduled sends, attachments, polls, focus acknowledgements, and other
  automated Instagram sends are rejected at the durable worker boundary. The
  dashboard no longer offers those unsupported actions.
- An isolated synthetic browser pass covered the Instagram thread, degraded
  banners, and Platforms controls in dark and light themes at 1440 by 900,
  1024 by 768, 390 by 844, and 320 by 568. It found no horizontal overflow or
  fresh console errors. The pass did not open a live platform session or send
  a real message.
- The earlier live Instagram login, restart persistence, 30-thread scan,
  canonical thread opening, one user-approved harmless send, and read-only
  deduplication checks remain historical evidence from earlier branch commits.
  They have not been repeated on the current integration head solely to create
  another external action.
- Physical iPhone and installed PWA suspension, keyboard, microphone, and
  standalone-navigation checks still require a real device. Browser viewport
  checks do not replace that native boundary.

## Next

- Push the final reviewed Instagram head, require exact-head CI and adversarial
  review, then merge pull request #1045 into `develop` if every gate remains
  green.
- Keep the broad full-product hardening branch as evidence. Move its confirmed
  corrections through focused pull requests based on the new `develop` tip.
- Finish the external-action safety, scheduled-send correctness, clean first
  launch, composer recovery, setup ordering, and database-upgrade gates before
  starting resume-to-fresh-state work.
- Promote `develop` to `main` only when the full combined branch is release-ready.
- Continue preparing and running the 3-5 student pilot.

---

_Product direction and the "do not build next" list: [`current-product-direction.md`](./current-product-direction.md)._
