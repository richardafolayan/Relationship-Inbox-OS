# Current Build Status

_Volatile. Update this whenever branches, commits, or build state change. Last updated: 2026-08-23._

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

## Current hardening state

- `chore/full-product-hardening` is preserved remotely with immutable tag
  `qa/full-product-hardening-2026-08-21`. Do not merge it or add unrelated work.
  It is evidence and source material for smaller corrective branches.
- The adversarial review reopened stop-ship external-action, scheduled-send,
  setup-ordering, recovery-fidelity, existing-database-upgrade, and clean-install
  findings. The dated evidence is in
  [`2026-08-23-full-product-hardening-adversarial-review.md`](../qa/2026-08-23-full-product-hardening-adversarial-review.md).
- PR #1053 records that errata and the focused ONNX Runtime/node-tar reachability
  assessment. PR #1054 is the independent clean packaged-first-launch fix.
  PR #1055 is stacked on #1054 and adds the guarded existing-database Draft
  repair, backup, unique invariant, and atomic runner upsert.
- Instagram PR #1045 remains a shared-path dependency. Focus, send, thread, and
  setup corrections must use its intended integrated state or wait for that
  state to stabilise. Independent corrections may proceed now.
- After the shared base stabilises, the correction order is external-action
  safety, scheduled-send reconciliation, composer recovery, then setup ordering.
  Each corrective branch requires adversarial review.
- Do not start resume-to-trustworthy-fresh-state work until the pilot release
  gate in `current-product-direction.md` is clear.

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

## Next

- Keep feature work based on `develop` and PRs targeted to `develop`.
- Complete the explicitly authorised Instagram implementation without reviving
  the retired v1 branch.
- Merge only sharply scoped corrective branches, not the full hardening branch.
- Clear the current pilot release gate before performance or feature work.
- Verify setup, connection, scanning, exact-thread opening, deduplication,
  user-triggered sending, reconnect/reset, UI states, tests, and browser smoke
  behaviour.
- Promote `develop` to `main` only when the full combined branch is release-ready.
- Continue preparing and running the 3-5 student pilot.

---

_Product direction and the "do not build next" list: [`current-product-direction.md`](./current-product-direction.md)._
