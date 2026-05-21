# Strip-back bug hunt

Stability / hardening pass on `v1/strip-back-pr1`.
Branch: `fix/strip-back-bug-hunt` (based on `cb8d564`, identical code to
`v1/strip-back-pr1` plus the strategy/handoff docs).

## Context

- The three "expected merged" feature branches (`feat/action-items-first-thread-workspace`,
  `feat/user-voice-identity-setup`, `feat/student-pilot-feedback-loop`) all point at
  `cb8d564` — the baseline + one docs-only commit. The features themselves were never
  built (no de-personalisation, no voice setup, no pilot-feedback UI).
- `npm run lint` and `npm test` require `npm run db:generate` first (CI does this; a run
  without it fails on `@prisma/client` type resolution — not a code bug).
- Baseline `npm test`: 259 pass / 15 fail. All 15 failures are pre-existing runner
  LinkedIn browser-automation tests (`runner-linkedin-streaming-scan`,
  `runner-browser-profile`, `runner-linkedin-*-evaluate`) — "timed out waiting for list
  hydration" / environment-coupled Chrome-profile assertions. Unrelated to the
  strip-back UI and not introduced by this branch. Reproduced in isolation.

## Bug log

### BUG-A — Bad / stale thread ID showed a permanent "Loading…"
- **Source:** code inspection (`thread/[id]/page.tsx`); brief non-happy-path list.
- **Repro:** open `/thread/<bad-id>`. `refresh()` failed, `setError` + `setLoading(false)`
  ran, but `thread` stayed `null`, so `if (loading || !thread)` kept rendering the
  "Loading…" block forever — the error was set but lived in the unreached main render.
- **Status:** Still relevant.
- **Fix:** the early-return now renders an error state ("Can't open this thread." + the
  error message + a "Back to Today" link) when `!loading && !thread`.
- **Verification:** Chrome MCP — `/thread/does-not-exist-xyz123` shows
  "Can't open this thread. / Request failed: 404 / Back to Today". PASS.
- **Remaining risk:** none.

### BUG-B — `/inbox?q=` deep link ignored
- **Source:** code inspection; regression of closed issue #211.
- **Repro:** the thread participant popover's "Find 1:1 thread" links to
  `/inbox?q=<handle>` and the code comment explicitly assumes inbox search applies it.
  The inbox page never read the `q` URL param, so the link landed on an unfiltered inbox.
