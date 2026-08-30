# Current Build Status

_Volatile. Update this whenever branches, commits, or build state change. Last updated: 2026-08-30._

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

## Current corrective hardening branch

- Active corrective branch: `fix/external-action-safety-final`.
- Base: merged Instagram integration on `develop` at `905103e8`.
- Latest verified code commit: `de071077`.
- The broad `chore/full-product-hardening` branch remains audit evidence and is
  not an integration branch.
- The corrective branch prevents a focus acknowledgement from overtaking newer
  user intent, holds sends and session resets behind the same platform fences,
  binds send replays to their complete immutable intent, and preserves sent
  state before local projection.
- Message reactions, edits, and poll votes now use durable per-attempt identity.
  An uncertain action is not dispatched again, completed local projections are
  repaired after restart, and an older edit repair cannot overwrite a newer
  completed edit.
- Legacy database upgrade coverage verifies creation of the durable external
  action table alongside the existing deterministic Draft repair.
- The adversarial passes reopened pending focus replay, claimed and in-doubt
  automatic notes, policy-blocked recovery, and repeated completed-action
  semantics. Commit `de071077` keeps each tab's unresolved operation generation
  through a reload, prevents stale completion from overwriting a newer action,
  and returns automatic-note conflicts as a no-retry delivery check. Earlier
  corrections preserve the original durable intent fence and allow only a fresh
  manual action to re-arm a safely blocked note.
- The complete repository suite passes under Node 20.20.0: 3,209 tests, zero
  failures, zero skips, zero cancellations, and zero todos. Core, runner, and
  dashboard type checks, documentation checks, and the whitespace check pass.
- The exact commit still requires final adversarial confirmation, pull request
  CI, and merged `develop` verification.
- Verification did not send, edit, react to, vote on, scan, reconnect, or reset
  a live platform account.

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

## Merged Instagram integration baseline

