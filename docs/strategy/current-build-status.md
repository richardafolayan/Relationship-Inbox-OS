# Current Build Status

_Volatile. Update this whenever branches, commits, or build state change. Last updated: 2026-07-30._

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

## Active Instagram feature verification

- Branch: `feat/instagram-platform`.
- Base: `origin/develop` at
  `23f01593e921150acf8fe6d362d02b5942daac7d`.
- Instagram targeted tests pass, including availability, factory/session
  routing, auth and verification gates, stable identities, deduplication,
  direction, timestamp fallback, placeholders, exact-thread opening, manual
  send restrictions, verified submission, and privacy-safe diagnostics.
- Lint, type checking, documentation checks, Prisma generation, and the
  production build pass.
- The complete local suite has one existing LinkedIn fallback-scroll timing
  failure under full parallel load. That exact browser test passes when rerun
  alone. The browser-dependent Electron dictation and LinkedIn deep-scroll
  fixtures also pass when run with the macOS permissions they require.
- Setup, Settings, and Platforms were inspected at desktop and phone widths.
- A live connection launch used installed standard Chrome with the dedicated
  Instagram profile. The dedicated profile can now be seeded from a trusted
  personal Chrome profile once without controlling or deleting the live
  source. Later runner restarts preserve the app-owned login. On macOS, the
  existing local Keychain cookie bridge injects the encrypted Instagram
  session cookies without logging their values.
- Manual login completed successfully and the runner reported the authenticated
  Instagram inbox as connected. The earlier verification-required state,
  profile reset, and disconnected state were also observed.
- The approved safe conversation was opened by its canonical thread ID
  and the runner verified the URL/header pair. The current Instagram inbox DOM
  renders conversation rows as JavaScript controls without stable thread
  links, so full live unread/recent discovery remains a controlled selector
  failure rather than falling back to row position.
- One approved harmless send reached the exact accessible Send control and the
  operator visually confirmed the outgoing message in the intended thread.
  The current message-row selector did not observe the bubble before timeout,
  so an exact-text, outgoing-layout verification fallback is implemented and
  covered by browser-adapter tests but has not been exercised by a second live
  send. Live extraction and rescan deduplication remain unverified against the
  current DOM.

## Next

- Keep feature work based on `develop` and PRs targeted to `develop`.
- Review the Instagram feature pull request and its clean-machine checks.
- Resolve the current control-only inbox rows and message containers, then
  repeat the remaining live Instagram checks without retrying an uncertain
  send.
- Promote `develop` to `main` only when the full combined branch is release-ready.
- Continue preparing and running the 3-5 student pilot.

---

_Product direction and the "do not build next" list: [`current-product-direction.md`](./current-product-direction.md)._
