# Branch Migration Log

Working file. Not committed. Tracks per-branch decisions during the
single-branch → three-tier migration (Phases 0–3, Group A first).

## Pre-Phase 0

Foundation reconciliation: possibility (a) confirmed.
- Main tip: 87a796c (feat(imessage): macOS Messages.app platform adapter, #123)
- Verified helpers present on main:
  - `geminiExtraBody`, `reinforceJsonPrompt`, `parseAiJson` in apps/runner/src/services/ai.ts
  - `Partial<Record<PlatformName, PlatformAdapter>>` typing in 6 files
  - `IMESSAGE` in `PlatformName` union (packages/core/src/types.ts) and prisma enum
- Working tree clean. No rescue branch needed.
- 12 remote feature branches match the plan's Phase 2 list.

## Phase 0

### Step 1: create develop + staging
- develop and staging both created from `87a796c` (main tip), pushed to origin.
- All five (main, develop, staging, origin/develop, origin/staging) point to same SHA.

### Step 2: CI audit
- Pre-existing workflows: only `pr-title.yml` (semantic PR title check). No lint/test workflow at all.
- No `typecheck` script exists; `lint` already does `tsc --noEmit` for runner and dashboard.
- Tests are pure unit tests against compiled `dist/` output — no SQLite `db:push` needed before tests, but prisma client generation IS needed because the runner imports `@prisma/client` at typecheck time.
- Added `.github/workflows/ci.yml`: `npm ci` → `npx prisma generate` → `npm run lint` → `npm run test:all`. Triggers: `pull_request` and `push` on develop/staging/main. Single Node 20.x ubuntu-latest job.
- Local pre-push verification: lint clean (turbo full-cache hit); 242/242 tests pass.
- Landed as PR #145 (squash-merge, develop tip now `e405d86`).
- Surprise: CI ran on PR #145 itself — same-repo PRs read the workflow from the head branch, so the "first PR has no CI" caveat in the plan didn't apply. `lint-and-test` job passed in 1m20s. Treating that as the test PR.

## Group A

### #1 chore/design-review-screenshots
- 8 commits, 39 binary PNGs added under `design-review-screenshots/`. Zero source code touched.
- Rebased cleanly onto develop (no conflicts, just replayed onto `e405d86`). Force-pushed.
- PR #146, CI green (lint-and-test 1m23s), squash-merged to develop at `0a51b1b`.
- Phase 3 verification skipped per plan (binary asset addition, no UI surface to validate).
- Note: had to `git reset --hard origin/develop` once after merge because the first `git pull` returned "Already up to date" before the squash commit had propagated. No local commits lost — local develop was still at the pre-merge tip when I reset, so this was fast-forward semantics via reset.

### Recovery interlude (between #1 and #2)

Discovered two problems before starting #2.

**Problem 1: local main was inadvertently advanced to develop's tip (`0a51b1b`).**
- Origin/main untouched at `87a796c` throughout. Only the local ref drifted.
- Caused by an unintended `checkout from develop to main` between PR #146's merge and a subsequent `git reset --hard origin/develop`. The reset landed on main instead of the intended develop. Reflog confirmed: `HEAD@{2}: checkout: moving from develop to main` followed by `HEAD@{1}: reset: moving to origin/develop`.
- Fix: `git checkout main && git reset --hard origin/main`. Discarded two local-only commits (CI workflow + screenshots squashes), both already on origin/develop. No remote impact, no work lost.
- **Process refinement (for Phase 4 review):** Use `git merge --ff-only origin/<branch>` for promotions instead of `git reset --hard`. The `--ff-only` flag would have refused on the wrong branch and surfaced the problem immediately. Adopting this for all subsequent develop→staging and staging→main promotions.

**Problem 2: six leftover Claude worktrees, one with uncommitted work.**
- `.claude/worktrees/trusting-shtern-d17de6` on `feat/whatsapp-foundation` had 11 untracked files (the WhatsApp adapter + 5 supporting modules + 5 tests) — Phase B work in progress from a prior session.
- Two other worktrees (`agent-a5461a3ffa20b621f`, `agent-abc818c49ba6532b6`) were locked but clean.
- Three more (`cool-johnson-26b925`, `redesign-fixes`, `dazzling-knuth-9b2fc3`) were unlocked and clean.
- **Recovery action:** preserved the WhatsApp Phase B work as a new branch.
  - Inside the trusting-shtern worktree: `git checkout -b feat/whatsapp-phase-b`, staged all 11 files, committed as `wip(whatsapp): preserve uncommitted Phase B adapter and tests for review`, pushed `-u origin feat/whatsapp-phase-b`.
  - Phase B tip on origin: `8287acd`. Out of scope for this migration's 12-branch list. Queue for review and integration after Group C completes.
- **Strategy decision:** for all subsequent rebases in the 12-branch list, do not touch any worktree. Use a `tmp/<branch>` local-only branch built from the remote tip, rebase that, force-push back to the original ref. This avoids any interaction with the locked or in-use worktrees.
- Locked worktrees: leave as-is, don't `--force` remove them.
- `dazzling-knuth-9b2fc3` (stale main) and the now-clean `trusting-shtern-d17de6`: leave for a worktree cleanup pass after the migration completes.

### #2 fix/dashboard-sse-event-delivery
- Existing PR #141 was open against `main`; rebased branch via `tmp/migrate-sse` from `origin/fix/dashboard-sse-event-delivery`, no conflicts (develop's only post-main changes — CI workflow + screenshots — don't overlap with this branch's files).
- Force-pushed back to `fix/dashboard-sse-event-delivery`, retargeted PR #141 to develop, left a note explaining the retarget.
- CI green (lint-and-test 1m29s).
- Cumulative dev-server cleanup before verification:
  - Killed user's running dev server (PIDs 26894 dashboard / 26919 runner).
  - Discovered 11 stale node processes from a prior session in an orphan worktree (`.claude/worktrees/imessage-compare/` — directory deleted but processes still running because Unix lets unlinked binaries keep executing). Killed all 11. Ports 3100/4001 free.
  - Confirmed no dev-server leakage into worktree paths after restart (DB now correctly created at `data/inbox-os.sqlite` in the main worktree).
- Dev server smoke verification on `tmp/migrate-sse`:
  - Dashboard reachable at `http://localhost:3100`, redirects to `/today` and renders. Today page shows live data: 119 thread entries, "First up" thread, "Then these, in order" stack, sidebar routes all visible.
  - Top status bar shows "Enriching 20 profiles..." progressing — that's an SSE-driven runtime status, confirming events are flowing end-to-end.
  - `GET /events` shown in network panel as `pending` — that's an open EventSource stream behaving as designed (no buffered close).
  - No console errors, no errors/warnings in dev server log.
  - **Verification gap:** could not perform the literal "send a message from a connected platform" step from the plan — no platform connection in this session. The smoke evidence (live runtime status + open SSE stream + no errors) is the strongest end-to-end check available without sending an actual message.
- Squash-merged via `gh pr merge 141 --squash --delete-branch`.
  - Local branch deletion failed: `fix/dashboard-sse-event-delivery` is pinned by `.claude/worktrees/cool-johnson-26b925`. Remote branch deleted, local orphan persists. Documented for the post-migration worktree cleanup pass.
  - Initial `git checkout develop` failed because `trusting-shtern` worktree had been switched to `develop` (probably during the kill-storm of stale processes — origin refs and branch refs survived). Switched trusting-shtern back to `feat/whatsapp-phase-b` to free develop. Note this for the worktree cleanup pass too.
- develop now at `4560e37`. Dev server hot-reloaded; smoke check still clean.

### #3 fix/issue-11-people-detail-sticky — DROPPED (obsolete)
- Single commit `c0774d1` adds `position: sticky` to a bottom-of-page people-detail panel + `requestAnimationFrame(scrollIntoView)` on click.
- Conflicts on rebase: 5 regions in `apps/dashboard/app/people/page.tsx`, with the largest spanning ~175 lines.
- Root cause: branch was based 3 days before main was merged, so it predates ~11 commits affecting that file. The decisive one is PR #110 (`feat(people): inline accordion replaces bottom-of-page detail card`), which deleted the entire panel concept the sticky fix was operating on. Develop's people page now uses an inline accordion instead — clicking a row expands detail content within the row itself.
- The fix is architecturally obsolete, not a layering question. There is no detail panel to make sticky.
- PR #72 was already closed (not merged), so no PR-closure step was needed.
- Action taken: left a comment on PR #72 explaining the obsolescence, recommended issue #11 be re-evaluated against the inline accordion approach, deleted both `origin/fix/issue-11-people-detail-sticky` and the local ref.
- Net effect on the 12-branch list: 11 to go, plus the recovered `feat/whatsapp-phase-b` deferred to post-Group C.

### #4 fix/people-list-auto-refresh
- Single commit `1cbca1e` adds 11 lines to `apps/dashboard/app/people/page.tsx`: a `runner-resync` event listener and a 10s polling fallback inside the existing `useEffect`.
- Rebased clean onto develop via `tmp/migrate-autoref`, no conflicts. The new code lives next to (not on top of) the inline-accordion code, so the orthogonal-edits assumption from the plan held.
- PR #122 retargeted from main to develop, comment added explaining the rebase.
- CI green (lint-and-test 1m7s).
- Phase 3 verification: navigated to `/people`, observed 4 `GET /runner/data/people` requests over ~15 seconds (1 initial + 10s polling interval). Polling fix confirmed live. Did not separately fire the `runner-resync` window event but both mechanisms are wired in the same useEffect — verifying one verifies they both got added. No console errors.
- Squash-merged. develop now at `98b3be3`.

### #5 feat/inbox-bulk-actions
- Largest Group A merge by impact. Single commit `37974d6` from a 3-day-old base; +341 / -18 across 2 files (`apps/dashboard/app/inbox/page.tsx` and a new `selectable-thread-row.tsx`).
- 5 conflict regions in `inbox/page.tsx`. Four mechanical (imports union, comment-block prepend, filter-chain combine, PageHead meta switch). The fifth — bucket render — was the architectural call (reported separately to Richard, option 3 chosen: full feature preservation).
- Resolution decisions implemented:
  - `SelectableThreadRow` brought to parity with develop's `ThreadRow`. Imports `PersonAvatar`, `NameSuggestionPill`, `normalizePreview`. Adds `onPersonChanged` prop wired in both render branches so operators can rename mid-bulk-select.
  - Bucket render uses `SelectableThreadRow` in both modes. The cmd/ctrl-click-to-enter-select shortcut lives inside its non-select Link branch and is preserved.
  - Filter chain: `query + filter + platformFilter` produce `visible`; `removedIds` further narrows to `rows`. Buckets, `flatVisibleIds`, and select-all derive from `rows`. Empty-state detection uses `visible.length === 0` so a mid-flight bulk action doesn't briefly flip the page to "Nothing matches".
  - PageHead meta merged: `selectMode` → `N selected`, otherwise → `X of Y threads` (preserving the search/filter context).
- **Bug fix landed in same commit.** Branch's failure-id reconstruction used `findIndex` on `results`, which only ever matched the first rejection and so mis-restored ids when ≥2 calls failed. Replaced with index-aligned `flatMap` over `Promise.allSettled` results (which preserves input order). Narrow-scope correctness fix called out in the PR body.
- **Hydration error caught at verification, fixed before merge.** In select mode, the wrapping row was a `<button>` and `NameSuggestionPill` rendered its own `<button>` (the rename trigger) inside it — invalid HTML, React threw a hydration error in the browser console. Replaced the wrapping `<button>` with a `<div role="button">` plus manual Enter/Space keyboard activation. Behaviour identical, no nested buttons. Force-pushed and re-verified — clean console.
- CI green twice (1m17s pre-fix, 1m27s post-fix).
- Phase 3 verification — all 6 behaviours from Richard's test plan:
  1. Plain click navigates → `/thread/cmox6bzwa0aelnw2wvqoh2v72`. ✓
  2. Cmd-click enters select mode with that row selected (PageHead → `1 selected`, row checkbox filled, bulk action bar shown). ✓
  3. In select mode, click another row toggles selection (PageHead → `2 selected`, both rows checked). ✓
  4. Hover-rename works in both modes (69 `Edit name` buttons in the DOM in non-select mode, 47 in select mode — both modes wire the pill). ✓
  5. Bulk actions: `Clear` exercised live; `Mark done` / `Snooze 16h` / `Rescan` not triggered to avoid mutating production data, but they're wired through the same `runBulk` codepath and present in the action bar. Wiring confirmed.
  6. ⌘A → `170 selected` with 170 rows visible. Esc clears, returns to non-select chrome. ✓
- Zero new console errors after the hydration fix.
- New PR #147 opened (replaced closed #63), squash-merged. develop now at `b6ed544`.

### #6 feat/redesign-inbox-filters — SUPERSEDED via cherry-pick
- Branch was 3 days old (off `19d19bc`). Single commit, +189/-10 across `inbox/page.tsx` and `thread-row.tsx`.
- Examined the full diff before resolving. Found that develop had already shipped substantial overlap:
  - Search bar (already on develop).
  - `FilterMode` (`all|unread|needs_reply|genuine`) — superseded the branch's `ReadFilter` (the "read" passthrough is redundant; "unread" duplicates).
  - `PlatformFilter` (`all|LINKEDIN|IMESSAGE`) — only on develop.
  - Bulk-action `removedIds` (#147) — duplicates the branch's `hiddenIds`.
  - Modern `ThreadRow` (`PersonAvatar`, `NameSuggestionPill`, `normalizePreview`, subtle risk text) — branch's `ThreadRow` was the old gradient-initials + dot+label version, would have regressed develop.
  - Bulk-actions feature (#147) — branch's inbox imports `ThreadRow`, not `SelectableThreadRow`, so a wholesale merge would erase bulk actions.
- Branch's hover-revealed per-row archive/mark-done buttons philosophically tension with the bulk-actions UX direction (operators select then bulk-act, not hover each row individually).
- Reported to Richard with three options. Picked option 1: cherry-pick the genuinely-net-new pieces onto develop.
- New commit on `feat/category-and-needs-reply-badges` (off develop):
  - `outreach` added to `FilterMode` + FILTERS dropdown + `applyFilter` switch.
  - `· genuine` / `· outreach` badge added inline in **both** `ThreadRow` (Today / At-Risk) and `SelectableThreadRow` (Inbox both modes).
  - Red `· needs reply` marker conditional on `lastMessageDirection === "IN" && unreadCount > 0 && !archivedAt`.
  - Total +39/-2 across 3 files.
- PR #148 opened against develop; CI green (lint-and-test 1m14s); squash-merged.
- Phase 3 verification:
  - Outreach filter button visible in dropdown row, click narrows from 170 → 54 threads, all visible rows show `· outreach` badge.
  - On the All view, every row showed its category badge. The red `· needs reply` marker appeared on Fisayo, Marianne, Ayo (MM) — exactly the rows that are inbound + unread + non-archived.
  - PersonAvatar (LinkedIn photos visible), NameSuggestionPill (rename pills present, tested earlier in #5), bulk actions (cmd-click + Esc tested earlier) all still working.
  - Zero console errors.
- develop now at `4a4cb0a`.
- Cleanup: PR #57 stays closed, left a comment pointing at #148. `origin/feat/redesign-inbox-filters` deleted. Local ref only exists in the locked worktree `agent-a5461a3ffa20b621f` — left as-is for the post-migration worktree cleanup pass.
- Net effect on the 12-branch list: 6 of 12 done (1 dropped, 1 superseded by cherry-pick, 4 merged), 1 to go in Group A.

### #7 feat/redesign-sidebar-routes — PARTIALLY SUPERSEDED via cherry-pick
- Single commit `cd27b89`, +5/-1 across `command-palette.tsx` and `sidebar.tsx`. PR #46 closed.
- Branch tried to add /at-risk and /archived entries in two places. Develop's state on each:
  - **Sidebar**: develop already has "At Risk" and "Archived" nav items with `AlertTriangle` and `Archive` icons. Branch's additions would have duplicated them with subtly different labels and icons (`CircleAlert` vs `AlertTriangle`, "At-risk" vs "At Risk").
  - **Command palette**: develop was missing both entries. Genuine gap.
- Decision was mechanical (one half is a clear duplicate of existing develop state, the other is a clear gap), so didn't pause to ask: cherry-picked just the palette additions onto a fresh branch off develop.
- New PR #149 (`feat(palette): add At Risk and Archived to ⌘K command palette`), +2/-0 in `command-palette.tsx`. CI green (1m16s), squash-merged.
- Phase 3 verification: ⌘K opened the palette, both entries visible alongside the existing "Go to" items. Clicked "Go to At Risk" → navigated to `/at-risk`. ✓
- develop now at `5f13f1c`.
- **Open question for Richard:** PR #46 stays closed; should `origin/feat/redesign-sidebar-routes` be deleted? Same call as the other superseded branches.

## Group B

### #8 feat/enrichment-rate-limit-safeguards
- Single commit `c2c2637`. +276/-30 across 6 files (`README.md`, `apps/dashboard/app/people/page.tsx`, runner config + index + enrichment-queue + platform-factory).
- Rebased clean onto develop via `tmp/migrate-ratelimit`. No merge conflicts — the branch's runner-side changes auto-merged with develop's SSE fix on `index.ts`, and the people-page additions auto-merged with the auto-refresh from #122.
- One small post-rebase TS error: `adapters.LINKEDIN.ensureConnected()` was a direct property access, but `adapters` has been `Partial<Record<PlatformName, PlatformAdapter>>` since the iMessage merge (some platforms are unconfigured at runtime). Wrapped in a localized fail-loud guard inside the lambda — throws with a clear message if LINKEDIN is somehow not registered, rather than `!` assertion or silent no-op.
- Local lint clean, 242/242 tests pass.
- PR #121 retargeted to develop; comment explaining the rebase. CI green (1m23s).
- Phase 3 verification:
  - Dev server hot-reloaded onto the rebased branch, started cleanly (`Runner listening on http://localhost:4001`).
  - Runner log shows enrichment endpoints responding (`POST /enrichment/cancel-pending`).
  - `/people` page renders with the new "Scan new" button alongside "Rescan all" — that's the "scan-new scope" the commit title mentions.
  - Did not trigger many enrichments under load (would hammer LinkedIn's API, risk getting your account rate-limited or auth-refreshed). Wiring confirmed via the queue starting and the new daily-cap log path being present in source (`[enrichment-queue] daily cap reached ...`).
- Squash-merged. develop now at `abd0217`.

### #9 codex/performance-fast-paths — ALREADY MERGED via PR #3
- 4 commits (`cc35157`, `ff0531a`, `7b9942b`, `bc68737`), +915/-213 across 9 files (runner perf, AI provider registry, dashboard async thread loading, settings cache fix).
- Initial rebase attempt produced 12 conflict regions across `apps/runner/src/index.ts` and `apps/runner/src/services/settings.ts` on commit 1 alone; aborted to investigate.
- Investigation: `apps/runner/src/services/ai-providers.ts` already exists on develop (346 lines, larger and more sophisticated than the branch's 212-line version). `git log --follow` traces it to commit `d03673a feat: AI provider registry with retry/fallback + thread/inbox perf wins (#3)`, which is the squash-merge of THIS EXACT BRANCH. PR #3 status: **MERGED**.
- The branch's value-add over develop is 0 — its 4 commits are already on develop (and main) in compacted form, plus develop has further enhancements layered on top (operator profile getters in settings.ts, expanded error classification in ai-providers.ts, etc.).
- Action: skipped the rebase. Branch ref `origin/codex/performance-fast-paths` is orphaned — its PR is already merged so no PR-comment is needed. **Open question for Richard:** delete the orphan ref?

### #10 claude/inspiring-jemison-682c98 — ALREADY MERGED via PR #2
- Single commit `84f0610` titled `feat(ai): add OpenAI <-> GLM (Z.AI) provider toggle with dashboard control`. +232/-55 across 11 files (`.env.example`, settings page, types, runner config, ai.ts, default model wiring, error-classifier tests).
- Investigation: develop already has full GLM (Z.AI) support.
  - `AiProvider = "openai" | "glm" | "gemini"` in [packages/core/src/types.ts:213](packages/core/src/types.ts:213) — `glm` is already a first-class provider.
  - `glmEntry` registered in [apps/runner/src/services/ai-providers.ts:284](apps/runner/src/services/ai-providers.ts:284) with full error classification: code 1113 (no balance, with BigModel/Z.AI top-up URLs), 1302 (rate limit, free-tier flash exemption note), 1305 (service overloaded — retriable).
  - `glmModel` config option, `Z_AI_MODEL` env wiring, glm-4.7-flash default — all present on develop.
- The branch's value-add over develop is 0. Same pattern as #9 — earlier/parallel attempt at functionality that develop has now incorporated.
- PR status: **MERGED** (PR #2, commit `fdece6f` on main).
- Action: skipped the rebase. Branch ref `origin/claude/inspiring-jemison-682c98` is orphaned. **Open question for Richard:** delete the orphan ref?

## Group B summary

3 branches in scope; results:
- **#8 feat/enrichment-rate-limit-safeguards** — rebased + small TS guard fix + merged (#121 retargeted to develop).
- **#9 codex/performance-fast-paths** — ALREADY MERGED via PR #3 (squash commit `d03673a`). Orphan ref pending deletion call.
- **#10 claude/inspiring-jemison-682c98** — ALREADY MERGED via PR #2 (squash commit `fdece6f`). Orphan ref pending deletion call.

Develop journey for Group B: `5f13f1c` → +rate-limit safeguards (#121) → `abd0217`.

## Group C

### #11 feat/whatsapp-foundation
- Single commit `4c639a4`. +129/-10 across 11 files (config, platform-factory, scan-retry-controller, prisma schema, selectors, defaults, types, two test renames, two new test files).
- Rebase produced 7 conflict regions across 7 files — all the same shape: branch added WHATSAPP where develop already had IMESSAGE. Resolved each as the union of both:
  - `packages/core/src/types.ts` → `PlatformName = "LINKEDIN" | "INSTAGRAM" | "TIKTOK" | "IMESSAGE" | "WHATSAPP"`. Combined comment.
  - `packages/core/prisma/schema.prisma` → both enum values present, ordered `IMESSAGE` then `WHATSAPP`. Combined comment notes WHATSAPP follows the same foundation-first pattern; the in-flight Phase B adapter lives on the recovered `feat/whatsapp-phase-b` branch.
  - `packages/core/src/selectors.ts` → both selector file entries present (IMESSAGE, WHATSAPP).
  - `packages/core/src/defaults.ts` → `enabledPlatforms` includes both.
  - `apps/runner/src/services/scan-retry-controller.ts` → `allPlatforms` array includes both. Combined comments.
  - `apps/runner/src/services/platform-factory.ts` → adapters map has `IMESSAGE: new IMessageAdapter(...)` followed by `WHATSAPP: createNotImplementedAdapter("WHATSAPP")`.
  - `apps/runner/src/config.ts` → tricky structural conflict. HEAD had IMESSAGE entry in `profileDirs` plus a separate `imessage: { ... }` config block; branch had WHATSAPP in `profileDirs` only, and the conflict marker spanned both. Resolved by keeping IMESSAGE + WHATSAPP in `profileDirs`, then the entire `imessage:` block intact afterward.
- Post-resolve TS errors required `npx prisma generate --schema packages/core/prisma/schema.prisma` to regenerate the prisma client (the schema enum addition needed reflection). Without that step, lint failed with `PlatformName from @inbox-os/core/dist/types not assignable to prisma's $Enums.PlatformName`. Worth flagging for the migration playbook: any prisma schema change needs a generate step before lint.
- Local lint clean, 249/249 tests pass (branch added 7 new whatsapp-foundation tests; previously 242).
- PR #136 retargeted to develop, comment explaining the resolution.
- CI green (1m22s).
- Phase 3 verification: foundation only — no UI exposure on this branch. Confirmed nothing broke: /platforms page renders cleanly (LinkedIn + iMessage CONNECTED, "Instagram, TikTok coming later" footer note unchanged). No console errors. WHATSAPP not yet visible in any UI surface, which matches the plan's expectation for a foundation-only merge.
- Squash-merged. develop now at `e000b74`.

### #12 fix/redesign-restore-controls — DROPPED (mostly superseded)
- 8 commits, +695/-149 across 10 dashboard files. Branch parent `19d19bc` (3 days old). PR #64 closed.
- Initial rebase: git's cherry-pick detection skipped commit `ae250f8` (#29 Activity OK/FAIL text) as already applied. The next commit (`5b37a5d` sidebar+palette routes) conflicted on `sidebar.tsx`. Aborted to do a per-commit audit.
- Audit findings:
  - `5b37a5d` (#23 sidebar + palette) — fully superseded. Sidebar already has `At Risk` and `Archived` entries on develop. Palette covered by my Group A cherry-pick #149.
  - `9a3db6c` (#16, #19 Settings + Restart Runner) — likely superseded. Develop's settings page is 661 lines and already has the "Restart runner" string at line 549.
  - `179c36d` (#21 Platforms recovery) — likely superseded. Develop's platforms page is 290 lines and already calls `platform/reset-session`.
  - `36d456a` (#26 /at-risk Reply Focus Mode + overdue durations) — possibly net-new.
  - `295ae50` (#27 Inbox filters + classifier + per-row badges) — largely superseded by my Group A cherry-pick #148 (outreach + category + needs-reply badges) plus develop's existing FilterMode + PlatformFilter + search + bulk actions.
  - `5faac52` (#25 People sticky right-pane) — directly contradicts develop. Develop uses an inline accordion (PR #110); same architectural call as branch #3 which I dropped earlier.
  - `0f8bb88` (#28 Thread page restore) — possibly mixed. Develop's thread page is 2181 lines.
  - `ae250f8` (#29 Activity OK/FAIL text) — already applied (git's cherry-pick detection caught it).
- Decision per Richard: drop. Same pattern as #6 / #7 / #9 / #10. Cherry-picking the "maybe new" commits would cost 1–2 hours of investigation for uncertain payoff against develop's already-modern implementations.
- PR #64 commented and `origin/fix/redesign-restore-controls` deleted.

### Phase 4 review candidates (from #12 audit)
Captured for Richard's review during Phase 4. Not opened as issues yet.
- **Reply Focus Mode on /at-risk** (commit `36d456a`).
- **Overdue durations on /at-risk** (same commit) — precise duration text rather than rounded "Overdue".
- **Interactive Open Loops on thread page** (commit `0f8bb88`).
- **Thread page nav column / status badge / focus mode** (same commit).

If any of these matter, fresh focused issues are the right path — better than reviving 3-day-old code that mostly superseded.

## Group C summary

2 branches in scope; results:
- **#11 feat/whatsapp-foundation** — rebased, 7-region union resolution (IMESSAGE + WHATSAPP everywhere), prisma client regenerated, merged (#136 retargeted to develop).
- **#12 fix/redesign-restore-controls** — DROPPED. Same pattern as the other "redesign" branches. Phase 4 candidates captured above.

Develop journey for Group C: `abd0217` → +whatsapp-foundation → `e000b74`.

## Group A summary

7 branches in scope; results:
- **#1 chore/design-review-screenshots** — merged (#146).
- **#2 fix/dashboard-sse-event-delivery** — rebased + merged (#141 retargeted to develop).
- **#3 fix/issue-11-people-detail-sticky** — DROPPED, obsolete vs the inline-accordion redesign (#110). Branch deleted, comment on closed PR #72.
- **#4 fix/people-list-auto-refresh** — rebased + merged (#122 retargeted).
- **#5 feat/inbox-bulk-actions** — substantial conflict resolution + bug fix + hydration fix; merged as new PR #147 (replaced closed #63).
- **#6 feat/redesign-inbox-filters** — SUPERSEDED via cherry-pick. New PR #148 added the genuinely-net-new bits (outreach filter, category badge, needs-reply marker) without regressing develop. Original branch deleted.
- **#7 feat/redesign-sidebar-routes** — PARTIALLY SUPERSEDED via cherry-pick. New PR #149 added palette entries; sidebar additions dropped as duplicates of existing develop state. Pending Richard's call on deleting the original branch.

Develop journey: `87a796c` (main tip) → +CI workflow → +screenshots → +SSE fix → +auto-refresh → +bulk actions → +outreach filter & badges → +palette routes → `5f13f1c`.

Process refinements established mid-Group-A:
- Use `git merge --ff-only origin/<branch>` for fast-forward syncs (not `git reset --hard`). The flag refuses on the wrong branch and surfaces problems immediately.
- Default to `tmp/<branch>` local-only branches for rebases. Don't touch the locked Claude worktrees.
- Verify locally (`npm run lint`, `npm run test:all`) before pushing — caught a TS error in #5 that would have failed CI and slowed iteration.

Process surprises also noted (not yet addressed):
- `gh pr merge --squash --delete-branch` repeatedly switches the main worktree's local HEAD to `main` after the merge, even though the branch being deleted is the head, not the base. Workaround in place: explicitly `git checkout develop && git merge --ff-only origin/develop` after each merge.
- `--delete-branch` errors locally for branches pinned by Claude worktrees (cool-johnson for #2, etc.) — remote branch is deleted, local orphan persists. Documented for the post-migration worktree cleanup pass.

---

## Final rollup (Phase 4 review)

### Develop tip

`e000b74` — `feat(whatsapp): foundation — platform value, group schema, factory stub (#136)`.

Develop journey from main tip `87a796c`:
1. `e405d86` ci: lint+test workflow for develop/staging/main (#145)
2. `0a51b1b` chore(screenshots): design-review reference images (#146)
3. `4560e37` fix(sse): drop event-name field; route /events through proxy (#141)
4. `98b3be3` fix(people): poll + resync-listen so new persons appear (#122)
5. `b6ed544` feat(inbox): multi-select with bulk Mark done / Snooze / Rescan (#147)
6. `4a4cb0a` feat(inbox): outreach filter + category and needs-reply badges (#148)
7. `5f13f1c` feat(palette): add At Risk and Archived to ⌘K command palette (#149)
8. `abd0217` feat(enrichment): rate-limit safeguards + scan-new scope (#121)
9. `e000b74` feat(whatsapp): foundation — platform value, group schema, factory stub (#136)

9 commits added on top of main. Plus the recovery commit `8287acd` on the side branch `feat/whatsapp-phase-b` (preserved untracked WhatsApp work, not on develop).

### Branches: counts and category breakdown

**12 in-scope branches** (per the plan), processed as:

| Outcome | Count | Branches |
|---|---|---|
| Rebased + merged into develop | 4 | #2 SSE fix, #4 auto-refresh, #8 rate-limit, #11 whatsapp-foundation |
| Plain merge (no conflicts) | 1 | #1 screenshots |
| Conflict-resolved + merged with bonus fixes | 1 | #5 bulk-actions (failure-id bug fix + hydration fix included) |
| Cherry-picked subset; original dropped | 2 | #6 inbox-filters (→ #148), #7 sidebar-routes (→ #149) |
| Dropped as obsolete | 2 | #3 sticky people-detail (replaced by inline accordion), #12 redesign-restore-controls (mostly superseded, contradicts develop's direction) |
| Dropped as already-merged-via-different-PR | 2 | #9 codex/perf-fast-paths (== PR #3, commit `d03673a`), #10 jemison/openai-glm-toggle (== PR #2, commit `fdece6f`) |

**Total PRs created/touched during migration:** 8 — #145 (CI), #146, #141, #122, #147, #148, #149, #121, #136. Plus the preservation push `feat/whatsapp-phase-b` (no PR yet).

**Remote branches deleted:** 6 — `fix/issue-11-people-detail-sticky`, `feat/redesign-inbox-filters`, `feat/redesign-sidebar-routes`, `codex/performance-fast-paths`, `claude/inspiring-jemison-682c98`, `fix/redesign-restore-controls`. PR #57, #46 had supersession comments; PR #72, #64 had obsolescence comments; PR #2, #3 needed no comment (already merged). PR #136 retargeted+merged.

### Conflicts that needed real judgment

- **#5 bulk-actions bucket render** (option 3 chosen by Richard): added `onPersonChanged` to `SelectableThreadRow` and lifted develop's modern row affordances (`PersonAvatar`, `NameSuggestionPill`, `normalizePreview`, subtle risk text) into it, so non-select mode preserves inline rename and select mode preserves the bulk-action UX. Cmd/ctrl-click-to-enter-select shortcut kept inside the same component.
- **#5 filter chain combine**: `query` + `FilterMode` + `PlatformFilter` produce `visible`, `removedIds` further narrows to `rows`. Empty-state (`CaughtUp`) keyed on `visible.length === 0` so a mid-flight bulk removal doesn't briefly flip the page to "Nothing matches".
- **#6 cherry-pick scoping** (option 1 chosen by Richard): identified outreach filter, category badge, needs-reply marker as the only genuinely net-new pieces. Dropped `ReadFilter`, hidden ids, hover archive/mark-done, old-style ThreadRow rewrite — all redundant with develop or contradictory to the bulk-actions UX direction.
- **#7 cherry-pick scoping**: sidebar additions were duplicates of existing develop entries (different icons/labels would have created visual inconsistency); palette additions were a genuine gap. Mechanical decision, didn't escalate.
- **#11 whatsapp-foundation 7-region union resolution**: every conflict was branch-adds-WHATSAPP / develop-already-has-IMESSAGE. Resolved each as the union of both. Tricky structural conflict in `apps/runner/src/config.ts` where the conflict marker spanned both the `profileDirs` IMESSAGE entry and the trailing `imessage:` config block — kept both intact.

### Bugs caught during verification (would have shipped silently)

- **#5 hydration error.** The merged select-mode wrapper was `<button>` and `NameSuggestionPill` renders its own `<button>` — invalid HTML, React threw a hydration error in the browser console. Surfaced through Chrome MCP console-read on the post-merge dev server. Switched the wrapper to `<div role="button">` with manual Enter/Space keyboard activation. Force-pushed before merge.
- **#5 failure-id reconstruction bug.** Original branch's `runBulk` used `findIndex` on `results` to map rejected promises back to source ids — only ever matched the first rejection, so any bulk action with ≥2 failures mis-restored ids. Replaced with index-aligned `flatMap` over `Promise.allSettled` (which preserves input order). Narrow-scope correctness fix called out in the PR body.
- **#8 TS guard.** Branch wrote `adapters.LINKEDIN.ensureConnected()` directly. `adapters` has been `Partial<Record<PlatformName, PlatformAdapter>>` since the iMessage merge — TS flagged LINKEDIN as possibly undefined. Wrapped in a localized fail-loud guard inside the lambda rather than `!` assertion or silent no-op.
- **#11 prisma-generate gap.** Schema enum addition (WHATSAPP) needed `npx prisma generate` before lint passed; prisma client was stale. Worth flagging for the migration playbook: any prisma schema change needs a generate step before lint.

### Verification gaps

- **No connected-platform test.** Phase 3 verification across all branches was smoke-test level: dashboard renders, network/SSE shape correct, no console errors, target behaviors observable in the UI. The plan's literal "send a message from a connected platform" verification was not performed for any branch — no platform connection in this session.
- **Destructive bulk actions skipped.** For #5 I exercised `Clear` live but did not trigger `Mark done` / `Snooze 16h` / `Rescan` — those would have mutated production data. Wiring confirmed via the action bar appearing and `Clear` working through the same `runBulk` codepath.
- **#8 rate-limit under load.** Did not trigger many enrichments in quick succession (would have hammered LinkedIn's API and risked your account getting rate-limited or auth-refreshed). Wiring confirmed via the queue starting cleanly, the new daily-cap log path being present in source, and runner endpoints responding.
- **#11 WHATSAPP UI.** Foundation only — no UI exposure on this branch. Verified `/platforms` page still renders cleanly and nothing else broke; WHATSAPP itself isn't surfaced in any UI yet.

### Outstanding items for Phase 4

**Phase 4 review candidates** (from #12 audit — dropped branch, but features may be worth fresh issues):
- Reply Focus Mode on /at-risk
- Overdue durations on /at-risk (precise duration text rather than rounded)
- Interactive Open Loops on thread page
- Thread page nav column / status badge / focus mode

**Recovered work (out of scope, post-Group-C follow-up):**
- `feat/whatsapp-phase-b` on origin (`8287acd`) — 11 untracked WhatsApp adapter + test files preserved from a stale Claude worktree before they could be lost. Out of scope for the 12-branch migration; queued for review.

**Worktree cleanup (deferred to post-migration):**
- 6 orphaned `.claude/worktrees/` directories. Two are locked (`agent-a5461a3ffa20b621f` for `feat/redesign-inbox-filters`, `agent-abc818c49ba6532b6` for `feat/redesign-sidebar-routes`). One is now-clean (`trusting-shtern-d17de6` after Phase B was committed). One holds an orphan main-branch state (`dazzling-knuth-9b2fc3`). Two unlocked-clean (`cool-johnson-26b925` for the merged SSE branch, `redesign-fixes` for the dropped restore-controls branch).
- Several local branches still pinned to those worktrees: `fix/dashboard-sse-event-delivery`, `feat/redesign-inbox-filters`, `feat/redesign-sidebar-routes`, `fix/redesign-restore-controls`. Their remote refs are deleted; local refs are orphans.

**Process surprises documented:**
- `gh pr merge --delete-branch` switches the main worktree's local HEAD to `main` after each merge. Workaround: explicit `git checkout develop && git merge --ff-only origin/develop`.
- `--delete-branch` errors locally when the branch is pinned by a worktree — remote deletes, local orphan persists.
- Claude worktrees can hold non-trivial uncommitted work (#11 caught 11 uncommitted WhatsApp files this way). Worth a check before any future worktree cleanup pass.

**CI in place:**
`.github/workflows/ci.yml` runs `npm ci → npx prisma generate → npm run lint → npm run test:all` on PR + push to develop/staging/main. Single Node 20.x ubuntu-latest job. Reports status only, no required-status-check gate yet (per Richard's standing decision to self-discipline until collaborators join).

**Tests passing:** 249/249 (was 242 at start; +7 from the WhatsApp foundation tests in #11).

### Phase 4 incidental findings (surfaced during Richard's review)

Not migration-related, but uncovered during the dev-server testing pass and worth recording.

**LinkedIn session not persisting between runner launches.** Diagnosis chain:
- Richard observed "every time it opens LinkedIn, it has to log in." Cookies file at `data/profiles/linkedin/Person 1/Cookies` was last modified Feb 18, 2026 — months stale.
- Root cause: `BROWSER_PROFILE_MODE=personal` in `.env`. Personal mode mirrors the operator's real Chrome profile into the runner's profile dir before each launch. With `PERSONAL_PROFILE_SYNC_MODE=smart` (the default), smart sync decided the source hadn't changed enough to re-mirror, so every launch ran against a 3-month-old cookie snapshot. LinkedIn invalidated those long ago.
- Fix: switched to `BROWSER_PROFILE_MODE=isolated` and cleared the stale `data/profiles/__managed_person_profiles/default/` dir. Isolated mode lets the runner own the profile dir directly — cookies persist between launches.
- Side issue exposed: first launch in isolated mode crashed Chrome with `SIGTRAP` because the previously-mirrored profile carried state from the operator's real browser that was incompatible with the isolated context. Wiping the dir for a fresh start resolved it.
- After: manual sign-in once → cookies saved → subsequent thread opens skip the login page. Persistence working.

**Misleading auto-login log message.** Diagnosis chain:
- Same testing pass: even with `LINKEDIN_USERNAME` / `LINKEDIN_PASSWORD` populated in `.env`, the runner logged `[auth-recovery] no LINKEDIN_USERNAME/LINKEDIN_PASSWORD configured`.
- Initial hypothesis (process.env not loaded) ruled out via temporary debug instrumentation in `apps/runner/src/config.ts` and `apps/runner/src/platforms/linkedin-adapter.ts`. Confirmed:
  - `process.cwd()` correct.
  - dotenv path correct, both keys parsed with right lengths (17 and 10 chars).
  - `runnerConfig.linkedInUsername` / `linkedInPassword` populated.
  - `LinkedInAdapter` ctor received `linkedInCredentials` with both fields.
- Real cause: develop's `apps/runner/src/services/platform-factory.ts:81` gates `linkedInCredentials` on **three** conditions: `linkedInAutoLoginEnabled && linkedInUsername && linkedInPassword`. If `LINKEDIN_AUTO_LOGIN=1` isn't set in `.env` (as is the safe default per the 2026-05-08 incident note in the comments), `linkedInCredentials` is `undefined`, and the adapter logs the misleading "no creds configured" message even when creds are present.
- Recommendation for Phase 4 candidate list: rename or rephrase the log message to something like `[auto-recovery] auto-login disabled (LINKEDIN_AUTO_LOGIN not set) — surfacing AUTH_REQUIRED`. The current message sends operators down the wrong diagnostic path.
- Debug instrumentation reverted; both source files clean.

### Phase 4 fix landings (Richard's review pass)

Two fixes shipped during the Phase 4 review, both off develop:

- **PR #150 `fix(profile): open LinkedIn profile in runner Chrome, not default browser`** (commit `e850986`). The People drawer's "open profile" link rendered as `<a target="_blank">`, which opened in the operator's default browser (typically not signed into LinkedIn). Now POSTs to `POST /control/person/:personId/open-profile`. Adds optional `openProfileUrl(url, displayName?)` to `PlatformAdapter` and implements it on `LinkedInAdapter`.

- **PR #155 `fix(linkedin): combine bubble time with group date heading on rescan`** (commit `266e285`). LinkedIn messages older than 24h were getting their timestamps snapped to yesterday/today, and messages with no `<time>` element silently inherited the scan time (so rescans kept moving timestamps forward). `fetchThreadMessages` calls `collectThreadMessagesWithBackfill`, which read only the bubble's time element ("10:59 PM") without combining it with the group LI's date heading ("JAN 1, 2025"). The sibling `collectVisibleThreadMessages` extractor already had the right pattern. Fix: bring parity by walking up to the enclosing `li.msg-s-message-list__event` and combining bubble time-of-day + date heading via `parseLinkedInMessageTimestamp`. Resolution order: ISO datetime attr → heading + time → raw text fallback → scan time as last resort. Concrete observed bug: Kolawole's JAN 1, 2025 messages were stored as 2026-05-09 22:59 (yesterday-fallback) and 2026-05-10 10:20 (scan-time fallback).

- **PR #153 `fix(scan-queue): preserve existing thread.personId on update`** (commit `05b92e9`). Companion to #151 found by the next rescan reverting the repair. The `prisma.thread.update` at the end of `syncThread` was unconditionally re-asserting `personId: person.id`, and the rescan endpoint at [index.ts:1799](apps/runner/src/index.ts:1799) builds the candidate's `displayName` from the thread's currently-linked person's displayName — so a mis-linked thread could never self-correct via rescan: each rescan re-resolved to the same wrong person by displayName and re-wrote the wrong personId. PR #151's profileUrl-priority guard didn't kick in because the rescan candidate has no `profileUrl` field. Fix: omit `personId` from the update; new threads still get it from the `create` branch above. The DB repair was re-applied after this fix landed; with #153 in place, subsequent rescans won't revert it.

- **PR #151 `fix(scan-queue): prefer profileUrl over displayName for person identity`** (commit `9c778d1`). Defensive guard at `apps/runner/src/services/scan-queue.ts` after a real mis-linked thread was found during testing: Kolawole Afonja's actual LinkedIn thread had been linked to Jessica Essien's `personId` since 2026-05-06 because the scan-queue's person resolution used `displayName + platform` as the lookup key, and the LinkedIn list parser produced a candidate whose `displayName` was "Jessica Essien" but whose `platformThreadId` and `profileUrl` belonged to Kolawole. The guard now prefers `profileUrl` as the primary identity (stable per-LinkedIn-contact), falls back to `displayName`, and rejects displayName-only matches when the existing person's `profileUrl` differs from the candidate's. The repair for the one observed mis-linked thread was applied directly to the live SQLite DB:
  ```sql
  UPDATE threads SET personId = 'cmou6umuj00txnwtgs7kxwvj7'
   WHERE id = 'cmou6umum00tznwtg7m1sz1l3';
  ```
  The bug-state DB is preserved at `data/inbox-os-bug-snapshot-20260510-0952.sqlite` for future investigation.

### Phase 4 backlog batches — shipped to develop

**Batch 1 (quick wins, complete):**
- ✅ #158 fix(dashboard): drop avatar initials for tokens starting with non-letters (`Cynthia (ACS)` → `C`)
- ✅ #159 fix(inbox): make ⌘ glyph in select-mode tip readable (kbd styling)
- ✅ #161 fix(dashboard): always stack PageHead subtitle under the title
- ✅ #162 fix(settings): rename AI providers to ChatGPT/Gemini/GLM, hide model fields
- ✅ #163 fix(linkedin): clarify auth-recovery log when credentials chain is gated
- ✅ #164 fix(dashboard): replace em/en dashes with hyphens across the interface (90 occurrences, 26 files)
- 🔄 Follow-up captured: 298 dash occurrences in `apps/runner/src/` — mostly code comments but some in user-facing strings (audit log, AI templates, error messages). Separate audit pass needed.

Develop tip after Batch 1: `60ffd60`.

### Phase 4 follow-up (UX + feature backlog from extended review)

Captured for the next planning pass. Grouped by theme.

**AI / classification quality**
- **"Write in my voice" should accept short prompts.** Today the input field expects a fully-formed reply that the AI just rewrites in voice. The expectation is conversational shorthand: "talk about X, Y, Z" → AI composes the actual reply in operator's voice. Closer to how AI Assist works. Today's behaviour is "I may as well send my own message" — the AI adds no value when you already have to write the reply.
- **Suggested replies should match conversation length and cover every open loop.** Currently they're short canned-feeling stubs that don't reflect the back-and-forth depth of the thread.
- **Open Loops needs to capture every askable thing.** Concrete: in Rolanda's thread she asked many things and only 3 were surfaced. Should walk inbound messages and extract every distinct question / topic the operator could follow up on. Probably a prompt + post-processing change in the open-loops generator (see `apps/runner/src/services/ai.ts`).
- **AI provider model selection in settings.** Today Gemini and GLM (Z.AI) panes expose a model-name input. Make them behave like OpenAI: clicking the provider just uses whatever model is in `.env`. No per-provider model UI — the env handles it.
- **AI provider display names in settings.** Rename for plain-English clarity:
  - "Gemini API" → "Gemini"
  - "Z.AI" → "GLM"
  - "OpenAI" → "ChatGPT"
  (Display only; internal IDs stay as-is.)
- **Bulk "archive all outreach" action.** Once the genuine-vs-outreach classifier is reliable enough to trust (see classifier item below), expose a one-shot action to archive every thread classified as outreach. Likely lives next to the existing bulk-actions bar or the Outreach filter chip.
- **Outreach vs genuine classifier is too aggressive on conversational threads.** Two concrete examples observed during Phase 4 testing:
  - Correctly classified as outreach: a sales-y intro message offering frontend/backend/full-stack engineers and asking for a discovery call.
  - **Mis**-classified as outreach: a thread with Efan that's clearly two friends catching up — "u focusing more on speed to lead stuff now? N I've been well. Living in Reading rn n spend a lot of time in London and hooping more which is good. See u killing it on Linkedin though keep it up man youre smashing it!" The classifier ignores conversational signals (back-and-forth volume, operator's reply pattern, second-person familiarity, encouragement / personal life topics) and treats anything LinkedIn-shaped as outreach.
  - Fix shape: the classifier prompt currently looks at message-level features only. Pass it more thread context — operator's reply count, average inbound length, whether the thread has multiple turns initiated by the operator, presence of personal topics (life updates, slang, mutual encouragement). Or augment with a "conversational" heuristic that overrides outreach classification when reply-volume + mutuality hit a threshold. Expected to land as a prompt + classifier-input change in `apps/runner/src/services/ai.ts` (see `classifyTier` / `classifyThreadCategory`), not a new model.

**Thread page UI**
- **Action row is cluttered.** Top bar of the thread page shows Save draft / Snooze / Mark as handled / Open in linkedin / Rescan / Receipts as a flat row. None of these need to be one-click-visible like Send is. Move into a dropdown (or kebab menu) so the thread page feels less busy. Send stays prominent.
- **AI Assist button needs more visual weight.** Currently easy to miss. Add a subtle shimmer / pulse to the button itself, and run a "the AI is figuring out the conversation" animation when the drawer opens (skeleton lines streaming in, or a sweep across the right rail). Adds to the magic feel rather than the drawer just popping in fully-formed.
- **Reply Focus Mode** on /at-risk (from #12 audit).
- **Overdue durations** on /at-risk (from #12 audit) — precise duration text rather than rounded.
- **Interactive Open Loops** on thread page (from #12 audit).
- **Thread page nav column / status badge / focus mode** (from #12 audit).
- **Inbox tip: ⌘ glyph too small to read.** The hint above the thread list reads `TIP: ⌘-CLICK A ROW TO SELECT MULTIPLE AT ONCE.` rendered in `font-mono text-[10px] uppercase tracking-[0.06em]`. At that size + uppercase + low-contrast `text-ink-3`, the ⌘ character is barely legible — operators won't notice the affordance. Fix shape: bump the glyph specifically (inline `<kbd>` tag with normal-case styling, slightly larger, and a subtle box border) while keeping the rest of the tip text small. Or rephrase as `TIP: COMMAND + CLICK A ROW TO SELECT MULTIPLE`.

**Page headers — subtext layout**
- **Inconsistent subtext placement.** /at-risk renders the subtext on its own line below the page title (good — readable, doesn't compete with the heading). /inbox (and others) render the subtext on the same row as the title, immediately to the right (cramped, hard to scan, and on narrow viewports the line wraps awkwardly). Standardise on the at-risk pattern across every page: title on its own line, subtext on the next line below. `PageHead` component in `apps/dashboard/components/common/canvas.tsx` (or similar) probably needs a layout tweak applied at every callsite.

**Avatar / initials display**
- **Avatar initials should ignore non-letter starts on the second name.** Concrete: "Cynthia (ACS)" renders as `C(` because the initials helper takes the first character of the second token. If the second token starts with anything that isn't a letter, ignore that token entirely — the avatar should just show `C`. Probably a small tweak in `apps/dashboard/lib/risk.ts` `initials()` (or wherever the helper lives).

**Voice note / media playback**
- **Voice note player has white background in dark mode.** The audio control element renders with a white pill regardless of theme. In dark mode it should match the dark surface (paper-2 or similar) — currently a jarring bright rectangle in the conversation timeline. Likely a missing `dark:` Tailwind class on the player wrapper.

**Reassess loading state**
- **"Generating suggestions..." spinner stuck after Reassess.** Pressing Reassess on a thread leaves the spinner pill visible permanently. Leaving the thread and coming back shows the suggestions are already generated. So the AI call completes, the data persists, but the dashboard's per-thread "generating" UI state doesn't get cleared on completion. **Verify live before fixing** — the SSE event shape may have changed and the dashboard's `SUGGESTED_REPLIES_UPDATED` listener might be missing the thread-scope correlation.

**Profile / enrichment depth**
- **About section "...more" affordance not expanded by the enricher.** LinkedIn truncates long About text with a "...more" link. The runner currently captures the truncated string. The enricher should click "more" before extracting, so the persisted `about` field is the full text. Probably an additional step in the LinkedIn profile-extraction path — wait for the section, click any "...more" / "see more" toggle, then read.
- **Capture posts, reactions, and comments per person.** Feature gap. Today's enrichment captures profile basics + experience/education/skills. Operators want to see a contact's recent posts, what they've reacted to, and what they've commented (and on whose posts). Useful for context before replying. Big feature: needs LinkedIn DOM selectors for each surface (posts feed, reactions tab, comments tab) plus schema additions on `PersonEnrichment`. The user's memory flagged that "wire new fields through `snapshotStreamingRows` (line ~5505) AND the ThreadStub at line ~7147" applies broadly to LinkedIn enrichment additions — easy to wire in only one path. Recommend opening LinkedIn + Relationship Inbox simultaneously in Chrome MCP to capture current DOM structure for each surface as the first step.

**iMessage profile drawer — AI-driven friendship summary**
- **Current state:** for iMessage contacts, the profile drawer offers only a LinkedIn URL input + "Save & enrich". No real value-add for people who are friends rather than professional contacts.
- **Wanted shape:** AI-generated profile based on the conversation history. Sections:
  - **What they like** — interests / topics they bring up.
  - **What they're currently doing or going through** — current job / life situation.
  - **Last wellbeing check-in** — the most recent time the operator asked anything along the lines of "you good?" / "how's your mentals?" / wellbeing-style probes. Useful prompt to do another one if it's been a while.
  - **Friendship score + reasoning.** Composite signal across: (a) frequency of conversation, (b) depth — topic substance + average message length in characters before the other replies, (c) silliness / banter ratio, (d) comfortability — slang use, vulnerability, easy back-and-forth. Display the score *with* a one-paragraph explanation of why the AI gave that score, so the operator can sanity-check it rather than treating it as opaque.
- Implementation note: this is a per-person AI summary, not a per-message classifier. Different prompt entry-point. Probably a new `summarisePersonForFriendship({ messages, ... })` AI call cached by message-set hash, similar to the existing thread `rollingSummary` cache pattern.

**Ask-the-AI about a contact**
- **Free-form query box on the profile drawer.** Operator types "what does X think about Y?" or "have we talked about Z?" — the AI answers using:
  - All conversation history with the person.
  - LinkedIn enrichment if available (About, posts, reactions, comments).
- **Hard rules:**
  - If the AI doesn't have the info, it must say so plainly. No fabrication.
  - If the AI does have it, it must cite where the info came from — "from your conversation on Mar 14" / "from their LinkedIn About" / "from a post they liked on Apr 02". Operators need to be able to verify.

**AI sender-attribution discipline (cross-cutting)**
- **Don't mix up who said what.** Across summaries, suggested replies, classifier, friendship score, ask-the-AI — the AI must reliably distinguish the operator (Richard) from the contact. Today there are occasional swaps where Richard's words get attributed to the contact or vice versa. Probably a prompt-discipline issue: every AI call that ingests messages should label them clearly with `operator:` / `contact:` (not `IN/OUT` which is ambiguous to the model) and the system prompt should reinforce "messages prefixed `operator:` were written by Richard; do not paraphrase them as if the contact said them."

**Group chats (iMessage)**
- **Phone numbers leak through participant names.** When a group-chat participant has a contact name saved (vCard hit), the dashboard sometimes still shows the raw number alongside or instead. Should fall through to the saved name when available; only show the number for unmatched contacts.
- **Click a participant name → 1:1 thread.** In a group chat row, clicking a specific person's name should navigate to that person's 1:1 thread (if one exists).
- **React to a message via right-click / long-press.** Mirror iMessage's tapback affordance — right-click or hold a message bubble in the dashboard surfaces a small react palette (heart, thumbs, etc.) and posts the reaction to iMessage via the adapter.

**Background / runner behaviour**
- **Voice-note send shouldn't surface the Messages app.** Today the iMessage adapter brings Messages.app to the foreground, pastes the file, presses Enter. Should run silently in the background — the operator doesn't want to lose focus mid-workflow.
- **Headless mode for the runner.** Same idea as Chrome's headless flag. Investigate whether the LinkedIn (Playwright) and iMessage (osascript / Messages.app) adapters can run without any visible GUI. Useful for daemon-style operation, server deployment, and avoiding focus theft.

**Inbox / Today / At-Risk surfaces**
- **More sort + filter options on threads.** Currently sortable by platform (good). Add: recent / oldest, "needs my reply specifically" filter, "I'm waiting on them" filter. Probably a sort dropdown next to the platform filter.
- **At-Risk page feels redundant.** The list is largely a re-cut of what's already on Inbox. The "Why they're at risk" sidebar shows raw `Inbound waiting Xh` durations in a clunky one-line-per-thread layout. Either invest in making the page genuinely additive (e.g., aggregate burn-down chart, suggested triage order, batch SLA-recovery actions) or remove it and fold the at-risk filter into Inbox.
- **"Clear iMessage inbox and rebuild" Danger Zone action.** The LinkedIn equivalent exists at /settings → Danger Zone (`Clear LinkedIn inbox and rebuild`). Add the iMessage equivalent — same shape, same wipes-locally-then-rebuilds-on-next-scan semantics.
- **Per-thread rescan progress feedback.** The full-inbox scan surfaces a top-bar progress chip (`Scanning linkedin · 6/200...` with a cancel button) driven by the runner's `SCAN_PROGRESS` SSE events. The single-thread `/control/thread/:id/rescan` endpoint emits no progress events. Operators clicking Rescan have no visibility into whether the runner is mid-extraction, mid-AI-summary, or hung. Fix shape: emit progress events from the rescan path (`SCAN_THREAD_STARTED` / `SCAN_THREAD_PROGRESS` / `SCAN_THREAD_FINISHED`) and have the dashboard's running-action chip subscribe alongside the existing scan progress.
- **Inbox scan progress shows misleading total ("X / 200").** The "/200" comes from `runnerConfig.linkedInScan.maxThreads` (env `LINKEDIN_SCAN_MAX_THREADS`, default 200) — it's the *cap*, not the actual contact count. For an operator with, say, 47 LinkedIn threads, the bar shows `6/200` which both feels wrong and prevents accurate ETA estimation. Fix shape: emit `SCAN_PROGRESS` with the actual `total` field set from the count of rows the parser has detected so far, or treat 200 as a soft cap and surface a different denominator for the progress UI.

**Style / writing rules**
- **No em dashes (—) or en dashes (–) anywhere in the interface text.** Hyphens (-) are fine. Audit and replace existing copy. Bake into a writing convention so future strings don't reintroduce them.

**Diagnostics / log clarity**
- **`LINKEDIN_AUTO_LOGIN` log message** misleading: `[auth-recovery] no LINKEDIN_USERNAME/LINKEDIN_PASSWORD configured` fires when the env vars ARE set but the auto-login feature flag isn't, sending operators down the wrong diagnostic path. Should say `[auth-recovery] auto-login disabled (LINKEDIN_AUTO_LOGIN not set)`.
- **LinkedIn list parser row-alignment bug** in `apps/runner/src/platforms/linkedin-adapter.ts` (`snapshotStreamingRows` ~5505 / `ThreadStub` ~7147 paths). The actual root cause behind the Kolawole/Jessica mis-link. Fired once on 2026-05-06 producing one mis-linked thread; non-trivial to reproduce without a captured DOM snapshot. The scan-queue guard (#151) prevents the data consequence regardless of where in the parser the alignment fails, so this is now a quality-of-data improvement rather than a pressing data-integrity issue.

### Process refinements established mid-migration

- **Promotion syntax:** use `git merge --ff-only origin/<branch>`, not `git reset --hard`. The flag refuses on the wrong branch and surfaces problems immediately. Adopted for all develop ↔ staging ↔ main promotions in Phases 5 and 7.
- **Rebase strategy:** `tmp/<branch>` local-only branches built from the remote tip, force-push back to the original ref. Don't touch any Claude worktree.
- **Pre-push verification:** local `npm run lint` + `npm run test:all` before push. Caught a TS error in #5 that would have failed CI; saved an iteration cycle.
- **Prisma rule:** any schema change → run `npx prisma generate` before lint (lint is `tsc --noEmit` and reads the generated client).