- **Status:** Still relevant (the inbox redesign dropped the #211 fix).
- **Fix:** new pure helper `lib/inbox-query.ts#readInboxQueryParam`; the inbox page seeds
  its `query` state from `?q=` on mount.
- **Verification:** Chrome MCP — `/inbox?q=Liz` loads with the search box pre-filled
  "Liz" and the list filtered to 3 matches. Unit test `tests/dashboard-inbox-query.test.mjs`
  (7 cases). PASS.
- **Remaining risk:** `?person=` is still ignored, but it is only produced by the hidden
  `/people` page and there is no person filter in the stripped-back inbox. Left as-is.

### BUG-C — Settings "About me" debounce dropped a field
- **Source:** code inspection (`settings/page.tsx`); brief priority "bugs that corrupt
  settings" / "break voice/profile setup".
- **Repro:** type in "About me", then within the 600ms debounce type in "Things you care
  about". The shared timer is reset, so only the second field was POSTed; the first edit
  was never saved. Separately the server echo (`setOperatorProfile(next)`) could clobber
  text typed during the round-trip.
- **Status:** Still relevant.
- **Fix:** an `operatorProfileRef` mirrors both fields; the debounced save POSTs the full
  `{about, interests}`; the server echo no longer overwrites local state.
- **Verification:** Chrome MCP — edited both textareas in quick succession, reloaded;
  both values persisted ("ABOUT debounce check edited first" /
  "INTERESTS debounce check edited second"). PASS.
- **Remaining risk:** none.

### BUG-D — Hardcoded operator name
- **Source:** code inspection; brief happy-path check #2.
- **Repro:** Today greeted a hardcoded operator name and the sidebar operator avatar
  rendered hardcoded initials regardless of who is using the app — wrong for a multi-student pilot.
- **Status:** Still relevant. (Full AI-voice de-personalisation in `ai.ts` is separate,
  pending feature work — out of scope here.)
- **Fix:** the Today greeting drops the name (`{greeting}.`); the sidebar renders a
  neutral person glyph instead of hardcoded initials (the `userInitials` prop and the
  `operatorName` literal in `app-shell.tsx` are removed).
- **Verification:** Chrome MCP — Today shows "Good afternoon."; the sidebar operator
  avatar shows a person icon. PASS.
- **Remaining risk:** the AI casual-voice prompt still hardcodes the author's persona
  (`ai.ts`); tracked as pending feature work, not a strip-back bug.

### BUG-E — Today showed "You're caught up" when the runner was unreachable
- **Source:** code inspection; brief non-happy-path "runner offline".
- **Repro:** with the runner down, `/runner/data/inbox` failed, `refresh()` swallowed it,
  `loaded` flipped true with `data` still null, and Today rendered the "You're caught up"
  empty state — indistinguishable from a genuinely empty inbox.
- **Status:** Still relevant.
- **Fix:** Today tracks an `inboxUnavailable` flag and, when the inbox fetch failed and
  there is no data, renders "Can't reach the runner." instead of the caught-up state.
- **Verification:** Chrome MCP — stopped the runner, loaded Today: shows
  "Can't reach the runner. / The runner isn't responding…". Restarting the runner
  recovers the page. PASS.
- **Remaining risk:** none.

## Reviewed and NOT fixed

- **Inbox "Snoozed" tab** keys off `scheduledSendAt` (a queued send), not `snoozedUntil`.
  Genuinely snoozed threads are excluded from `/data/inbox` entirely, so the tab can only
  ever show scheduled-send threads. Fixing it changes product behaviour (snooze is meant
  to hide threads) — left for a product decision. *Needs confirmation.*
- **Archived "snoozed" reason filter** never matches — `/data/archived` does not populate
  `scheduledSendAt`. Cosmetic; left as-is.
- **AI-voice de-personalisation / AI-optional toggle** — pending *feature* work per the
  strategy doc ("Build next"), not a bug. Out of scope.
- **15 failing runner LinkedIn streaming-scan / browser-profile tests** — pre-existing
  browser-automation failures, unrelated to the strip-back UI. Recommended as a separate
  follow-up; not a blocker introduced here.
- **BUG_AUDIT.md (BUG-001..022)** — historical LinkedIn-scan reliability entries; not
  strip-back UI bugs.

## GitHub issues reviewed

- #211 (closed): `/inbox?q=` deep link — fix was lost in the redesign; re-fixed (BUG-B).
- #201 / #134 (open `bug`): LinkedIn duplicate rows / missing entries — runner scan
  concerns, not strip-back UI. *Stale for this pass.*
- #246, #252, #209, #222, #230 etc. (closed bugs, 2026-05-13): predate the snapshot;
  spot-checked against the strip-back surface, not regressed.
- Remaining open issues are `enhancement` / `future` / `cleanup` — not in scope.

## Automated checks

- `npm run lint` (tsc, all 3 workspaces): PASS (after `npm run db:generate`).
- Dashboard tests (`dashboard-inbox-query`, `dashboard-run-action`): 13/13 PASS.
- `npm test` (full): 266 pass / 15 fail — the 15 are the pre-existing, unrelated runner
  LinkedIn browser-automation failures described above.

## Verification environment

Runner + dashboard run locally against a **copy** of the production DB
(`data/inbox-os.sqlite` in the worktree). No scheduled/pending sends in the copy;
`IMESSAGE_ENABLED=0` and no LinkedIn credentials, so the runner could not send or scan
anything externally. No outbound messages were sent.