- Pull request [#1045](https://github.com/richardafolayan/Relationship-Inbox-OS/pull/1045)
  merged into `develop` as `905103e8`.
- Reviewed local integration branch: `fix/instagram-integration-gate`.
- Base: `origin/develop` at
  `ddfba09f44470852c349e0a7f82c12230ba7d32d`.
- Latest verified corrective commit: `df515bbd`.
- The complete repository suite passes under Node 20.20.0: 3,044 tests, zero failures,
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
  now considers every exact-layout automation receipt by timestamp and
  quarantines only a mapping when more than one is plausible. A one-sided
  first-seen bound preserves provably newer messages, and malformed provenance
  is matched independently of a drifting occurrence key. Unresolved mappings
  block only unsafe canonical writes while independently safe messages continue.
  Scans expose parsed, persisted, and quarantined counts, retain their watermark,
  and report freshness as incomplete. Rekeys and transcription creation share a
  per-message lock, and ADR 0008 records the repair, rollback, quarantine, and
  atomicity rules.
- Platform-specific identity repair is injected through a generic runner
  reconciliation boundary rather than branching inside the shared scan path.
  Instagram recipient revalidation uses the adapter-captured platform label,
  stored separately from the mutable person display name. Physical sends fail
  closed when that authoritative label is unavailable.
- The production Instagram selector registry is exercised against a realistic
  DOM fixture. Linkless control-only sidebar rows, linked profile images, and
  unlinked semantic avatars are excluded from message ingestion. Genuine post,
  reel, and audio media remain attached to the correct bubble. A legacy SQLite
  database was upgraded with the new nullable recipient label column and its
  existing person and thread rows remained intact.
- The latest exact-head adversarial review reopened four claims. The corrected
  branch now quarantines a canonical row when nearby first-seen predecessor
  history is still ambiguous, verifies the authoritative recipient before any
  external composer mutation, leaves identity-quarantined platforms degraded
  without advancing their fully fresh scan time, and surfaces incomplete
  per-thread checks instead of claiming there were no new messages.
- A fourth exact-head adversarial review reopened six claims. The composer is
  now bound before recipient verification, and every read, clear, click, and
  keystroke uses that exact handle. Unresolved identity quarantine is stored as
  privacy-safe hashes and remains authoritative when the conflicting message
  leaves Instagram's sliding DOM window or the runner restarts. Thread failures
  and candidate caps retain the previous fully fresh time and cannot clear
  retry state. Incomplete per-thread checks return HTTP 409, so dashboard bulk
  actions count them as failures. The mobile and desktop status bar renders the
  incomplete result after active work has ended.
- A fifth exact-head adversarial review reopened six claims. Every Send
  candidate must now be spatially associated with the bound composer, even
  when only one candidate exists. Recipient identity is rechecked after pointer
  movement and before every typed unit. Markerless predecessor databases adopt
  any existing identity degradation into a privacy-safe durable sentinel,
  while empty or malformed repair markers fail closed. Instagram admin reset
  removes the complete quarantine namespace, and collector failures, native
  caps, duration or iteration limits, and no-scroll incomplete boundaries all
  preserve degraded freshness instead of certifying a complete scan.
- A sixth exact-head adversarial review reopened nine boundary claims. The
  corrected branch rechecks the route after awaited recipient-header reads,
  binds and measures one nearby Send handle, deduplicates network and DOM
  threads before limiting them, and treats non-empty Instagram snapshots as
  bounded rather than fully fresh. The global predecessor sentinel now makes
  targeted checks incomplete, marker storage failures retain a quarantine
  floor, and Instagram graph resets remove markers transactionally after graph
  deletion. LinkedIn hard limits, disabled deep scroll, and unproven
  no-progress exits retain their causal incomplete stop reasons.
- A seventh and eighth exact-head adversarial review reopened five final
  boundary claims. Recipient ownership is now rechecked after focus handlers
  and before any text mutation or input event. A bound Send must retain local
  form and row ownership immediately before the synchronous click. Saturated
  iMessage unread or recent queries report a candidate cap and cannot advance
  freshness or the database watermark. Static adapter metrics cannot erase
  observed non-empty scan counts, and collection diagnostics read the typed
  native stop reason. The new privacy, reparenting, cap, watermark, count, and
  diagnostic regressions pass through production paths.
- A ninth exact-head review found that form-less controls could retain their
  geometry after moving to another composer owner, and that the watermark
  regression had not enabled the complete incremental capability pair. Send
  now binds the lowest local owner shared by the composer and control, rejects
  page-level owners, and requires the same owner immediately before clicking.
  The no-form coordinate-preserving reparent case performs zero clicks. The
  queue regression now proves the watermark was captured and still not saved
  after incomplete or candidate-capped collection.
- A tenth exact-head adversarial review found that a fixed-position Send
  control could move between sibling composer branches while retaining the
  same shared owner and geometry. Send now binds the original composer branch,
  control branch, and immediate control parent as well as the shared owner.
  The synchronous click task requires every bound relationship to remain
  connected and unchanged. The same-owner sibling reparent regression performs
  zero clicks in real Chromium.
- An eleventh exact-head adversarial review moved the complete bound Send
  wrapper inside its original branch and reproduced a click in the wrong
  composer subtree. Send now binds and revalidates every ordered ancestor edge
  from the composer and control to their shared owner. Accepted, rejected, and
  ambiguous browser handles are released on success and failure. The intact
  wrapper reparent regression performs zero clicks in real Chromium.
- A twelfth exact-head adversarial review found that the production collection
  path limited DOM and network candidates before unread ordering and
  deduplication. The adapter now captures all currently rendered candidates,
  puts unread DOM rows first, deduplicates identities, and applies the caller's
  distinct-thread limit only at the end. A production-path Chromium regression
  proves that later unread rows cannot be starved by earlier recent rows.
- A thirteenth exact-head adversarial review moved the complete bound composer
  and Send owner within the same conversation subtree and reproduced a click
  after every child path still matched. Send now binds the verified
  conversation container and the complete owner-to-document-root path. The
  synchronous click requires every relationship to remain connected and
  unchanged. The whole-owner reparent regression performs zero clicks in real
  Chromium.
- The same review found that a network-only unread thread could still be cut
  after earlier DOM candidates filled the limit. DOM and network candidates are
  now normalized and deduplicated together, unread evidence is combined across
  sources, every unread thread is prioritized, and the distinct-thread limit is
  applied last. Network-only unread and cross-source disagreement regressions
  pass through the production merge path.
- A fourteenth exact-head adversarial review found three remaining concurrency
  boundaries. Overlapping GraphQL responses for the same thread now merge by
  reserved request order rather than response completion order, while unread
  evidence remains monotonic. The collection path waits, within its existing
  bounded deadline, for pending GraphQL work to settle before combining DOM and
  network candidates. A delayed network-only unread thread now outranks three
  already-rendered read threads in the real Chromium production path. Composer
  ownership is captured before the first pointer movement or input, including
  the verified conversation container and complete path to the document root,
  then revalidated for every atomic composer action. Reparenting the complete
  composer owner during the first humanized pointer approach now produces zero
  clicks, zero submissions, and an explicit ownership failure in real Chromium.
- A fifteenth exact-head standards review found that a Platform card could start
  its More action while the primary action was running, and that selector tests
  bypassed the normal inline action state. Each platform now has one shared
  single-flight gate across its card and degraded banner. The gate is reserved
  before the request factory can run, the primary action and every More action
  are disabled while work is active, and selector tests use the same inline
  pending, success, and failure path. A deferred-promise regression proves a
  second request factory never starts. A safe localhost browser fixture then
  exercised the corrected controls in dark and light themes at 1440 by 900 and
  390 by 844. It found that the degraded-banner actions clipped on the phone
  viewport, so those actions now wrap. The final phone render has no horizontal
  overflow and keeps View diagnostics inside the viewport. No live platform
  scan, send, reset, or database mutation was performed.
- A sixteenth exact-head adversarial review found that inline success appeared
  before the follow-up refresh completed, while the shared single-flight gate
  was still reserved. That made the controls look available even though a new
  click was safely rejected. Inline actions now remain visibly running and
  disabled until the follow-up completes, then publish success and release the
  gate together. A deferred-refresh regression proves the running state and
  gate remain aligned, and proves a second request factory cannot start during
  that interval.
- Scheduled sends, attachments, polls, focus acknowledgements, and other
  automated Instagram sends are rejected at the durable worker boundary. The
  dashboard no longer offers those unsupported actions.
- An isolated synthetic browser pass covered the Instagram thread, degraded
  banners, and Platforms controls in dark and light themes at 1440 by 900,
  1024 by 768, 390 by 844, and 320 by 568. It found no horizontal overflow or
  fresh console errors. The pass did not open a live platform session or send
  a real message.
- The current production build also rendered the incomplete-check result at
  390 by 844 and 1440 by 900 in dark and light themes. The warning remained
  visible after the active ticker ended. This used a browser-local synthetic
  event only and performed no live scan, send, reset, or database mutation.
- The earlier live Instagram login, restart persistence, 30-thread scan,
  canonical thread opening, one user-approved harmless send, and read-only
  deduplication checks remain historical evidence from earlier branch commits.
  They have not been repeated on the current integration head solely to create
  another external action.
- Physical iPhone and installed PWA suspension, keyboard, microphone, and
  standalone-navigation checks still require a real device. Browser viewport
  checks do not replace that native boundary.

## Active external-action safety gate

- Branch: `fix/external-action-safety`.
- Base: `origin/develop` at
  `905103e81fe1d5e7edec17c9f681dec0f2f2a0c4`.
- Latest verified corrective commit: `bde4e842`.
- The complete repository suite passes under Node 20.20.0: 3,058 tests, zero
  failures, zero skips, zero cancellations, and zero todos.
- Runner, dashboard, and core type checks pass. The runner and core production
  builds and diff whitespace check pass.
- Focus auto-ack now fails closed until the thread is classified `genuine`,
  reloads the authoritative thread immediately before queueing, and retries
  after the post-projection `THREAD_UPDATED` event. Its worker reloads
  classification inside the platform lease before any adapter call.
- Send workers claim only after entering the per-platform external-action
  fence and reloading the request and thread. A reset that enters first can
  delete the graph without a later stale send. An active send keeps the fence
  through adapter execution, terminal persistence, audit, and events, so reset
  cannot delete beneath its terminal writes.
- Admin reset takes the fixed lock order of global reset, target external
  action, then platform lease, and holds the target locks through graph
  deletion. Scan abort state is cleared in `finally` on success or failure.
- Direct poll sends, reactions, message edits, and poll votes use the same
  external-action fence and reload their thread and message after entering it.
- Real keyed-mutex regressions cover reset-first, active-send-first, target
  deletion, platform changes, concurrent workers, terminal persistence before
  deletion, and lock release after failure. No live send, reaction, edit, vote,
  poll, reset, scan, or platform session was performed during verification.

## Next

- Complete exact-head adversarial review, CI, and merge of the focused
  external-action safety branch into `develop`.
- Keep the broad full-product hardening branch as evidence. Move its confirmed
  corrections through focused pull requests based on the new `develop` tip.
- Finish scheduled-send correctness, composer recovery, and setup ordering
  before starting resume-to-fresh-state work. Clean first launch and the Draft
  uniqueness upgrade are already complete.
- Promote `develop` to `main` only when the full combined branch is release-ready.
- Continue preparing and running the 3-5 student pilot.

---

_Product direction and the "do not build next" list: [`current-product-direction.md`](./current-product-direction.md)._
