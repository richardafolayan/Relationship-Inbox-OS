# Tovi full product audit, QA, freshness, and performance hardening

Audit date: 2026-08-21

Product boundary: small 3-5 student pilot

Audited base: `origin/develop` at `fed0dad439a6fc628e2a3ce8befcc714bcacfe8b`

Audit branch: `chore/full-product-hardening`

Audit worktree: `/private/tmp/tovi-full-product-hardening`

Audited implementation commit: `6efd6206d76391ed44a744e2c726d9498f71759c`

## Executive truth

This was a product audit, not a test-suite proxy. The route tree, rendered
controls, persistence paths, recovery paths, scheduler, event flow, tests,
performance harnesses, open issues, and relevant pull requests were inspected
independently. Controlled browser work used isolated generated data. No real
message was sent, no live platform was disconnected, no real account was reset,
and no private message content was copied into this report or test data.

The audited application has **13 page routes in total**: the root redirect and
12 named pages. The unified product matrix below contains **143 distinct
user-facing or operator workflows**. That matrix is deliberately deduplicated;
the specialist matrices contain more checks because one workflow can have
desktop, phone, failure, accessibility, data-integrity, and freshness
observations.

The baseline was not safe to describe as "everything works." Its most important
confirmed risks were stale thread state crossing route boundaries, duplicate or
uncertain real-world send side effects, non-atomic focus acknowledgements,
misleading setup/settings success, insecure phone transport outside loopback,
and freshness that could remain unproven indefinitely. A broad contract suite
existed, but it had no true mounted-app smoke configuration and could silently
skip browser checks.

The implementation pass deliberately stayed aligned with the pilot: it removed
or redirected misleading legacy surface, made failure states truthful, guarded
thread identity and composer continuity, hardened durable send/reset/focus
state, moved the test entrypoints toward a real smoke contract, and retained
platform safety controls. It did not add a CRM, analytics, relationship scores,
automatic AI sending, or new platform behaviour.

### Baseline audit counts by specialist domain

These are raw specialist check counts, not additive product totals. They overlap
by design. Domains whose auditors reported test counts rather than a complete
status subtotal are recorded without inventing a subtotal.

| Domain | PASS | FAIL | BLOCKED | NOT APPLICABLE | Supporting scope |
| --- | ---: | ---: | ---: | ---: | --- |
| Route/product inventory | not separately subtotalled | not separately subtotalled | not separately subtotalled | not separately subtotalled | 13 pages, 5 route handlers, special states, 77 focused tests |
| Desktop | not separately subtotalled | not separately subtotalled | packaged/native gaps recorded below | not separately subtotalled | normal and constrained desktop; 116 tests |
| Phone/PWA | 21 | 4 | 13 | 0 | 38 checks; controlled Chromium plus source/contracts |
| Thread workspace | not separately subtotalled | not separately subtotalled | external sends recorded below | not separately subtotalled | every exposed action inspected; 296 tests |
| Onboarding/settings/operator/recovery | 26 | 50 | 4 | 2 | 82 checks; 208 tests |
| Data integrity/concurrency | 16 | 30 | 3 | 2 | 51 checks; 76 tests |
| Accessibility/UI quality | 16 | 15 | 7 | 1 | 39 checks; 194 tests |
| Performance/resource use | 17 | 6 | 5 | 2 | 30 checks; 27 performance tests |
| Freshness/resume/catch-up | 23 | 30 | 5 | 1 | 59 checks plus timed harnesses |
| Automated test quality | 11 | 38 | 3 | 1 | 53 checks across 407 baseline test files |

## Scope, evidence, and status rules

Status has one of four values only:

- **PASS**: observed in a controlled browser or exercised by a behavioural
  contract that crosses the relevant boundary. Source presence alone is not a
  pass.
- **FAIL**: reproduced in controlled execution, or a deterministic source path
  proves the user-visible contract cannot hold. The defect register says which.
- **BLOCKED**: the exact remaining environment or safety dependency is stated.
- **NOT APPLICABLE**: the check is genuinely outside the platform or feature
  contract, not merely difficult to run.

Evidence labels used below:

- **BR**: controlled mounted browser against generated data.
- **AUT**: deterministic behavioural/contract automation.
- **DB**: isolated production-schema SQLite exercise.
- **MEASURED**: repeatable timing or request-count measurement.
- **SOURCE-INFERRED**: deterministic code-path finding not physically triggered.
- **PHYSICAL**: real device, packaged runtime, or provider session. No row is
  labelled PHYSICAL unless that boundary was actually crossed.

The initial full run used the packaged Node 22.23.2 runtime. It discovered 407
test files and 2,754 runtime tests. There were 18 failures: 16 were a local
`better-sqlite3` ABI mismatch and passed 21/21 after rebuilding for Node 22; two
browser aggregate-load failures passed as 1/1 and 7/7 when isolated. That is an
environment/isolation diagnosis, not permission to dismiss the failures.

## Establishing the baseline

- `git fetch origin --prune` was run before the initial branch decision.
- The audit began from the then-current `origin/develop` tip
  `fed0dad439a6fc628e2a3ce8befcc714bcacfe8b` with a clean worktree.
- The dedicated worktree and branch above were created so no other session's
  branch or working copy would be modified.
- `origin/develop` advanced after the audit started. The audit remained pinned
  to the recorded commit so its evidence and measurements stayed coherent.
- Existing work already solved large-list Inbox mounting, compressed response
  caching, event-driven message propagation, stable command-palette navigation,
  responsive mobile foundations, dictation continuity, send queuing, and many
  platform-specific guards. Those claims were rechecked rather than assumed
  from documentation.
- Read-only investigation could run in parallel by route/product, desktop,
  phone, thread, settings/recovery, integrity, accessibility, performance,
  freshness, and test-quality domains. Implementation was sequential in the
  high-conflict files.
- High-conflict files were `apps/dashboard/app/thread/[id]/page.tsx`,
  `apps/dashboard/components/layout/app-shell.tsx`,
  `apps/dashboard/app/settings/page.tsx`, `apps/runner/src/index.ts`,
  `apps/runner/src/services/send.ts`, and
  `apps/runner/src/services/scan-queue.ts`.
- Open PR #1045 owns Instagram. It was inspected only. Instagram implementation,
  selectors, automation, and shared platform adapter work were not changed or
  merged. PR #1047 was reviewed as a source of possible fixes; unsafe cleanup,
  reply-parent, and attachment-deletion changes were not copied wholesale.

## Environment

| Item | Value |
| --- | --- |
| Host | Apple Silicon Mac, Darwin 25.3.0, macOS 26.3 (25D125) |
| Time zone | Europe/London |
| Supported runtime | bundled Node 22.23.2, ABI 127, npm 10.9.8 |
| Browser used for controlled Chromium work | Google Chrome 151.0.7922.170 through Patchright |
| Official mounted-smoke harness | Playwright 1.62.1; five projects in `playwright.config.ts`; 10 applicable cases passed and 25 project-inapplicable cases intentionally skipped |
| Required browser-fixture harness | Patchright; 45/45 fixtures passed in the final full suite |
| Desktop viewports | 1440 x 900 and 1024 x 700 |
| Phone viewports | 390 x 844, 360 x 640, and 360 x 800 contracts/projects |
| Data | isolated SQLite production schema; large fixture 1,000 threads / 20,000 messages |
| Runtime endpoints used for measurement | loopback dashboard and runner; external scanning disabled |
| External accounts | no live LinkedIn, Instagram, WhatsApp, Google Messages, AI billing, or send target used |
| Physical-device boundary | no physical iPhone or Android device was available |
| Packaged boundary | source/runtime contracts inspected; a full packaged Electron interaction pass was not available |

## Route tree inventory

There are **13 App Router page endpoints total**, including the root redirect.
The 12 named pages are not inferred from navigation; they come from the checked
route tree.

| Route | Kind and ownership | Primary states and controls | Baseline evidence |
| --- | --- | --- | --- |
| `/` | server page redirect | redirects to `/today` | `apps/dashboard/app/page.tsx:1`; AUT route inventory |
| `/today` | primary pilot page | hero thread, open, snooze, handled, queue sections, focus rail, scan failure | `apps/dashboard/app/today/page.tsx:397`; `tests/dashboard-today-queue.test.mjs` |
| `/inbox` | primary pilot page | search, risk tabs, platform/category/group/favourite filters, sort, select, bulk done/snooze/rescan, Show more, receipts, archive link | `apps/dashboard/app/inbox/page.tsx:261`; Inbox contract tests |
| `/thread/[id]` | dynamic primary workspace | timeline, pagination, back/source, brief, checklist, memory, composer, draft, attachment, dictation, schedule, AI, message actions, menus/drawers | `apps/dashboard/app/thread/[id]/page.tsx:559`; thread contract tests |
| `/search` | phone Search route | query, result selection, cancel/back | `apps/dashboard/app/search/page.tsx:6`; `tests/dashboard-mobile-search.test.mjs` |
| `/reconnect` | primary LinkedIn-only page | ranked candidates, reason disclosure, refresh, thread open, Search access | `apps/dashboard/app/reconnect/page.tsx:85`; reconnect tests |
| `/archived` | secondary page | factual archived list, search/filter, select, restore, failure/empty/loading | `apps/dashboard/app/archived/page.tsx:1`; `tests/dashboard-archived-contract.test.mjs` |
| `/settings` | primary/secondary sections | accounts, capture, appearance, notifications, voice, focus/calendar, privacy/data, updates, pilot actions | `apps/dashboard/app/settings/page.tsx:138`; settings tests |
| `/platforms` | hidden operator page | status, connect, update/full scan, browser, selector diagnostics, reset | `apps/dashboard/app/platforms/page.tsx:1`; platform tests |
| `/people` | hidden secondary page | list/detail, notes, groups, profile URL, conversation ideas, enrichment, scan all, Inbox search | `apps/dashboard/app/people/page.tsx:26`; people tests |
| `/logs` | hidden operator page | activity list, loading, empty, failure/retry | `apps/dashboard/app/logs/page.tsx:1`; operator route tests |
| `/demo` | hidden demo/presenter page | safe sample mode, guided flow, failure/retry | `apps/dashboard/app/demo/page.tsx:1`; demo tests |
| `/at-risk` | legacy route | baseline duplicate dashboard; hardening redirects to `/today` | base `apps/dashboard/app/at-risk/page.tsx:1`; `tests/dashboard-at-risk-focus.test.mjs` |

### Non-page App Router surface

| Surface | Purpose | Evidence |
| --- | --- | --- |
| `POST /api/local-runner/start` | local runner recovery/bootstrap | `apps/dashboard/app/api/local-runner/start/route.ts:1` |
| `/api/phone-access` | same-Wi-Fi phone-access exchange | `apps/dashboard/app/api/phone-access/route.ts:1` |
| `/api/viewport-diagnostics` | opt-in viewport diagnostics intake | `apps/dashboard/app/api/viewport-diagnostics/route.ts:1` |
| `/api/viewport-diagnostics/handoff` | diagnostics handoff | `apps/dashboard/app/api/viewport-diagnostics/handoff/route.ts:1` |
| `/events-proxy` | dashboard-to-runner SSE proxy | `apps/dashboard/app/events-proxy/route.ts:1` |
| `manifest.ts` | PWA metadata | `apps/dashboard/app/manifest.ts:1` |
| global `error.tsx` | unexpected page failure | `apps/dashboard/app/error.tsx:1` |
| global `not-found.tsx` | missing route/thread presentation | `apps/dashboard/app/not-found.tsx:1` |
| `today/loading.tsx` | Today loading skeleton | `apps/dashboard/app/today/loading.tsx:1` |
| `inbox/loading.tsx` | Inbox loading skeleton | `apps/dashboard/app/inbox/loading.tsx:1` |
| `archived/loading.tsx` | Archived loading skeleton | `apps/dashboard/app/archived/loading.tsx:1` |
| `thread/[id]/loading.tsx` | thread loading skeleton | `apps/dashboard/app/thread/[id]/loading.tsx:1` |

## Unified feature and workflow matrix

This is the one deduplicated inventory used for the final feature count. Initial
status describes the audited base. Current status describes the hardening
worktree at the recorded implementation boundary. `PASS*` is not used: every
cell remains one of the four required
statuses.

| ID | Route/surface | Distinct workflow or state | Initial | Current | Evidence / exact block reason |
| --- | --- | --- | --- | --- | --- |
| WF-001 | global | root opens Today | PASS | PASS | AUT `apps/dashboard/app/page.tsx:1` |
| WF-002 | global | desktop sidebar route navigation | PASS | PASS | BR; primary route smoke at `tests/e2e/product-smoke.spec.ts:11` |
| WF-003 | global | phone bottom-dock navigation | PASS | PASS | controlled Chromium; `tests/dashboard-mobile-layout.test.mjs` |
| WF-004 | global | Command-K opens/closes | PASS | PASS | AUT command-palette tests |
| WF-005 | global | command query and destination selection | PASS | PASS | AUT `tests/dashboard-command-palette-search.test.mjs` |
| WF-006 | global | command keyboard focus/active descendant | FAIL | PASS | `apps/dashboard/components/layout/command-palette.tsx:171,194,202,203`; navigation tests |
| WF-007 | global | focus returns to palette opener | FAIL | PASS | opener capture/restore at `apps/dashboard/components/layout/app-shell.tsx:193,207`; Playwright smoke at `tests/e2e/product-smoke.spec.ts:73-93` |
| WF-008 | global | notification centre opens and resolves notices | PASS | PASS | AUT `tests/dashboard-notification-center.test.mjs` |
| WF-009 | global | visible-tab new-message toast | PASS | PASS | AUT notification tests |
| WF-010 | global | hidden-tab OS notification | BLOCKED | BLOCKED | OS permission and packaged-notification delivery not available |
| WF-011 | global | light theme visual state | BLOCKED | BLOCKED | full deterministic screenshot/contrast pass not completed physically |
| WF-012 | global | dark theme visual state | PASS | PASS | AUT `tests/dashboard-dark-mode-styles.test.mjs`; token inspection |
| WF-013 | global | runner offline recovery control | FAIL | FAIL | runner restart is attempted, but failure/retry state remains incompletely exercised |
| WF-014 | global | SSE reconnect resumes without replay storm | FAIL | PASS | cursor validation fix; `tests/runner-sse-resume-cursor.test.mjs` |
| WF-015 | global | global error reset/retry | PASS | PASS | source contract `app/error.tsx:1`; controlled error route |
| WF-016 | global | unknown route shows not-found | PASS | PASS | `app/not-found.tsx:1`; route inventory |
| WF-017 | Today | cached useful queue renders | PASS | PASS | BR large fixture; `dashboard-today-queue` |
| WF-018 | Today | next-needed hero opens exact thread | PASS | PASS | AUT Today queue + thread identity tests |
| WF-019 | Today | hero snooze until tomorrow | PASS | PASS | AUT Today controls / runner snooze contracts |
| WF-020 | Today | hero mark handled | PASS | PASS | AUT Today controls / mark-done contracts |
| WF-021 | Today | hero favourite presentation/order | PASS | PASS | AUT favourites + Today sort tests |
| WF-022 | Today | lower queue sections and jump control | PASS | PASS | AUT `dashboard-today-queue.test.mjs` |
| WF-023 | Today | focus reply buffer rail | PASS | PASS | AUT focus helper/rail tests |
| WF-024 | Today | scan degraded notice | PASS | PASS | AUT consumer failure tests |
| WF-025 | Today | loading state | PASS | PASS | route loader + controlled slow response |
| WF-026 | Today | truthful empty/caught-up state | PASS | PASS | AUT Today queue tests |
| WF-027 | Today | immediately refreshes on persisted-message event | FAIL | PASS | `MESSAGES_PERSISTED` added to Inbox event set; event tests |
| WF-028 | Today | multi-client refresh does not multiply scans | FAIL | FAIL | measured duplicate browser-owned scheduling remains a freshness risk |
| WF-029 | Inbox | cached list renders | PASS | PASS | BR 1,000-thread fixture |
| WF-030 | Inbox | text search across loaded set | PASS | PASS | AUT query tests; BR interaction timing |
| WF-031 | Inbox | clear search | PASS | PASS | BR interaction timing |
| WF-032 | Inbox | status/risk tabs | PASS | PASS | AUT Inbox query/empty tests |
| WF-033 | Inbox | platform filter | PASS | PASS | AUT Inbox source contracts |
| WF-034 | Inbox | category filter | PASS | PASS | AUT Inbox source contracts |
| WF-035 | Inbox | priority-group filter | PASS | PASS | AUT group tests |
| WF-036 | Inbox | favourites-only filter | PASS | PASS | AUT favourites tests |
| WF-037 | Inbox | clear individual/all filters | PASS | PASS | BR/AUT interaction contracts |
| WF-038 | Inbox | oldest/recent/name sort | PASS | PASS | AUT Inbox source contract |
| WF-039 | Inbox | favourites retain risk-bucket semantics | PASS | PASS | AUT `dashboard-favourites.test.mjs` |
| WF-040 | Inbox | select mode and row selection | PASS | PASS | BR interaction timing |
| WF-041 | Inbox | bulk mark done | PASS | PASS | AUT bulk controls |
| WF-042 | Inbox | bulk snooze | PASS | PASS | AUT bulk controls |
| WF-043 | Inbox | bulk rescan | PASS | PASS | AUT `dashboard-inbox-bulk-rescan.test.mjs` |
| WF-044 | Inbox | open exact conversation | PASS | PASS | BR smoke and identity tests |
| WF-045 | Inbox | initial 80-row window | PASS | PASS | AUT `dashboard-inbox-pagination.test.mjs` |
| WF-046 | Inbox | Show more mounts next window | PASS | PASS | AUT pagination + measured p95 |
| WF-047 | Inbox | recent-horizon show all/less | PASS | PASS | AUT horizon tests |
| WF-048 | Inbox | receipts drawer | PASS | PASS | AUT receipt contracts |
| WF-049 | Inbox | loading/empty/degraded states | PASS | PASS | loaders + failure tests |
| WF-050 | Inbox | phone tools do not clip/overflow | FAIL | FAIL | reproduced at 390 px; toolbar horizontal clipping remains |
| WF-051 | Thread | initial exact-thread load | PASS | PASS | BR smoke; AUT thread contracts |
| WF-052 | Thread | rapid A-to-B route switch cannot show A | FAIL | PASS | fixed identity generation guard; route-safety tests |
| WF-053 | Thread | Inbox/Today/source-aware Back | FAIL | PASS | fixed source + fallback; source tests |
| WF-054 | Thread | unsent composer survives sibling navigation | FAIL | PASS | fixed per-thread session store; composer-session tests |
| WF-055 | Thread | long sibling rail is windowed | FAIL | PASS | bounded to an initial 80 links; sibling-window tests and mounted DOM measurement |
| WF-056 | Thread | message timeline pagination | PASS | PASS | AUT thread message cursor tests |
| WF-057 | Thread | long-message layout | PASS | PASS | controlled stress fixture/source contracts |
| WF-058 | Thread | large attachment layout | BLOCKED | BLOCKED | no deterministic large-media browser fixture or physical device pass |
| WF-059 | Thread | reply brief and current ask | PASS | PASS | AUT reply-brief tests |
| WF-060 | Thread | open-loop checklist/dismissal | PASS | PASS | AUT action-items tests |
| WF-061 | Thread | draft-coverage check | PASS | PASS | AUT runner draft coverage contracts |
| WF-062 | Thread | relationship memory/context | PASS | PASS | AUT runner thread shaping contracts |
| WF-063 | Thread | typed composer input | PASS | PASS | BR p50/p95 interaction benchmark |
| WF-064 | Thread | persisted draft save/delete | FAIL | PASS | uniqueness/persistence hardening; draft tests |
| WF-065 | Thread | immediate queued send | FAIL | PASS | duplicate guard + durable send tests; no live external send |
| WF-066 | Thread | delivery success only after local SENT write | FAIL | PASS | reordered terminal state; send-integrity tests |
| WF-067 | Thread | failed-send explicit retry is idempotent | FAIL | PASS | retry identity reuse; send-integrity tests |
| WF-068 | Thread | scheduled send create | PASS | PASS | AUT scheduled-send tests |
| WF-069 | Thread | scheduled send preserves reply/attachments | FAIL | PASS | send service and dashboard payload regression tests |
| WF-070 | Thread | scheduled edit/cancel race safety | PASS | PASS | AUT scheduled race tests |
| WF-071 | Thread | attachment-only send persists/reconciles | PASS | PASS | base already accepted attachment-only immediate sends; thread/send regression tests |
| WF-072 | Thread | attachment failure restores composer media | PASS | PASS | AUT composer attachment restore tests |
| WF-073 | Thread | voice attachment recording | BLOCKED | BLOCKED | real microphone/device capture unavailable; preparation contracts pass |
| WF-074 | Thread | dictation to editable composer | PASS | PASS | controlled dictation contracts; no physical mic claim |
| WF-075 | Thread | dictation cannot leak A transcript into B | FAIL | PASS | route-scoped generation guard; dictation/thread safety tests |
| WF-076 | Thread | AI Assist transforms user text | PASS | PASS | controlled provider fixture; full-screen tests |
| WF-077 | Thread | optional full predraft remains opt-in | PASS | PASS | settings/source contracts |
| WF-078 | Thread | Reassess is single-flight and refreshes | FAIL | FAIL | several AI/reassess race windows remain source-inferred |
| WF-079 | Thread | snooze/unsnooze/reminder | PASS | PASS | AUT thread action targets |
| WF-080 | Thread | archive/restore | PASS | PASS | AUT archive rules and page contracts |
| WF-081 | Thread | mark handled | PASS | PASS | AUT canonical target tests |
| WF-082 | Thread | favourite toggle/reorder | FAIL | FAIL | optimistic success can race order refresh |
| WF-083 | Thread | profile drawer/rename/name suggestion | PASS | PASS | profile/name tests |
| WF-084 | Thread | reactions/edit source message | BLOCKED | BLOCKED | requires safe authenticated LinkedIn target; contracts only |
| WF-085 | Thread | WhatsApp poll compose, durable send, and restart-safe replay | FAIL | PASS | AUT durable request/receipt/client-ID replay and restart contracts; no live provider send claimed |
| WF-085A | Thread | WhatsApp poll vote and live tallies against a real provider | BLOCKED | BLOCKED | requires a safe authenticated WhatsApp target and participants |
| WF-086 | Thread | open source thread/profile | BLOCKED | BLOCKED | external authenticated browser/OS handoff not exercised |
| WF-087 | Search | phone Search route opens internally | PASS | PASS | AUT/BR mobile Search |
| WF-088 | Search | query returns controlled conversations | PASS | PASS | AUT search recovery; BR fixture |
| WF-089 | Search | result opens exact thread | PASS | PASS | mobile Search + identity tests |
| WF-090 | Search | cancel/back returns to source | PASS | PASS | controlled browser route contract |
| WF-091 | Reconnect | ranked LinkedIn candidates | PASS | PASS | AUT reconnect ranking tests |
| WF-092 | Reconnect | reason disclosure | PASS | PASS | AUT reconnect tests |
| WF-093 | Reconnect | refresh score running/success/error | PASS | PASS | AUT refresh tests |
| WF-094 | Reconnect | thread open | PASS | PASS | source contract |
| WF-095 | Reconnect | desktop palette Search access | FAIL | PASS | added in mobile/desktop search contracts |
| WF-096 | Reconnect | mobile Search access | FAIL | PASS | added; mobile-search tests |
| WF-097 | Archived | explicit archived rows only | FAIL | PASS | removed inferred handled/snoozed/cold rows; archive contract test |
| WF-098 | Archived | search/filter | PASS | PASS | controlled source contract |
| WF-099 | Archived | selection | FAIL | PASS | nested-control fix; archive contract test |
| WF-100 | Archived | restore | PASS | PASS | archive contracts |
| WF-101 | Archived | loading/empty | PASS | PASS | route loader + empty contract |
| WF-102 | Archived | runner failure/retry | FAIL | PASS | explicit error/retry; operator-route tests |
| WF-103 | Settings | mobile section list/back | PASS | PASS | AUT mobile subpage tests |
| WF-104 | Settings | accounts/platform visibility | PASS | PASS | AUT platform visibility |
| WF-105 | Settings | scan on/off/cadence truth | FAIL | FAIL | UI preference and runner scheduling still have split ownership |
| WF-106 | Settings | quiet-hours persistence | FAIL | FAIL | quiet-hours save ordering was not changed in this pass |
| WF-107 | Settings | theme/UI scale | PASS | PASS | AUT UI-scale/dark-mode tests |
| WF-108 | Settings | notification preference/permission | PASS | PASS | AUT notification settings/race tests |
| WF-109 | Settings | voice profile save | FAIL | FAIL | voice profile save ordering was not changed in this pass |
| WF-110 | Settings | infer voice style | BLOCKED | BLOCKED | billable AI/provider and sent-message corpus not exercised live |
| WF-111 | Settings | focus defaults/templates | FAIL | PASS | defaults no longer overwrite failed loads; focus settings tests |
| WF-112 | Settings | calendar focus save/preview | FAIL | PASS | serialized save/failure state; calendar tests |
| WF-113 | Settings | overdue digest settings/actions | PASS | PASS | AUT digest tests |
| WF-114 | Settings | complete data reset, including interruption recovery | FAIL | FAIL | owned-media cleanup is fixed, but the multi-table reset is not one atomic transaction; no real reset |
| WF-115 | Settings | update check/details/install intent | FAIL | FAIL | update intent/readiness were audited but not changed |
| WF-116 | Settings | feedback/bug submission | PASS | PASS | controlled webhook/copy contracts; no real private content |
| WF-117 | Settings | welcome/setup reset | PASS | PASS | AUT pilot/setup tests |
| WF-118 | Platforms | platform state cards | FAIL | FAIL | read failures can still resemble empty/unavailable in parts of route |
| WF-119 | Platforms | Connect action | BLOCKED | BLOCKED | Instagram-owned/shared external authentication boundary |
| WF-120 | Platforms | update/full scan actions | BLOCKED | BLOCKED | live provider scanning intentionally not exercised |
| WF-121 | Platforms | browser/selector diagnostics | BLOCKED | BLOCKED | live authenticated browser/session risk |
| WF-122 | Platforms | reset session | BLOCKED | BLOCKED | destructive live action forbidden without explicit permission |
| WF-123 | People | list loading/empty/error/retry | FAIL | PASS | truthful states added; operator-route tests |
| WF-124 | People | expand exact detail/latest request wins | PASS | PASS | AUT people latest-request tests |
| WF-125 | People | notes/groups/profile URL | FAIL | FAIL | save failure can still lose local edits in some paths |
| WF-126 | People | Open in Inbox filters the person | FAIL | PASS | `?person` replaced with supported `?q`; navigation tests |
| WF-127 | People | conversation ideas are non-clickable guidance | FAIL | PASS | dead opener buttons changed to calm content |
| WF-128 | People | manual enrichment | BLOCKED | BLOCKED | external research/provider not exercised |
| WF-129 | People | scan new/all | BLOCKED | BLOCKED | external platform scan not exercised |
| WF-130 | Logs | activity list | PASS | PASS | controlled fixture/source contract |
| WF-131 | Logs | truthful empty | PASS | PASS | operator route tests |
| WF-132 | Logs | failure/retry | FAIL | PASS | explicit retry added; operator route tests |
| WF-133 | Demo | seeded sample flow | PASS | PASS | full-demo contracts |
| WF-134 | Demo | presenter write guards | PASS | PASS | runner presenter guard tests |
| WF-135 | Demo | load failure/retry without leaving mode | FAIL | PASS | explicit retry; operator route tests |
| WF-136 | At Risk | legacy duplicate is not a second workflow | FAIL | PASS | route now redirects to Today; route test |
| WF-137 | Setup | first-run status load | FAIL | PASS | load failures no longer complete/advance; setup tests |
| WF-138 | Setup | profile save | FAIL | PASS | await persistence before advance; setup tests |
| WF-139 | Setup | source selection save | FAIL | PASS | serialized preference writes; setup tests |
| WF-140 | Setup | account/connect/contact/AI/transcription steps | BLOCKED | BLOCKED | external auth, Contacts permission, AI key, download, mic not physically exercised |
| WF-141 | Setup | finish marker is durable before entering app | FAIL | PASS | completion is gated on both writes; setup tests |
| WF-142 | phone access | pairing bearer uses secure transport by default | FAIL | PASS | loopback-only proxy plus HTTPS/Tailscale route; plain HTTP returns 426/no cookie; 14 controlled tests |

### Unified matrix totals

The exact totals below are derived from the 143 explicit `WF-` rows, not from
adding overlapping specialist checks.

| State | Initial | Current before final verification |
| --- | ---: | ---: |
| PASS | 83 | 116 |
| FAIL | 45 | 12 |
| BLOCKED | 15 | 15 |
| NOT APPLICABLE | 0 | 0 |
| Total | 143 | 143 |

## Desktop coverage matrix

The desktop pass combined 1440 x 900 and 1024 x 700 controlled Chromium,
behavioural contracts, and source-level native-boundary inspection. "Blocked"
does not mean assumed broken; it means the available environment could not prove
the requested physical boundary safely.

| ID | Check | Status | Evidence / block reason |
| --- | --- | --- | --- |
| DT-01 | root/sidebar navigation | PASS | BR route smoke |
| DT-02 | Today to thread and return | PASS | BR smoke plus thread-source tests |
| DT-03 | Inbox to thread and return | PASS | BR/performance harness |
| DT-04 | deep-linked exact thread | PASS | BR and identity-guard contracts |
| DT-05 | browser Back from deep link | PASS | controlled source fallback after hardening |
| DT-06 | Command-K keyboard open/search/select | PASS | BR/AUT command tests |
| DT-07 | command semantic combobox/options | PASS | AUT after hardening |
| DT-08 | command focus restoration | PASS | AUT/BR after hardening |
| DT-09 | menus close with Escape/click-outside | PASS | AUT menu/action contracts |
| DT-10 | overlays retain a usable close path | PASS | AUT overlay-controller contracts |
| DT-11 | normal text entry | PASS | BR composer samples |
| DT-12 | typed unsent text survives thread navigation | PASS | hardening regression test |
| DT-13 | dictation result remains route-scoped | PASS | hardening regression test |
| DT-14 | loading transitions | PASS | controlled route loaders |
| DT-15 | empty Today/Inbox/Archived/People/Logs/Demo states | PASS | AUT route-state contracts after hardening |
| DT-16 | runner error is distinguished from empty data | PASS | AUT consumer/operator route failures after hardening |
| DT-17 | long Inbox mounts a bounded window | PASS | BR 1,000-thread fixture; 80 DOM rows |
| DT-18 | long sibling rail mounts a bounded window | PASS | hardening sibling-window tests |
| DT-19 | long thread text wraps | PASS | controlled stress data/source contract |
| DT-20 | scroll remains with main content | PASS | shell viewport/mobile scroller contracts |
| DT-21 | resize 1440 to 1024 preserves usable controls | PASS | controlled Chromium sizes |
| DT-22 | no broken internal navigation in inventoried pages | PASS | route smoke/route tree |
| DT-23 | dead People conversation-opener clicks | PASS | removed in hardening; navigation tests |
| DT-24 | duplicate rapid reviewed send | PASS | hardening single-flight test; no external send |
| DT-25 | stale A response after rapid A-to-B route switch | PASS | hardening route identity test |
| DT-26 | list scroll/filter/focus survives a thread round trip | FAIL | initial state still lives in page-local React state |
| DT-27 | intermittent route churn under overlapping responses | PASS | identity generation guard fixes the deterministic stale-write path |
| DT-28 | packaged Electron menus/window/deep links | BLOCKED | no isolated packaged interactive session |
| DT-29 | window bounds on first launch/small display | BLOCKED | physical Electron/window-manager check unavailable; issue #998 remains relevant |
| DT-30 | OS notifications with permission granted/denied | BLOCKED | packaged notification permission UI unavailable |
| DT-31 | full offline-to-online recovery | BLOCKED | deterministic network fault injection was not available in mounted run |
| DT-32 | runner process restart while page stays mounted | BLOCKED | API contracts inspected; full process/browser recovery not completed |
| DT-33 | light-mode complete visual audit | BLOCKED | token inspection found contrast failures; deterministic visual baseline not completed |
| DT-34 | large mixed attachment gallery | BLOCKED | no privacy-safe browser media stress fixture was present |
| DT-35 | idle CPU/memory for packaged app | BLOCKED | source dev processes are not representative of Electron packaging |

Initial confirmed desktop defects were unsaved composer loss, list-local state
loss, command-palette semantics/focus, Electron bounds risk, and route-response
churn. The hardening pass addressed the composer, palette, and route-identity
roots. List restoration and physical Electron bounds remain follow-up work.

## Phone and PWA coverage matrix

The baseline phone audit contains exactly **38 checks: 21 PASS, 4 FAIL, and 13
BLOCKED**. The current hardening snapshot is **23 PASS, 3 FAIL, and 12
BLOCKED**. The final automated matrix includes Chromium and WebKit, but neither
is described as physical iOS/device proof.

| ID | Check | Baseline | Current | Evidence / exact block reason |
| --- | --- | --- | --- | --- |
| PH-01 | Today at 390 x 844 | PASS | PASS | controlled Chromium/source contract |
| PH-02 | Today at 360 x 640 | PASS | PASS | responsive contract |
| PH-03 | bottom dock routes internally | PASS | PASS | AUT PWA/mobile layout |
| PH-04 | internal links do not intentionally open a new browser | PASS | PASS | PWA navigation contracts |
| PH-05 | Search is a real route | PASS | PASS | mobile Search tests |
| PH-06 | Search query/result selection | PASS | PASS | controlled fixture |
| PH-07 | thread timeline reads at normal height | PASS | PASS | phone layout contracts |
| PH-08 | composer visible in normal visual viewport | PASS | PASS | mobile composer contract |
| PH-09 | action sheet opens/closes | PASS | PASS | action-sheet tests |
| PH-10 | one overlay owns interaction at a time | PASS | PASS | overlay-controller tests |
| PH-11 | standard fixture has no horizontal page overflow | PASS | PASS | mobile-layout tests |
| PH-12 | long names clamp/wrap | PASS | PASS | stress content contract |
| PH-13 | long previews clamp/wrap | PASS | PASS | stress content contract |
| PH-14 | safe-area CSS is applied | PASS | PASS | layout source + tests |
| PH-15 | media URLs remain same-origin/proxied | PASS | PASS | media-url tests |
| PH-16 | mobile toast is reachable/dismissible | PASS | PASS | mobile-toast tests |
| PH-17 | status chrome fits | PASS | PASS | status-chrome tests |
| PH-18 | Settings uses mobile subpages/back | PASS | PASS | settings mobile tests |
| PH-19 | notification settings fit | PASS | PASS | notifications settings test |
| PH-20 | feedback modal scrolls | PASS | PASS | feedback modal scroll test |
| PH-21 | demo/tour anchors remain reachable | PASS | PASS | guided-tour/mobile demo tests |
| PH-22 | all visible targets are at least 44 x 44 CSS px | FAIL | FAIL | reproduced: several controls below 44 px |
| PH-23 | 390 x 400 keyboard-like viewport leaves usable timeline | FAIL | FAIL | reproduced: about 45.2 px of timeline remained |
| PH-24 | thread header Back returns to actual source | FAIL | PASS | baseline hard-coded Today fallback; thread-source hardening/tests |
| PH-25 | Inbox tool carousel does not clip controls | FAIL | FAIL | reproduced at 390 px |
| PH-26 | current iPhone WebKit projects | BLOCKED | PASS | both Playwright WebKit projects completed their applicable phone navigation/layout contract in the final mounted smoke; this is automated WebKit, not physical iPhone proof |
| PH-27 | physical iPhone Safari | BLOCKED | BLOCKED | no physical iPhone available |
| PH-28 | installed standalone PWA launch | BLOCKED | BLOCKED | requires physical/Simulator install lifecycle |
| PH-29 | no Safari breakout in installed PWA | BLOCKED | BLOCKED | installed standalone context unavailable |
| PH-30 | real iOS keyboard opening | BLOCKED | BLOCKED | emulated viewport cannot prove iOS keyboard behaviour |
| PH-31 | real iOS keyboard closing | BLOCKED | BLOCKED | same physical boundary |
| PH-32 | `visualViewport` changes during keyboard animation | BLOCKED | BLOCKED | real Safari keyboard boundary unavailable |
| PH-33 | iOS back gesture | BLOCKED | BLOCKED | gesture/device boundary unavailable |
| PH-34 | portrait/landscape rotation | BLOCKED | BLOCKED | device/simulator rotation unavailable |
| PH-35 | coarse-touch hit accuracy | BLOCKED | BLOCKED | mouse automation is not physical touch proof |
| PH-36 | browser/device chrome never covers controls | BLOCKED | BLOCKED | physical Safari/Android chrome unavailable |
| PH-37 | sleep/network-loss restoration | BLOCKED | BLOCKED | physical lifecycle/network fault injection unavailable |
| PH-38 | large real attachment gallery on device | BLOCKED | BLOCKED | no privacy-safe physical media fixture/device |

## Failure and recovery coverage

| ID | Failure/recovery contract | Status | Evidence / exact block reason |
| --- | --- | --- | --- |
| RC-01 | runner unavailable on initial page load | PASS | dashboard API recovery contracts distinguish runner state |
| RC-02 | local runner start endpoint failure | PASS | AUT local-runner/API error contract |
| RC-03 | runner recovers after a failed read | PASS | AUT retry/error route contracts |
| RC-04 | runner restarts while mounted clients retain state | BLOCKED | full process/browser lifecycle not completed |
| RC-05 | request timeout returns actionable error | PASS | API request timeout/recovery contracts |
| RC-06 | request fails then succeeds on retry | PASS | People/Logs/Demo/Archived controlled retry paths |
| RC-07 | SSE disconnect/reconnect | PASS | cursor hardening unit coverage |
| RC-08 | stale/high SSE cursor after runner restart | PASS | high-cursor reset regression test |
| RC-09 | stale browser response for old thread | PASS | route-generation identity regression test |
| RC-10 | missing/invalid thread | PASS | thread fetch/not-found contracts |
| RC-11 | disconnected platform surfaced truthfully | PASS | platform availability/error-in-use tests |
| RC-12 | authenticated session expires during scan | BLOCKED | no live safe provider session |
| RC-13 | scan already running/cooldown response | PASS | scan-queue enqueue/in-flight tests |
| RC-14 | repeated rapid send click | PASS | send/dictation UI single-flight regression tests |
| RC-15 | repeated rapid phone tap | FAIL | sub-44 targets and several action rows lack physical tap verification |
| RC-16 | two dashboard clients reading | PASS | measured request multiplication; data reads remain valid |
| RC-17 | two dashboard clients do not duplicate scheduled scans | FAIL | 28 requests observed and each shell owns a scheduler |
| RC-18 | two concurrent send requests, same client ID | PASS | DB/send integrity regression tests |
| RC-19 | duplicate insert raises Prisma P2002 | PASS | re-read canonical row hardening test |
| RC-20 | adapter succeeds, terminal DB write fails | PASS | no false success after hardening; send-integrity test |
| RC-21 | retry after uncertain side effect | PASS | in-doubt claim remains guarded; send claim tests |
| RC-22 | AI provider unavailable | PASS | prior state preserved by AI fallback/error contracts |
| RC-23 | database write fails during focus auto-ack | PASS | acknowledgement recorded after durable outcome; regression test |
| RC-24 | database write fails during setup save | PASS | wizard no longer advances/completes; setup test |
| RC-25 | hidden page later visible | FAIL | no general resume catch-up trigger |
| RC-26 | Mac sleeps/wakes | BLOCKED | physical lifecycle unavailable; source has no general wake resync |
| RC-27 | network disappears during send | BLOCKED | unsafe to induce against real provider; controlled uncertain-send contract only |
| RC-28 | admin reset interrupted halfway | FAIL | media cleanup improved, but the complete multi-table reset is not one DB transaction |
| RC-29 | WhatsApp attachment staged file missing on retry | FAIL | recovery remains incomplete for every media state |
| RC-30 | update chosen, readiness later fails | FAIL | update intent/readiness paths were audited but not changed |
| RC-31 | operator page read fails | PASS | failure is no longer rendered as an empty list in changed pages |
| RC-32 | cached Inbox forced revalidation fails | PASS | behavioural three-call contract proves one forced post-inflight refresh |

For non-idempotent actions, PASS means the controlled database/adapter contract
prevents an automatic second external call. It does not claim a live provider
send. Live duplicate-side-effect testing was intentionally blocked for safety.

## Accessibility and UI-quality matrix

The baseline matrix contains exactly **16 PASS, 15 FAIL, 7 BLOCKED, and 1 NOT
APPLICABLE**. The current hardening snapshot is **25 PASS, 6 FAIL, 7 BLOCKED,
and 1 NOT APPLICABLE**. Contrast ratios were calculated from the shipped tokens
rather than judged by eye.

| ID | Check | Baseline | Current | Evidence / exact block reason |
| --- | --- | --- | --- | --- |
| AX-01 | primary navigation uses links | PASS | PASS | sidebar/dock source and browser role queries |
| AX-02 | Inbox search has an accessible name | PASS | PASS | `inbox/page.tsx:769` |
| AX-03 | clear-search button has a label | PASS | PASS | `inbox/page.tsx:779` |
| AX-04 | select mode communicates pressed state | PASS | PASS | `inbox/page.tsx:847` |
| AX-05 | Settings switches expose switch/checked | PASS | PASS | settings controls/tests |
| AX-06 | digest/frequency choices expose selected state | PASS | PASS | settings source |
| AX-07 | Reconnect reason control exposes expanded | PASS | PASS | reconnect source/tests |
| AX-08 | People detail row exposes expanded/controls | PASS | PASS | People source |
| AX-09 | phone dock labels are present | PASS | PASS | mobile layout contract |
| AX-10 | loading text uses status where audited | PASS | PASS | People/operator hardening |
| AX-11 | action sheet has a close path | PASS | PASS | action-sheet contracts |
| AX-12 | toast can be dismissed | PASS | PASS | toast tests |
| AX-13 | destructive reset is labelled and separated | PASS | PASS | settings source/contracts |
| AX-14 | body copy remains readable at normal zoom | PASS | PASS | controlled viewport inspection |
| AX-15 | no keyboard trap in standard route navigation | PASS | PASS | controlled keyboard smoke |
| AX-16 | Command-K is a real labelled combobox/listbox | FAIL | PASS | semantic hardening and tests |
| AX-17 | palette retains input focus while arrows move selection | FAIL | PASS | `aria-activedescendant` hardening |
| AX-18 | palette focus returns to invoking control | FAIL | PASS | app-shell focus restoration |
| AX-19 | every modal/dialog has dialog semantics and focus management | FAIL | FAIL | several custom overlays remain generic containers |
| AX-20 | no nested interactive controls | FAIL | PASS | Archived row selection separated from link; other surfaces inspected |
| AX-21 | feedback fields/attachment controls have complete labels | FAIL | PASS | explicit labels/group/file name plus drawer accessibility tests |
| AX-22 | send/dictation errors are announced live | FAIL | PASS | composer and dictation errors use `role="alert"`; behavioural alert assertions |
| AX-23 | `text-ink-4` meets 4.5:1 for normal text | FAIL | PASS | measured baseline 2.21:1 light, 2.95:1 dark; corrected token guarded at 4.5:1+ |
| AX-24 | waiting/fresh/accent status text meets contrast | FAIL | PASS | corrected light/dark semantic tokens guarded at 4.5:1+ |
| AX-25 | hairline boundaries remain perceivable | FAIL | FAIL | low-contrast boundaries disappear in states |
| AX-26 | focus rings meet non-text contrast | FAIL | FAIL | several rings use insufficient-contrast tokens |
| AX-27 | LinkedIn rich-edit text remains legible | PASS | PASS | audited base already uses `bg-paper text-ink` for the edit textarea at `apps/dashboard/app/thread/[id]/page.tsx:4657` |
| AX-28 | Inbox selected rows expose selected semantics | FAIL | PASS | separate selection button uses `aria-pressed`; status controls use tabs/selected state |
| AX-29 | all phone targets meet 44 x 44 | FAIL | FAIL | reproduced sub-44 targets |
| AX-30 | small phone viewport preserves reading region | FAIL | FAIL | 390 x 400 leaves about 45.2 px |
| AX-31 | Electron window bounds keep controls reachable | FAIL | FAIL | issue #998; physical verification blocked |
| AX-32 | VoiceOver route/landmark reading order | BLOCKED | BLOCKED | no physical screen-reader pass |
| AX-33 | TalkBack reading order | BLOCKED | BLOCKED | no Android device/emulator |
| AX-34 | 200%-400% zoom reflow | BLOCKED | BLOCKED | deterministic zoom matrix not completed |
| AX-35 | OS high-contrast/forced-colors | BLOCKED | BLOCKED | host-mode pass unavailable |
| AX-36 | reduced-transparency OS mode | BLOCKED | BLOCKED | host-mode pass unavailable |
| AX-37 | Switch Control/full keyboard access | BLOCKED | BLOCKED | physical assistive-technology pass unavailable |
| AX-38 | real mobile screen reader with keyboard | BLOCKED | BLOCKED | physical phone unavailable |
| AX-39 | canvas/SVG chart alternative | NOT APPLICABLE | NOT APPLICABLE | product intentionally has no data-dashboard chart surface |

## Product-level redundancy audit

Duplication was classified by user job, not by matching source text. A second
entry point was retained when it shortens a real path without giving the same
information equal visual weight.

| User job / surface | Where it appears | Classification | Decision and evidence |
| --- | --- | --- | --- |
| Find/open a conversation | Inbox search, Command-K, phone Search, People "Open in Inbox" | Useful alternate entry point | Retain. Contexts differ; People now uses supported `?q` instead of a dead `?person` contract. |
| Open the next needed reply | Today hero and Inbox | Intentional redundancy | Retain. Today gives prioritised focus; Inbox gives the complete list. |
| Snooze/mark handled | Today, Inbox bulk bar, thread overflow | Intentional redundancy | Retain. Single-item focus, batch triage, and in-context action are distinct. |
| Favourite a person | Inbox row, thread header, profile drawer | Useful alternate entry point | Retain, but keep ordering semantics identical and quiet. |
| Reassess/scan | thread overflow, Platforms, People scan-all, Inbox bulk rescan | Operator-only duplication plus scoped alternate entry points | Retain scoped actions; keep Platforms/People hidden. Avoid promoting scan controls into primary UI. |
| Search access on Reconnect | Command-K on desktop and Search on phone | Useful alternate entry point | Added missing access for parity; no new search implementation. |
| Archived versus handled/snoozed/cold | Archived baseline inferred several non-archive states | Harmful duplication | Removed. Archived now means explicitly archived only. |
| At Risk versus Today/Inbox | `/at-risk` repeated prioritisation and batch actions | Legacy surface worth removing | Route now redirects to Today. Strategy explicitly says not to build an At Risk dashboard. |
| People relationship management | hidden People page overlaps contact context in thread/profile drawer | Legacy/secondary surface worth keeping hidden | Keep notes/profile/enrichment/scan-all because no replacement covers them; do not promote or expand into CRM. |
| People conversation opener buttons | inert suggested openers and real composer | Harmful duplication | Replaced inert buttons with non-interactive "Conversation ideas" guidance. |
| Platforms versus Settings accounts | both show platform state/actions | Operator-only duplication | Keep Settings calm for normal connection visibility; keep selector/reset/browser diagnostics hidden in Platforms. |
| Logs versus status/receipts | hidden audit rows and user-facing status | Operator-only duplication | Retain Logs hidden. Do not expose raw operational volume in primary reply flow. |
| Demo/presenter versus live UI | seeded sandbox and live read-only modes | Intentional redundancy | Retain for pilot demonstration, with server-side external-action guards. |
| Settings feedback and global pilot feedback affordance | two entry points to same safe intake | Useful alternate entry point | Retain. Both must keep private message content opt-in only. |
| Update status in top bar and Settings | transient notice and detailed control | Intentional redundancy | Retain; top status should deep-link to the same Settings state without losing intent. |
| Focus buffer on Today and Inbox | prioritised rail and grouped arrivals | Intentional redundancy | Retain because they answer "what now" and "what arrived" respectively. |
| Full AI draft and writing transformations | thread AI Assist | Potentially harmful if equal-weight | Retain only as explicit opt-in. Shorten/warmer support user writing; full predraft must never become default. |

The two harmful/legacy surfaces changed in this pass were At Risk and the
invented Archived classifications. The People CRM-like route remains hidden
because its notes/profile/enrichment jobs are not fully duplicated elsewhere.

## Performance baseline

### Method

The repeatable large fixture contained 1,000 threads and 20,000 messages in an
isolated production-schema SQLite database. External scanning, Contacts,
enrichment, and sends were disabled. Local API and DB percentiles used 30
samples unless a row says otherwise. Browser figures were measured at visible
DOM acknowledgement, not at click promise resolution. Cold launcher timing
includes build/schema preparation; warm launcher timing is the unchanged path.

The audited interaction harness was initially unusable because it imported a
browser package absent from this repository and accepted empty/non-positive
sample sets. The hardening pass imports the repository's Patchright dependency,
validates samples, and provides `--help`; `tests/performance-interaction-harness.test.mjs`
guards that contract.

### Measured baseline

| Boundary | p50 | p95 | Qualification |
| --- | ---: | ---: | --- |
| runner health API | 6.48 ms | 66.58 ms | loopback, built runner |
| Inbox API, cache hit | 1.59 ms | 4.45 ms | one client, warm compressed response |
| Inbox API, cache miss | 25.00 ms | 55.97 ms | 1,000-thread fixture |
| Inbox search API, uncached | 17.78 ms | 25.35 ms | generated text only |
| thread API | 3.03 ms | 6.00 ms | generated conversation |
| important direct SQLite calls | below 1.1 ms | below 1.1 ms | isolated local DB; already fast |
| dev-browser Inbox useful render | 617 ms | 1,074 ms | mounted source dashboard |
| Inbox to thread usable | 316.7 ms | 920.6 ms | 500-sibling thread before rail windowing |
| Show 80 more rows | not separately retained | 99.5 ms | p95 visible acknowledgement |
| local search apply / clear | not separately retained | 66.7 / 117.8 ms | browser interaction |
| composer input | 92.5 ms | 113.9 ms | browser visible value acknowledgement |
| cold launcher preparation | 28.726 s | 31.713 s | build/schema/update path |
| warm unchanged preparation | 97.6 ms | 143 ms | no rebuild needed |

### Request volume and resource observations

| Scenario | Observation | Result |
| --- | --- | --- |
| Inbox visible for 17 seconds | 14 GET requests | FAIL: avoidable repeated reads remain |
| same page hidden | 0 requests in sampled window | PASS for basic visibility gating |
| resume after hidden | 5 immediate/follow-up requests | FAIL: not a coalesced freshness transaction |
| two dashboard clients | 28 requests in the same sampled window | FAIL: browser ownership multiplies work |
| thread with 500 siblings | 4,083 DOM nodes at mount | FAIL at baseline; hardening windows the sibling rail |
| Inbox response body | about 487 KB uncompressed text | risk: raw cache could retain roughly 25 MB across noisy keys |
| 30 simultaneous cold Inbox reads | all 30 missed; p50 ranged 133-303 ms and p95 216-376 ms | FAIL: cache stampede |
| one uncached Inbox read | p50 25 ms, p95 55.97 ms | comparison proves contention, not intrinsically slow DB work |
| 52 query-noise variants | evicted the hot canonical request | FAIL: raw URL keys and wholesale clear |
| CPU/memory while scanning | not safely representative without live provider sessions | BLOCKED |
| packaged idle CPU/memory | dev process is not a valid proxy | BLOCKED |

### Final implementation measurements

The final API run used the same 1,000-thread / 20,000-message synthetic fixture,
30 direct samples per ordinary endpoint, and explicit `Cache-Control: no-cache`
for miss paths. Host contention differed from the baseline, so the higher final
latencies are not attributed to the cache implementation and are not presented
as a regression or improvement.

| Boundary | Final p50 | Final p95 | Cache/result qualification |
| --- | ---: | ---: | --- |
| runner health API | 43.09 ms | 116.75 ms | 30 loopback samples |
| Inbox API, cached | 14.66 ms | 40.81 ms | 30/30 `hit` |
| Inbox API, explicit no-cache | 97.36 ms | 197.43 ms | 30/30 `miss` |
| Inbox search API, explicit no-cache | 71.46 ms | 169.50 ms | generated text only |
| thread API | 33.60 ms | 108.35 ms | generated conversation |
| fresh ten-way identical Inbox burst | 234.80 ms | 313.20 ms | exactly 1 `miss`, 9 `coalesced` |
| 52 semantic query-noise variants | 222.10 ms | 231.19 ms | 52/52 `hit`; canonical request was a `hit` both before and after |

Three pre-header ten-way cold batches measured 190.52/267.98 ms,
1,119.73/1,132.22 ms under a contention outlier, and 238.15/244.17 ms. Those
earlier responses were all labelled `miss`; after the response status exposed
followers as `coalesced`, a fresh burst proved exactly one producer and nine
followers. This proves work sharing, not a latency win.

### Before/after for implemented performance changes

| Change | Baseline | Final implementation | Interpretation |
| --- | --- | --- | --- |
| Inbox-to-thread usable latency | p50 316.7 ms, p95 920.6 ms | BLOCKED: bounded browser run reached 20 initial-render samples but did not emit a complete result document | no post-hardening percentile claimed |
| mounted thread sibling surface | 500 sibling links and 4,083 DOM nodes | 80 initial sibling links and 1,918 DOM nodes; **Show 80 more** present | deterministic bounded-mount improvement; settled all-sibling count and Show-more percentile remain unmeasured |
| interaction harness execution | blocked by absent import and invalid sample acceptance | starts against production services, validates input, and reached the explicit run bound | infrastructure works; partial samples were not promoted to percentiles |
| cold identical Inbox burst | 30/30 misses; p50 range 133-303 ms, p95 216-376 ms | fresh 10-way burst p50 234.80 ms, p95 313.20 ms; 1 miss and 9 coalesced | single-flight is proved; latency comparison is inconclusive because run conditions differed |
| canonical cache retention | hot request evicted by 52 noise variants | 52/52 noise variants hit and canonical request remained a hit | semantic key plus bounded LRU is proved |
| visible single-client requests / 17 s | 14 | BLOCKED/unmeasured after hardening | scheduling ownership was not changed; no improvement claim |
| two-client requests / sampled window | 28 | BLOCKED/unmeasured after hardening | multi-client duplication remains open |

The direct SQLite path was not optimised because it was already sub-millisecond
to low-single-digit milliseconds. Operational cache coalescing, canonical LRU
retention, and the smaller initial thread surface are proved. Browser latency
percentiles and post-hardening request-volume changes are not.

## Freshness and return-from-inactivity audit

### Metric definition

**Time to trustworthy fresh state (TTTFS)** is complete only when all four
milestones are known:

1. useful cached/local state is visible;
2. Tovi knows which enabled platforms need catch-up;
3. the newest changed conversations are visible;
4. every enabled platform has a recorded successful catch-up for this resume
   epoch, or a truthful platform-specific error is visible.

At baseline, milestone 1 was quick enough to be useful (dev-browser p50 617 ms,
p95 1,074 ms), but milestones 2-4 were **unbounded**. A global "last scan" time
was neither per-platform nor success-only, and browser-controlled scheduling
could be absent, duplicated, delayed by adaptive fallback, or blocked behind a
different platform. Therefore the baseline TTTFS is correctly reported as
**unbounded**, not as the first paint time.

### Exact causal path at baseline

```text
app/window becomes active
  -> dashboard AppShell renders cached local reads
  -> each mounted AppShell independently reads localStorage cadence
  -> its timer may POST /control/scan (subject to UI-only active hours/quiet rules)
  -> runner global queue serializes platform work
  -> platform adapter lists/opens candidate threads
  -> scan queue persists messages and thread projection
  -> optional AI/classification may run serially in the same path
  -> event bus emits (not consistently consumed by Today/Inbox at baseline)
  -> SSE proxy/client refreshes some mounted data
  -> health reports MAX(platform.lastScanAt), even if another platform is stale
```

The runner also owns a 60-second idle fallback with adaptive delay up to 240
seconds and platform watchers. That fallback did not honor the complete browser
Off/10-minute/daily/quiet-hours contract, and the scheduled scan loop plus some
iMessage/WhatsApp watcher paths did not consistently filter by
`enabledPlatforms` (historical regression #202).

### Measured freshness components

| Component | p50 | p95 | Qualification |
| --- | ---: | ---: | --- |
| iMessage real filesystem watcher event | 474.39 ms | 476.73 ms | real local file watcher; no message send |
| coordinator trigger, iMessage | 26 ms | 29 ms | controlled |
| coordinator trigger, LinkedIn | 500.9 ms | 501.4 ms | controlled established-page signal |
| coordinator trigger, WhatsApp | 751.3 ms | 751.7 ms | controlled event/debounce |
| local `humanDelay` called in scan path | 433 ms | 767.6 ms | measured avoidable local delay |
| runner boot to first scheduled enqueue | about 1 s | about 1 s | source/timed observation |
| idle fallback | 60 s | 240 s | adaptive configured range |
| historical iMessage source -> persisted | 327.82 ms | 506.90 ms | prior controlled production-schema work |
| historical WhatsApp source -> persisted | 766.51 ms | 848.52 ms | controlled, no live provider |
| historical LinkedIn source -> persisted | 813.06 ms | 895.07 ms | established-page controlled model |
| persisted -> visible open thread | 33.2 ms | 34.4 ms | controlled browser render harness |

### Inactivity scenarios

| Scenario | Baseline status | What is known |
| --- | --- | --- |
| 10 minutes away | FAIL | browser timer/fallback may catch up, but no resume epoch or all-platform proof |
| 1 hour away | FAIL | same; adaptive scheduling and UI ownership make completion unprovable |
| 24 hours away | FAIL | no explicit resume catch-up; list caps can miss bursts |
| several days away | FAIL | deep catch-up has no bounded freshness contract |
| runner alive, dashboard closed | FAIL | watchers/fallback exist, but browser preference contract and per-platform success proof do not |
| runner stopped | BLOCKED | full stop/restart mounted lifecycle not exercised; boot enqueue is measured |
| Mac slept/woke | BLOCKED | no physical sleep test and no general wake handler |
| network unavailable then returned | BLOCKED | no deterministic network fault injection; no explicit online catch-up |
| session remained authenticated | PASS | controlled watcher/coordinator path is fast once a valid session/page exists |
| session expired while away | BLOCKED | no live safe session; health/error contracts only |
| several messages arrived | FAIL | newest-15 non-iMessage cap can omit a burst |
| many messages arrived | FAIL | same omission can become permanent without deep reconciliation |
| multiple platforms changed | FAIL | single global queue makes an early slow platform head-of-line block local work |
| multiple dashboard clients | FAIL | measured duplicated request/scheduler work |

### Root causes

| ID | Root cause | Evidence and consequence |
| --- | --- | --- |
| FR-01 | browser-owned scheduling | `app-shell.tsx:614`; no dashboard means UI cadence is absent, multiple dashboards multiply triggers |
| FR-02 | runner fallback has different policy | `scan-queue.ts:1236`; 60-240 s adaptive timing does not equal Off/10-minute/daily/quiet settings |
| FR-03 | incomplete enabled-platform gating | base watcher/scheduler paths around `index.ts:1124` and scan queue; disabled work can still arm |
| FR-04 | optional AI is in the propagation critical path | scan queue enrichment after persistence can delay thread metadata/events by minutes |
| FR-05 | event consumers omit persisted-message signal | baseline `dashboard/lib/inbox-events.ts:1`; Today/Inbox can remain stale until polling |
| FR-06 | shallow newest-message caps | non-iMessage newest 15, LinkedIn tail 50, iMessage 500; bursts can be stranded |
| FR-07 | global queue head-of-line blocking | LinkedIn/browser work can precede fast local iMessage |
| FR-08 | aggregate attempt time is called freshness | `index.ts:2087`; MAX masks a stale or failed platform |
| FR-09 | cache has no age/verification state | useful local state looks authoritative before catch-up |
| FR-10 | no resume/wake/online catch-up transaction | visibility and connectivity changes do not establish an epoch |
| FR-11 | one scheduler per AppShell | two clients measured roughly twice the request volume |
| FR-12 | high SSE cursor after restart | old client cursor can be ahead of new runner; hardened in this pass |
| FR-13 | watcher rearm/restart gaps | provider watcher can die and wait for fallback |
| FR-15 | forced stale-while-revalidate follow-up can be swallowed | forced refresh is not always durable/coalesced |
| FR-16 | local adapter pays human-like delay | account-safety pacing is useful for browser platforms, not local DB reads |
| FR-17 | authenticated watcher may arm only after a particular connection path | a ready existing session can lack immediate watcher coverage |

### Architecture options

| Option | Expected latency benefit | Complexity | Account/platform risk | Correctness risk | Resource cost | Maintenance cost | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| runner-owned scheduling | high; works while dashboard is closed and deduplicates clients | medium | low if existing guards remain | medium during preference migration | lower duplicated work | medium | **Adopt as foundation**, with one source of truth |
| explicit visibility/app-resume trigger | high for return path; removes up-to-240 s wait | low-medium | low if due-gated, not force-scanning | low-medium | small probe per resume | low | **Adopt**, coalesced and due-gated |
| per-platform last-success metadata | foundational; makes trust measurable | medium | none | low if success-only | negligible | low | **Adopt** before claiming bounded TTTFS |
| fast freshness probe | medium-high when most platforms are unchanged | medium/high per provider | browser probes can still be detectable | medium | lower than full scan if truly cheap | medium-high | Prototype per platform, not universal rewrite |
| prioritise newest/unread/changed threads | high for first useful changes | medium | low if existing caps/guards retained | medium, may starve deep history | lower early work | medium | Adopt with a guaranteed deep-reconciliation tail |
| persisted cursors/watermarks | high on local and stable APIs | medium | low | medium around deletion/reset | low | medium | Extend where platform identity is reliable |
| rearm dead watchers on resume | high when watcher was the only fast path | low-medium | low | low | small | low | Adopt with health/heartbeat state |
| targeted catch-up before broad scan | high for event-named threads | medium | low | medium if signal lacks complete identity | lower | medium | Adopt where existing watcher carries a stable target |
| coalesce duplicate catch-up signals | high under multi-tab/wake bursts | low | none | low | lower | low | Existing foundation: change triggers already use `coalesceWithPending` |
| single-flight scans | high under duplicate triggers | low-medium | improves safety | low with the existing queued follow-up bit | lower | low | Preserve the existing queue, follow-up, and retry-cooldown semantics |
| avoid duplicate scans from tabs/devices | high request/resource benefit | low once runner owns schedule | none | low | lower | low | Adopt through runner ownership |
| keep browser sessions warm | high for LinkedIn/selector platforms | already partly present | medium account/session risk | medium stale identity risk | continuous memory | medium-high | Keep existing safe session reuse only; do not broaden |
| prewarm expensive resources | low-medium | medium | low | low | higher idle CPU/memory | medium | Defer until measurement identifies a cold resource |
| parallel independent platforms | reduces head-of-line blocking | medium-high | medium for browser sessions | high around shared locks/DB order | higher peak CPU/memory | high | Prototype bounded local-vs-browser lanes, do not broadly parallelize |
| progressive freshness | high perceived freshness; messages before AI/deep history | medium | low | medium ordering/version risk | similar total, earlier useful work | medium | Adopt: persist/event first, optional AI later |
| truthful stale-while-revalidate UI | trust benefit rather than raw scan speed | medium | none | low with per-platform state | negligible | low | Adopt after last-success metadata exists |
| restart-aware SSE resync | high for long-lived client after runner restart | low | none | low | negligible | low | Adopted in this hardening pass |

### Freshness before/after

| TTTFS milestone | Baseline | After hardening | Evidence |
| --- | --- | --- | --- |
| useful cached state visible | p50 617 ms, p95 1,074 ms in dev browser | BLOCKED/unmeasured in the bounded post-hardening browser run | final cached API p50 14.66 ms, p95 40.81 ms is not a browser useful-state percentile |
| platforms needing catch-up known | unbounded / no explicit epoch | **unbounded** / no explicit resume epoch | per-platform success-only state was not implemented |
| newest changed conversations visible | unbounded after inactivity; event path can be about 33 ms after persistence | provider catch-up remains unbounded; once a message is persisted, its minimal thread projection and `MESSAGES_PERSISTED` event precede optional AI | behavioural fake-Prisma test blocks AI and observes the awaited projection/event first; prior controlled persisted-to-visible p50 33.2 ms, p95 34.4 ms |
| all enabled platforms confidently caught up | unbounded | **unbounded** | no per-platform resume-epoch last-success proof or truthful complete error set |
| overall TTTFS | **unbounded** | **unbounded** | progressive projection improves the post-persistence segment, not the end-to-end catch-up bound |

No architecture change may weaken cooldown, rate guards, human pacing on
browser-automated platforms, identity checks, authentication safety, or stable
deduplication. Faster local iMessage work can avoid browser-style delay; faster
LinkedIn/Instagram work must come from less duplicate/irrelevant work, not more
aggressive scraping.

## Deduplicated defect register

Every confirmed finding is represented below. Findings from multiple auditors
that share a root cause use one row and cross-reference the affected matrices.
`R` means reproduced in controlled execution or a deterministic test. `I` means
inferred from an unavoidable source path and not physically triggered. "None
found" means open/closed issues, open PRs, recent merges, and existing audit docs
were searched; it does not mean an issue should automatically be created.

Each row includes the required template fields: severity, affected flow,
reproduction, expected/actual result, file/line evidence, issue/PR, evidence
basis, regression test, and disposition.

### Product, desktop, phone, and thread workspace

| ID | Sev | Flow and exact reproduction | Expected -> actual | Evidence | Issue / PR | Basis | Regression test | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-001 | P2 | People: open a person, press **Open in Inbox** | Inbox filtered to that person -> baseline emitted unsupported `?person`, while Inbox reads `?q` | base `people/page.tsx:368`; `inbox/page.tsx:295` | none found | I | `dashboard-people-navigation.test.mjs` | FIXED |
| F-002 | P2 | People: press a suggested conversation opener | Editable composer/path opens -> button had no action | base `people/page.tsx:527` | none found | R/source | `dashboard-people-navigation.test.mjs` | FIXED by making guidance non-interactive |
| F-003 | P1 | Platforms: press a card labelled **Connect** | genuine connect/auth flow -> action can only reveal/open a browser and is misleading for some adapters | `platforms/page.tsx:1`; shared platform action contracts | [PR #1045](https://github.com/richardafolayan/Relationship-Inbox-OS/pull/1045) | I | platform primary-action test after owner fixes | NOT CHANGED, Instagram/shared boundary |
| F-004 | P2 | Archived: compare rows with DB `archivedAt` | only explicit archives -> baseline inferred handled, snoozed, cold, and ghosted states as archive categories | base `archived/page.tsx:105` | none found | I | `dashboard-archived-contract.test.mjs` | FIXED |
| F-005 | P1 | At Risk: select rows and run its main batch action | action matches labels and canonical targets -> legacy page could target the wrong semantic action | base `at-risk/page.tsx:1` | none found | I | `dashboard-at-risk-focus.test.mjs` | FIXED by redirect |
| F-006 | P2 | Navigate directly to `/at-risk`, then compare Today/Inbox | one calm prioritisation surface -> legacy route duplicated prioritisation and batch triage contrary to strategy | base `at-risk/page.tsx:1`; `docs/strategy/current-product-direction.md:19` | none found | R/source | `dashboard-at-risk-focus.test.mjs` | FIXED by redirect to Today |
| F-007 | P2 | Open Reconnect on desktop/phone and try to search elsewhere | Search remains reachable -> both Search entry points were absent | base `reconnect/page.tsx:176` | none found | R/source | `dashboard-reconnect-mobile.test.mjs`; mobile Search test | FIXED |
| F-008 | P1 | Force People/Logs/Demo/Archived read request to fail | explicit failure and retry -> parts of baseline rendered empty/caught-up/sample absence | base route pages; changed `logs/page.tsx:1`, `demo/page.tsx:1` | none found | R/contracts | `dashboard-operator-route-failures.test.mjs` | FIXED for changed routes; Platforms residual in F-003 |
| F-009 | P3 | Compare feature docs with current route/platform state | docs match checked code -> platform/legacy descriptions were stale in places | `docs/developer/features.md:90` | none found | I | `docs-check.test.mjs` plus manual route inventory | OPEN documentation follow-up |
| F-010 | P3 | Read Settings application description | calm truthful product copy -> baseline implied a demo-oriented mode | base `settings/page.tsx:138` | none found | I | settings copy test | FIXED |
| F-011 | P1 | Type an unsaved reply, open a sibling thread, return | text preserved per thread -> page-local composer was cleared/lost | base `thread/[id]/page.tsx:709` | none found | R/BR | `dashboard-thread-composer-session.test.mjs`; smoke | FIXED |
| F-012 | P2 | Filter/scroll Inbox, open thread, return | list query, filter, scroll, and focus restored -> page remount loses part/all local state | `inbox/page.tsx:261` | none found | R/BR | future round-trip state E2E | OPEN |
| F-013 | P1 | Open Command-K, arrow through results, inspect role/focus, close | labelled combobox/listbox, input focus, opener restoration -> generic controls/selection and lost opener focus | `apps/dashboard/components/layout/command-palette.tsx:171,194,202,203`; `apps/dashboard/components/layout/app-shell.tsx:193,207` | [issue #1008](https://github.com/richardafolayan/Relationship-Inbox-OS/issues/1008) | R/source | command palette navigation/active-index tests; Playwright smoke at `tests/e2e/product-smoke.spec.ts:73-93` | FIXED |
| F-014 | P2 | Launch packaged app on constrained display/after bounds restore | complete reachable window -> bounds can place controls outside useful viewport | `apps/desktop/main.cjs:661,946` | [issue #998](https://github.com/richardafolayan/Relationship-Inbox-OS/issues/998) | I | future packaged bounds E2E | OPEN / PHYSICAL BLOCK |
| F-015 | P2 | Measure all phone action targets at 390 x 844 | at least 44 x 44 CSS px -> several controls are smaller | `apps/dashboard/app/settings/page.tsx:536`; `apps/dashboard/app/thread/[id]/page.tsx:4657` | none found | R | future geometry assertions in smoke | PARTIALLY FIXED: key Inbox targets/tabs now 44 px |
| F-016 | P1 | Emulate 390 x 400 after keyboard shrink in thread | useful timeline and visible composer -> only about 45.2 px timeline remains | `thread/[id]/page.tsx:5701`; mobile composer/layout tests | none found | R | extend phone smoke with 390 x 400 | OPEN |
| F-017 | P1 | Enter thread from Inbox/Search, press header Back | return to actual source -> baseline fallback hard-coded Today | base `thread-source.ts:1`; thread header | none found | R | thread-source and smoke tests | FIXED |
| F-018 | P2 | Open Inbox at 390 px with all tool controls | tools scroll/fit without clipping -> horizontal carousel clips affordances | `inbox/page.tsx:790` | none found | R | phone geometry smoke | OPEN |
| F-019 | P0 | Delay thread A response, navigate to B, resolve A | only B may render -> A could overwrite B state and send context | base `thread/[id]/page.tsx:1415` | none found | R/deterministic | `dashboard-thread-route-safety.test.mjs`; identity-guard test | FIXED |
| F-020 | P0 | Start dictation on A, navigate to B before transcription resolves | result remains with A/discarded -> transcript could enter B composer | base `thread/[id]/page.tsx:2233` | none found | I/deterministic | dictation message send controls + thread route safety | FIXED |
| F-021 | P0 | Rapidly press Send in reviewed-dictation UI | exactly one client request/external attempt -> duplicate handlers could enqueue twice | base `dictation-message-review.tsx:1`; thread send path | [issue #958](https://github.com/richardafolayan/Relationship-Inbox-OS/issues/958) | R/contracts | `dashboard-dictation-message-send-controls.test.mjs`; send-integrity | FIXED |
| F-022 | P0 | Make adapter report delivery, then fail final local DB write | UI/API must not return durable success -> baseline could acknowledge before `SENT` persisted | base `services/send.ts:300` | [issue #972](https://github.com/richardafolayan/Relationship-Inbox-OS/issues/972) | I/deterministic | `runner-send-integrity.test.mjs` | FIXED |
| F-023 | P0 | Retry same failed send concurrently / replay same client ID | one durable identity and at most one external attempt -> retry could mint/reuse identity inconsistently | base `services/send.ts:178`; `index.ts:4175` | none found | I/deterministic | `runner-send-integrity.test.mjs`; send claim tests | FIXED |
| F-024 | P1 | Save multiple drafts for one thread/concurrent upserts | one active draft by schema contract -> multiple rows were allowed/read ambiguously | base `schema.prisma:178`; `index.ts:8000` | none found | I/DB | draft uniqueness/migration and delete-draft tests | FIXED with uniqueness guard/schema |
| F-025 | P1 | Schedule a reply containing attachment and parent reply ID | due send preserves both -> baseline schedule/update payload retained text/time only | base `thread/[id]/page.tsx:2480`; `send.ts:140` | none found | I | scheduled-send payload regression | FIXED |
| F-026 | P1 | Send optimistically, force refresh/reload before reconciliation | no disappearing/duplicated bubble -> optimistic row could vanish or duplicate across reload | base `thread/[id]/page.tsx:1722` | none found | I | send-reconcile/delivery-recovery tests | PARTIALLY FIXED; live provider remains blocked |
| F-028 | P1 | Fail a WhatsApp media send, restart, press retry | staged media still exists and identity remains safe -> recovery can lose the file | `whatsapp-adapter.ts:430`; send staged paths | related historical issue family; no exact repository reference found | I | future restart-with-media DB/E2E | OPEN residual |
| F-029 | P1 | Stage attachment, wait through cleanup/expiry, then retry | referenced in-flight media retained -> cleanup may expire required file | `apps/runner/src/index.ts:3901`; `apps/runner/src/services/send.ts:1063` | [PR #1047](https://github.com/richardafolayan/Relationship-Inbox-OS/pull/1047) | I | artifact-retention retry test | OPEN; unsafe PR cleanup not copied |
| F-030 | P1 | Receive WhatsApp burst beyond in-memory cap, crash before flush | no committed message lost -> cap/flush boundary is not crash-durable | `whatsapp-adapter.ts:170` | none found | I | restart/crash journal integration test | OPEN |
| F-031 | P1 | Reply in a canonical iMessage conversation whose parent is on sibling handle | parent resolves across safe sibling set -> strict same-thread validation can reject a legitimate parent | `index.ts:3846`; sibling canonicalisation | [PR #1047](https://github.com/richardafolayan/Relationship-Inbox-OS/pull/1047) | I | sibling reply-parent DB test | NOT CHANGED; avoid unsafe strict-parent patch |
| F-032 | P1 | Trigger Reassess/transcription/open-loop update twice and reorder completions | latest request/version wins -> independent async completions can overwrite newer derived state | `apps/dashboard/app/thread/[id]/page.tsx:3126,3133` | none found | I | add request-generation/CAS tests per service | OPEN |
| F-033 | P2 | Schedule for a time that becomes past/ambiguous across timezone/day | UI clearly resolves overdue/next occurrence -> baseline can show or send at wrong interpreted time | base `thread/[id]/page.tsx:342`; remember-tz tests | none found | I | overdue scheduling timezone test | OPEN |
| F-034 | P2 | Inspect send receipt for platform verification level | receipt names actual platform/outcome -> generic receipt can overstate trust | `apps/dashboard/lib/send-delivery.ts:19`; `apps/dashboard/components/common/receipts-drawer.tsx:73` | none found | I | per-platform receipt presentation test | OPEN |
| F-035 | P2 | Open action sheet/menu while send/reassess is busy; press competing action | one modal action and inline busy/success state -> overlapping controls can remain active/inconsistent | `apps/dashboard/app/thread/[id]/page.tsx:4260,4274` | none found | R/source | action-sheet busy-state browser test | OPEN |
| F-036 | P2 | Favourite in thread while Inbox/Today reorders concurrently | successful toggle reconciles once without jump-back -> optimistic override can race server reorder/failure | `thread/[id]/page.tsx:3920`; `inbox/page.tsx:437` | none found | I | multi-view favourite reconciliation test | OPEN |

### Onboarding, settings, operator recovery, and data integrity

| ID | Sev | Flow and exact reproduction | Expected -> actual | Evidence | Issue / PR | Basis | Regression test | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-037 | P0 | Enable phone access on a non-loopback HTTP origin and transmit bearer token | credentials only cross a secure origin (or loopback) -> baseline allowed bearer transport over plain LAN HTTP | `apps/desktop/phone-access.cjs:331`; phone access route | [issue #957](https://github.com/richardafolayan/Relationship-Inbox-OS/issues/957) | I/security + controlled HTTP | 14 phone-access secure-origin tests; plain HTTP 426/no cookie | FIXED; physical HTTPS usability remains a separate blocked check |
| F-038 | P1 | In Setup, make profile/preferences/completion POST fail, then press continue/finish | remain on step with error -> baseline could advance or mark complete | base `SetupWizard.tsx:132-170` | none found | R/contracts | `dashboard-setup-wizard.test.mjs` | FIXED |
| F-039 | P1 | Leave a stale local welcome/setup marker but remove durable server completion | wizard uses durable status -> stale marker could bypass setup | `apps/dashboard/components/onboarding/setup-wizard.tsx:75,81` | none found | I | setup stale-marker test | FIXED |
| F-040 | P1 | Toggle setup source choices rapidly with reordered POST completion | final user selection wins -> concurrent preference writes could land out of order | base `SetupWizard.tsx:146` | none found | I | setup preference serialization test | FIXED |
| F-041 | P1 | Make focus settings GET fail while persisted settings are non-default | show load error, do not write -> baseline default state could overwrite persisted value | base `FocusSettingsSection.tsx:45` | none found | I | focus settings load-failure test | FIXED |
| F-042 | P1 | Make calendar focus GET fail, then let debounce run | no default write after failed load -> baseline could overwrite server state | base `CalendarFocusSection.tsx:70` | none found | I | calendar save-order/load-failure test | FIXED |
| F-043 | P2 | Load Settings with runner unavailable | labels must say unavailable/loading -> baseline false defaults looked like saved settings | base `settings/page.tsx:246` | none found | R/source | Settings failure-state test | PARTIALLY FIXED |
| F-044 | P1 | Change quiet hours twice quickly / fail first save | final value and error remain truthful -> debounced writes could reorder or silently fail | Settings quiet-hours controls around `settings/page.tsx:1720` | none found | I | quiet-hours serialized-save test | OPEN |
| F-045 | P1 | Edit voice profile while earlier request is in flight/fails | preserve latest edits and surface failure -> earlier completion/default could replace them | `apps/dashboard/components/settings/UserVoiceProfile.tsx:123,155` | none found | I | voice profile save-order test | OPEN |
| F-046 | P1 | Edit People notes, make save fail or change selection mid-flight | local text remains recoverable/error shown -> edits can disappear | `people/page.tsx:600` | none found | I | notes failure/latest-request test | OPEN |
| F-047 | P1 | Disconnect WhatsApp client then choose reconnect from Settings | reconnect enters a real QR/session recovery flow -> deep link/state could strand user | `apps/dashboard/components/settings/WhatsAppConnect.tsx:76,174` | related historical issue family; no exact repository reference found | I/contracts | WhatsApp reconnect deep-link test | PARTIALLY FIXED; live auth blocked |
| F-048 | P1 | Run admin reset with DB/media and induce failure between phases | atomic or resumable reset; no stale private media -> baseline table reset was non-transactional and left media | base `services/admin-reset.ts:1`; `index.ts:1897` | none found | I/DB | admin-reset media/delete-count tests | MEDIA FIXED; cross-table atomicity OPEN |
| F-049 | P1 | Choose update, fail readiness/start transition, recover | original install intent survives -> baseline discarded intent and required repetition | `apps/desktop/updater.cjs:36` | none found | I/contracts | future update intent recovery test | OPEN |
| F-050 | P1 | Point readiness check at another HTTP app returning superficial success | verify Tovi-specific identity/version -> baseline accepted the wrong app | `scripts/start-app.mjs:371`; `apps/desktop/main.cjs:245` | none found | I | future start-app readiness identity test | OPEN |
| F-051 | P1 | Reconnect SSE with a cursor greater than a restarted runner's head | reset/snapshot without long replay -> baseline accepted impossible cursor/replay behaviour | base `index.ts:2150`; `services/sse-resume-cursor.ts:1` | none found | I/contracts | `runner-sse-resume-cursor.test.mjs` | FIXED |
| F-052 | P2 | Trigger an unhandled dashboard request rejection | local inline/toast recovery without page reload loop -> global handler could reload/disrupt work | `dashboard/lib/api.ts:416`; shell error handling | none found | I | global unhandled-error browser test | OPEN |
| F-053 | P1 | Open two AppShell clients with auto scan enabled | one runner-owned schedule -> each shell creates its own timer/POSTs | `apps/dashboard/components/layout/app-shell.tsx:631`; measured two-client request volume | [issue #202](https://github.com/richardafolayan/Relationship-Inbox-OS/issues/202) | R/MEASURED | multi-client mounted-runner test | OPEN architecture root |
| F-054 | P1 | Send a WhatsApp poll, acknowledge API, restart, and replay | committed request, receipt, and client identity survive -> baseline poll path bypassed durable send machinery | `apps/runner/src/index.ts:3995-4036`; durable send service | none found | AUT/DB | WhatsApp poll durable-send/restart replay tests | FIXED; live vote/tallies remain blocked separately |
| F-056 | P1 | Race two creates with same client ID so loser receives Prisma P2002 | loser re-reads winner -> baseline could return a false replay/error from stale pre-read | base `send.ts:178-260` | none found | I/DB | `runner-send-integrity.test.mjs` | FIXED |
| F-057 | P0 | Deliver focus auto-ack events concurrently for same person/window | one saved note maximum -> baseline in-memory/profile check was non-atomic across requests/processes | base `focus-auto-ack.ts:108` | none found | I | `runner-focus-auto-ack.test.mjs` | FIXED with durable dedupe/lock |
| F-058 | P0 | Make focus-note enqueue/send fail after candidate selection | do not mark person acknowledged until durable outcome -> baseline acked before outcome and could suppress retry | base `focus-auto-ack.ts:150` | none found | I | focus-auto-ack failure tests | FIXED |
| F-059 | P1 | Run artifact cleanup with `--root`/configured directory outside default | clean exactly configured safe root -> baseline resolved a different root/ignored env in paths | base `scripts/cleanup-artifacts.ts:1` | [PR #1047](https://github.com/richardafolayan/Relationship-Inbox-OS/pull/1047) | R/contracts | `runner-cleanup-artifacts.test.mjs` | FIXED with validated explicit root |
| F-060 | P1 | Apply schema update to pilot DB and interrupt/fail it | backup/forward recovery exists -> repository intentionally has no committed migration history and update path lacked backup | `scripts/start-app.mjs:214`; `scripts/lib/backup-sqlite.mjs:1` | none found | I + controlled DB | `start-app-database-backup.test.mjs`, including fail-closed path | FIXED |
| F-064 | P2 | Read/modify schema with multiple draft rows from older pilot data | migration resolves deterministically -> uniqueness constraint alone can fail on dirty existing data | `scripts/lib/repair-schema-data.mjs:19,25`; `packages/core/prisma/schema.prisma:530` | none found | DB | seeded duplicate-draft migration test | FIXED: newest `updatedAt`, stable `id` tie-break, transactional repair before schema push |
| F-065 | P2 | Run reset while scan/send locks are active | all writers quiesce and reset result is consistent -> cooperative abort cannot make multi-phase cleanup transactional | `index.ts:1924`; admin reset service | none found | I | mounted concurrency reset test | OPEN |

### Accessibility and visual-quality defects not already represented above

| ID | Sev | Flow and exact reproduction | Expected -> actual | Evidence | Issue / PR | Basis | Regression test | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-066 | P1 | Open custom modal/drawer, Tab from opener, press Escape | labelled dialog, trapped/managed focus, restoration -> several overlays are generic containers with partial focus handling | `receipts-drawer.tsx:25`; `profile-drawer.tsx:26`; `use-dialog-focus.ts:1` | none found | I/contracts | `dashboard-drawer-dialog-semantics.test.mjs` | PARTIALLY FIXED: Receipts/Profile fixed; audit remaining overlays |
| F-067 | P1 | Inspect Archived selection control inside conversation navigation | sibling controls with separate activation -> baseline nested button/link created invalid interaction | base `archived/page.tsx:300` | none found | R/source | `dashboard-archived-contract.test.mjs` | FIXED |
| F-068 | P1 | Navigate feedback form using label queries/screen reader | every field/icon/file control has name/instructions -> compact controls had incomplete labels | `pilot-feedback-modal.tsx:404-552` | none found | I/contracts | feedback label/drawer accessibility contracts | FIXED |
| F-069 | P1 | Cause send or dictation error while screen-reader cursor remains in composer | error announced promptly -> visual text lacked consistent live-region semantics | `apps/dashboard/app/thread/[id]/page.tsx:5752`; `apps/dashboard/components/thread/dictation-message-review.tsx:442` | none found | AUT/source | composer and dictation `role="alert"` assertions | FIXED |
| F-070 | P1 | Calculate `text-ink-4` normal-text contrast in both themes | at least 4.5:1 -> baseline 2.21:1 light and 2.95:1 dark | `app/globals.css:10,49` | none found | MEASURED | `dashboard-color-contrast.test.mjs` | FIXED at 4.5:1+ |
| F-071 | P1 | Calculate waiting/fresh/accent text/background combinations | WCAG AA -> baseline failed in at least one theme | `app/globals.css:23-25,54-56` | none found | MEASURED | `dashboard-color-contrast.test.mjs` | FIXED at 4.5:1+ |
| F-072 | P2 | Inspect hairline boundaries in light/dark selected/disabled states | distinguish adjacent controls at 3:1 where required -> several boundaries disappear | `apps/dashboard/app/globals.css:14,50` and UI primitives | none found | MEASURED/source | visual/contrast regression | OPEN |
| F-073 | P1 | Keyboard-focus compact buttons/rows in both themes | focus indicator at least 3:1 and not color-only -> some rings use low-contrast token | `apps/dashboard/components/layout/top-status.tsx:641`; `apps/dashboard/app/settings/page.tsx:1559` | none found | MEASURED/source | focus-ring contrast test | OPEN |
| F-075 | P1 | Select Inbox rows and query accessible state | selection exposed through pressed/selected semantics -> baseline state was partly visual | `inbox/page.tsx:791,1364-1482` | none found | I/contracts | Inbox accessibility/contract tests | FIXED with tab semantics, separate `aria-pressed` select controls, and non-nested links |

### Performance and freshness defects

| ID | Sev | Flow and exact reproduction | Expected -> actual | Evidence | Issue / PR | Basis | Regression test | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-076 | P2 | Issue simultaneous cold identical Inbox GETs | one preparation shared, followers reuse -> baseline 30/30 missed | `apps/runner/src/services/inbox-response-cache.ts:68`; `apps/runner/src/index.ts:5354`; `docs/performance/issue-801-interaction-latency.md:1` | internal historical performance note; no GitHub URL stored | R/MEASURED | `runner-inbox-response-cache.test.mjs` plus mounted 10-way HTTP burst | FIXED: final fresh burst returned 1 miss and 9 coalesced; latency improvement is inconclusive |
| F-077 | P2 | Request base Inbox URL, then 52 semantically irrelevant query variants | canonical hot entry retained in bounded LRU -> baseline raw URL keys evicted it and wholesale invalidation multiplied work | `apps/runner/src/services/inbox-response-cache.ts:10,45`; `docs/performance/issue-801-interaction-latency.md:1` | internal historical performance note; no GitHub URL stored | R/MEASURED | `runner-inbox-response-cache.test.mjs` plus mounted query-noise run | FIXED: 52/52 noise variants hit and canonical request remained a hit |
| F-078 | P2 | Open a thread whose person has 500 sibling threads | bounded rail/DOM -> all siblings mounted, total 4,083 DOM nodes; Inbox-to-thread p95 920.6 ms | base thread sibling rail around `thread/[id]/page.tsx:4000` | none found | R/MEASURED | `dashboard-thread-sibling-window.test.mjs` | FIXED; after measurement required |
| F-079 | P2 | Run `npm run perf:interactions` on audited base | repeatable measurements start -> missing browser import/invalid sample acceptance blocked harness | base `scripts/performance/measure-interaction-latency.mjs:1` | none found | R | `performance-interaction-harness.test.mjs` | FIXED |
| F-080 | P2 | Leave Inbox visible 17 s and repeat with two clients | bounded/coalesced reads -> 14 GETs single client, 28 two clients | `apps/dashboard/components/layout/app-shell.tsx:458`; `apps/dashboard/app/inbox/page.tsx:367` | none found | R/MEASURED | multi-client request-budget smoke | OPEN architecture root F-053 |
| F-081 | P1 | Close dashboard while runner remains alive with user cadence Off/10m/daily | one runner scheduler honors durable user policy -> browser and fallback schedulers diverge | base `app-shell.tsx:614`; `scan-queue.ts:1236` | historical regression #202 | I/MEASURED | settings-to-runner scheduler integration test | OPEN foundational |
| F-082 | P1 | Disable iMessage/WhatsApp in settings, then modify source/watch event | no scan for disabled platform -> watcher/scheduled paths could still enqueue | `packages/core/src/defaults.ts:17`; `apps/runner/src/platforms/linkedin-adapter.ts:8901` | [issue #202](https://github.com/richardafolayan/Relationship-Inbox-OS/issues/202) | I | disabled-platform watcher/scheduler tests | PARTIALLY FIXED in runner selection; rearm paths need verification |
| F-083 | P1 | Persist new message while optional AI provider is slow/hung | message/event visible first -> baseline serial AI could delay projection/event by configured minutes (about 4.6 min/thread worst case) | `apps/runner/src/services/scan-queue.ts:160,3768,3811`; `docs/performance/event-driven-message-sync.md:3` | internal historical performance note; no GitHub URL stored | AUT/timed config | `runner-message-freshness-contract.test.mjs` | FIXED: awaited minimal projection and persistence event precede optional AI |
| F-084 | P1 | Emit `MESSAGES_PERSISTED` for a Today/Inbox row | both pages refresh promptly -> baseline consumer set ignored event | `apps/dashboard/lib/inbox-events.ts:1`; `docs/performance/event-driven-message-sync.md:3` | internal historical performance note; no GitHub URL stored | AUT/contracts | `dashboard-inbox-events.test.mjs` | FIXED |
| F-085 | P1 | Add more than 15 new non-iMessage messages while away | all are eventually reconciled -> newest-15 cap can permanently omit burst; LinkedIn tail 50 can strand older changes | `packages/core/src/defaults.ts:17`; `apps/runner/src/platforms/linkedin-adapter.ts:8901` | none found | I | burst/deep-reconciliation fixture | OPEN |
| F-086 | P1 | Queue slow LinkedIn then local iMessage change | independent local work becomes visible promptly -> global serial queue head-of-line blocks it | scan queue `processNext` around `scan-queue.ts:1053` | none found | I/MEASURED model | bounded lane scheduling test | OPEN; prototype only |
| F-087 | P1 | Let platform A succeed recently and B fail/stale, read health | B is explicitly stale -> MAX `lastScanAt` makes aggregate look fresh | `index.ts:2087-2137` | none found | I | per-platform last-success health test | OPEN |
| F-088 | P1 | Reopen after inactivity and inspect cached list | cached state displays age/verification -> no per-platform age or catch-up epoch, so cached state looks authoritative | `apps/dashboard/app/today/page.tsx:694` | none found | R/source | stale-while-revalidate UI test | OPEN |
| F-089 | P1 | Hide then show page, dispatch online, or wake host | one due-gated catch-up starts -> no general resume/wake/online trigger | `apps/dashboard/components/layout/app-shell.tsx:458,631` | none found | I | visibility/online coalescing mounted test | OPEN |
| F-092 | P1 | Kill/reject platform watcher attachment then resume | watcher health re-arms immediately -> dead watcher can wait for fallback | watcher setup in `apps/runner/src/index.ts:1100-1200` | related historical issue family; no exact repository reference found | I | watcher restart/resume test | OPEN |
| F-094 | P2 | Force stale-while-revalidate request while normal refresh is in flight | one durable follow-up executes -> baseline forced revalidation could be swallowed | `dashboard/lib/api.ts:297-401` | none found | I/contracts | `dashboard-api-recovery-contract.test.mjs` | FIXED: forced reads queue one post-inflight request |
| F-095 | P2 | Run local iMessage scan timing with platform-safe delay hook | no human delay for local DB -> baseline measured p50 433 ms, p95 767.6 ms | `scan-queue.ts:2614` | none found | R/MEASURED | message freshness/scan queue contracts | FIXED: pacing remains only for LinkedIn |
| F-096 | P2 | Start runner with already-authenticated platform session without connect event | watcher armed from ready state -> some watchers depend on connection transition | adapter/watch setup in `index.ts:1100-1210` | none found | I | authenticated-boot watcher test | OPEN |

### Automated test quality defects

Baseline inventory: 407 test files and 2,754 runtime tests, including 146
dashboard-oriented files and 225 runner-oriented files; 27 fixture modules; 13
Patchright-labelled files containing 45 tests; 14 page-module areas; four
dashboard route-handler test areas; and source/contract references spanning 111
runner routes. Quantity was substantial, but the distribution explains the
gap: most runner routes were not exercised through a mounted HTTP process with
real Prisma persistence, and the browser-labelled files did not constitute an
isolated full-app E2E suite.

The exact-final supported-runtime full suite, rerun after the durable smoke
setup contract was added, passed **2,788/2,788 unit and integration tests** with
0 fail/cancel/skip in 42,866 ms. It also passed **45/45 required Patchright
browser fixtures** with 0 fail/cancel/skip in 360,536 ms. Those 45 fixtures are
distinct from the separately completed mounted Playwright smoke suite.

| ID | Sev | Flow and exact reproduction | Expected -> actual | Evidence | Issue / PR | Basis | Regression test / guard | Disposition |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F-097 | P1 | Run baseline browser-labelled tests without required runtime | group fails or reports explicit block -> tests could silently skip and overall command stay green | `scripts/testing/run-tests.mjs:74` | none found | R | new test runner rejects skipped browser group unless explicit override | FIXED |
| F-098 | P1 | Run all 407 files at default concurrency | deterministic result -> known browser/native aggregate-load flakes | `scripts/testing/run-tests.mjs:42`; initial 18 failures | none found | R | unit concurrency 4, browser concurrency 1 | FIXED entrypoint |
| F-099 | P1 | Ask test runner to exercise the actual dashboard/runner | mounted isolated app with explicit projects -> no official browser config or real app E2E existed | `playwright.config.ts:15,55`; `tests/e2e/product-smoke.spec.ts:55` | none found | R/source | official Playwright five-project smoke and dynamic-route contract | FIXED infrastructure |
| F-100 | P1 | Exercise recovery against HTTP runner + real Prisma DB | route, process, DB, event behaviour proven -> most runner tests import source/regex with mocks | `scripts/testing/start-smoke-runner.mjs:43,58` | none found | I | smoke runner plus mounted DB recovery suite | PARTIALLY FIXED; deeper multiclient/restart still open |
| F-101 | P2 | Review route/consumer tests for user-observable assertions | behavioural DOM/API outcomes -> many tests assert source strings/regex | `tests/dashboard-thread-page-safety.test.mjs:64` and broader inventory | none found | I | migrate high-risk source checks into smoke/contracts | OPEN gradual work |
| F-103 | P1 | Run `npm test` in dashboard/runner/core workspace | workspace's tests actually execute -> baseline scripts echoed success | `apps/dashboard/package.json:11`; `apps/runner/package.json:12`; `packages/core/package.json:29` | none found | R | scripts now route to real grouped runner | FIXED |
| F-104 | P2 | Inspect CI failure artifacts/quality gates | traces/screenshots/JUnit/a11y/visual/coverage where useful -> none configured for true app E2E | `playwright.config.ts:21,22,28-30`; baseline `.github/workflows/ci.yml` | none found | I | Playwright failure traces/screenshots/video/JUnit added; axe/visual/coverage remain follow-up | PARTIALLY FIXED |
| F-105 | P2 | Run timing-sensitive tests under host load | web-first/event assertions -> arbitrary sleeps cause flakes and latency | `tests/iphone-dictation-browser.test.mjs:229`; `tests/runner-transcription-queue.test.mjs:191` | none found | R/inventory | replace per touched high-risk path; lint/report remaining sleeps | OPEN |
| F-106 | P2 | Run browser tests in parallel | per-worker isolated data/artifacts -> shared ports/files/results can collide | `playwright.config.ts:17`; `scripts/testing/start-smoke-runner.mjs:8,15` | none found | R | smoke uses one worker and requires an explicit performance-named isolated DB; fuller worker isolation remains open | PARTIALLY FIXED |
| F-107 | P1 | Scan committed fixtures/logging assertions for private content | synthetic-only data enforced -> no automated fixture-privacy lint exists | root `package.json:35`; no privacy-lint script | none found | I | add privacy fixture/static-content lint | OPEN |
| F-108 | P2 | Compare CI runtime to packaged pilot runtime | same supported Node 22/ABI -> baseline CI used Node 20 | baseline `.github/workflows/ci.yml:10`; bundled Node 22.23.2 | none found | I | CI Node version assertion | FIXED |
| F-109 | P2 | Run root full suite after adding browser files | all intended files discovered once, groups cannot false-green -> ad hoc globs made scope unclear | `scripts/testing/run-tests.mjs:16,28` | none found | R/source | grouped discovery tests | FIXED |
| F-110 | P2 | Run phone matrix through the CI-configured harness | Chromium + WebKit projects start with installed browsers -> baseline had no reusable projects/install | `playwright.config.ts:73,81`; `.github/workflows/ci.yml:20,25` | none found | BR/AUT | final mounted Playwright run: both WebKit sizes and Android-like Chromium passed their applicable cases | FIXED |
| F-111 | P2 | Reproduce a smoke failure | trace, screenshot, video/JUnit locate boundary -> baseline emitted no standard app E2E artifacts | `playwright.config.ts:21,22,28-30` | none found | I | retained trace/screenshot/video and JUnit configuration | FIXED infrastructure |
| F-112 | P3 | Run browser test whose Google Chrome exists only on macOS | portable executable selection -> hard-coded app/browser assumptions can skip Linux | `playwright.config.ts:10`; `tests/iphone-dictation-browser.test.mjs:206` | none found | R/source | browser executable fallback tests | PARTIALLY FIXED |

### Severity summary and P0/P1 focus

The defect register contains **102 deduplicated root findings**: 8 P0, 57 P1,
34 P2, and 3 P3. Of these, 54 are fixed, 11 are partially fixed, and 37 remain
open or deliberately unchanged. The stable IDs retain gaps where duplicate or
invalid specialist findings were removed. These totals are reconciled directly
against the explicit register rows.

The initial P0 risks were F-019 (cross-thread stale state), F-020 (dictation
cross-thread leakage), F-021 (duplicate reviewed send), F-022 (false durable
send success), F-023 (retry duplicate side effect), F-037 (phone bearer
over insecure transport), F-057 (duplicate focus note), and F-058 (premature
focus acknowledgement). All except the physical secure phone-access proof were
addressed by controlled code/tests in this branch; the final verification
section must not convert controlled evidence into a physical-provider claim.

## Implemented hardening, partial coverage, and regression evidence

The table includes fully fixed rows and explicitly named partial outcomes. Each
implementation maps to the audited implementation commit placeholder, which is
replaced only after the exact code/test tree is committed.

| Fixed or partially fixed defect IDs | Implementation outcome | Regression evidence | Fix commit |
| --- | --- | --- | --- |
| F-001, F-002 | People uses supported Inbox query; inert opener buttons became calm non-interactive ideas | People navigation and route-failure tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-004, F-067 | Archived shows only explicit archives, separates link/selection, and distinguishes loading/error/empty | Archived contract test | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-005, F-006 | legacy At Risk route redirects to Today; unused helper removed | At Risk route test | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-007 | Reconnect exposes appropriate desktop and phone Search access | reconnect/mobile Search tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-008, F-010 | People/Logs/Demo/Archived error states are truthful; Settings copy is factual | operator route and copy tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-011, F-017, F-019, F-020 | thread identity, source-aware Back, per-thread composer session, and dictation generation are route-scoped | composer-session, source, identity, route-safety tests; smoke | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-013 | Command-K uses combobox/listbox/option semantics and restores focus | command palette tests; smoke | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-021 | reviewed-dictation/send controls reject rapid duplicate activation | dictation send-control and send-integrity tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-022, F-023, F-056 | send service persists terminal success before acknowledging, handles retry/client identity atomically, and re-reads P2002 winner | runner send integrity tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-024, F-064 | active draft uniqueness is enforced and dirty older data is deterministically repaired before schema push | draft uniqueness/repair and backup tests against SQLite | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-025 | scheduled send preserves reply and attachment intent; immediate attachment-only send was already valid at baseline | scheduled-send payload and thread send tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-037 | phone-access proxy defaults to loopback/Tailscale HTTPS; plain HTTP pairing returns 426 without a cookie; insecure mode requires an explicit fixture opt-in | 14 dashboard/desktop phone-access tests | `6efd6206d76391ed44a744e2c726d9498f71759c`; physical HTTPS pairing still blocked |
| F-038-F-043 | Setup plus focus/calendar writes wait, serialize, preserve durable state on load failure, and expose retry | setup, calendar, and focus tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-048 | owned-media cleanup is fixed; complete cross-table reset atomicity remains open | admin-reset media/delete-count tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-051 | ahead-of-runner SSE resume cursor is classified and recovered | SSE cursor tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-054 | WhatsApp poll request, receipt, client ID, and restart replay use durable send machinery; live votes/tallies remain blocked | durable poll/send/replay tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-057, F-058 | focus auto-ack uses durable per-window/person dedupe and records ack only after durable outcome | focus-auto-ack tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-059 | artifact cleanup obeys an explicit validated root | cleanup artifact tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-060 | schema-changing startup creates a consistent SQLite backup and fails closed if backup fails | database backup tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-066, F-068, F-069-F-071, F-075 | Receipts/Profile have named focus-managed dialogs; feedback is labelled; send/dictation errors are live; audited text/status tokens pass; Inbox selection is semantic | drawer, feedback, alert, contrast, and Inbox contracts | `6efd6206d76391ed44a744e2c726d9498f71759c`; remaining overlays/hairlines/focus rings stay open |
| F-076, F-077 | Inbox cache uses semantic keys, bounded LRU retention, and data-version single-flight | four cache contracts plus mounted coalescing/noise measurements | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-078 | initial sibling rail is bounded to 80 links, reducing mounted DOM from 4,083 to 1,918 nodes | sibling window tests and mounted measurement | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-079 | performance harness uses installed Patchright, validates samples, and has help contract | performance harness test | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-083, F-084, F-094, F-095 | minimal projection/events precede optional AI, Today/Inbox consume persistence, forced reads queue post-inflight work, and local iMessage avoids browser pacing | freshness, Inbox event, API recovery, and scan queue tests | `6efd6206d76391ed44a744e2c726d9498f71759c` |
| F-097-F-100, F-103, F-104, F-106, F-108-F-112 | grouped tests, real workspace entrypoints, isolated multi-project Playwright smoke, artifacts, CI Node/WebKit setup, and browser fallback; several rows remain explicitly partial | grouped runner, Playwright list, smoke tests, and CI contracts | `6efd6206d76391ed44a744e2c726d9498f71759c` |

### New or materially strengthened test infrastructure

- `scripts/testing/run-tests.mjs` discovers the repository tests, runs unit
  work with bounded concurrency, serializes browser fixtures, and rejects a
  silently skipped browser group unless an explicit override is supplied.
- Workspace `test` scripts for dashboard, runner, and core now execute their
  real groups rather than printing success.
- `playwright.config.ts` is the official mounted-smoke config. It defines normal
  desktop, constrained desktop, iPhone-like WebKit, small WebKit, and
  Android-like Chromium projects with one worker, deterministic locale/time
  zone/reduced motion, and failure artifacts. Its seven scenario definitions
  expand to 35 project cases: 10 applicable cases and 25 intentional
  project-mismatch skips.
- `scripts/testing/start-smoke-runner.mjs` creates only an explicit
  `/tmp/tovi-smoke-*` performance-named database, pushes the schema, seeds
  synthetic rows, clears all supported AI API keys, and starts a scan-disabled
  runner (`:8,15-17,43-58,69-71`). It refuses broad, unresolved, or
  non-performance fixture paths.
- `scripts/testing/seed-smoke-setup-state.mjs:4-14,27-69` transactionally seeds
  a deterministic, durably completed setup state in that isolated database
  before the runner starts. `tests/smoke-runner-contract.test.mjs:7-56` covers
  fixture path/API-key guards, seed ordering/content, and the build-time runner
  port in 3/3 passing contracts.
- `scripts/testing/build-smoke-dashboard.mjs:3,15-18` injects the isolated
  runner port at dashboard build time so the production bundle and smoke runner
  cannot silently disagree about the backend.
- `tests/e2e/product-smoke.spec.ts` covers the actual route inventory, command
  keyboard/focus behaviour, unsent draft navigation, People failure, phone
  in-app navigation, Back, composer layout, overflow, and Search.
- New focused tests cover People navigation, Archived truth, operator route
  failures, thread composer sessions, route identity, sibling windowing, send
  integrity, reset media, SSE cursor recovery, focus auto-ack, cleanup roots,
  and the performance harness.

## Existing issue and pull-request reconciliation

| Reference | Audit conclusion |
| --- | --- |
| issue #885 | its edit-text contrast fix was already present in the audited base (`bg-paper text-ink`); it is not a current finding in this report. |
| issue #957 | insecure phone bearer transport is a P0 security boundary; controlled hardening added, physical secure-origin pairing still required. |
| issue #958 | rapid reviewed send duplicate root reproduced/covered; fixed in UI and durable service contracts. |
| issue #972 | adapter-delivered/local-persistence failure root reproduced by deterministic contract; fixed by ordering durable terminal state before success. |
| issue #998 | packaged window-bounds risk remains; not physically verifiable in this worktree. |
| issue #1008 | command-palette semantics/focus root reproduced and fixed. |
| issue #202 | enabled-platform/scheduler regression remains relevant to freshness; partial runner gating is not enough for a full pass. |
| PR #1045 | active Instagram owner. Read-only inspection only; no merge and no Instagram-specific changes. |
| PR #1047 | inspected but not merged. Safe concepts were independently implemented where justified; cleanup that could delete retry media and strict reply-parent logic were deliberately rejected. |

Historical issues are not counted as failures merely because they exist. The
register includes only roots that reproduced or remain deterministically present
at the audited commit.

## Verification boundary: what was and was not proved

### Physically or directly verified

- macOS/Apple Silicon host and bundled Node 22 runtime were used directly.
- The real local iMessage database watcher could be armed/read without sending;
  its file-event latency was measured.
- The route tree, generated SQLite schema, loopback runner/dashboard, Chrome
  rendering, local APIs, database queries, and filesystem cleanup roots were
  exercised directly in isolated paths.

### Verified only through controlled automation

- send, retry, acknowledgement, durable-poll, focus auto-note, platform error,
  AI failure, setup write failure, and selected reset paths;
- phone layouts and navigation in Chromium-sized projects;
- dictation preparation/transcription state without a physical microphone;
- iMessage/WhatsApp/LinkedIn watcher and adapter contracts beyond the one local
  filesystem-watch boundary;
- mounted Chromium and WebKit route/navigation/layout cases across all five
  Playwright projects;
- performance paths over generated, content-safe data.

### Still blocked, with exact reasons

- Physical iPhone Safari/WebKit, installed standalone PWA, real keyboard,
  gestures, safe areas under device chrome, rotation, VoiceOver, and sleep/wake:
  no physical iPhone/Simulator lifecycle was available.
- Android/TalkBack/coarse touch: no Android device/emulator was available.
- Packaged Electron interaction, OS notification permission, first-launch
  window bounds, and representative idle CPU/memory: no isolated packaged
  interactive session was available.
- Real LinkedIn, Instagram, WhatsApp, or Google Messages authentication, scan,
  reaction, edit, poll, attachment, and send: no safe test account/recipient was
  authorised; concurrent session locks and account safety were preserved.
- AI-provider billing/key/session failure in production: controlled clients
  only; no live paid call was necessary to prove local recovery contracts.
- Destructive live reset/update: forbidden without explicit permission.
- Update readiness recovery: source-inspected only, remains a failed workflow,
  and no installer transition was attempted.
- Real offline/online and macOS sleep/wake: no deterministic safe lifecycle
  harness was available.

## Known risks and recommended follow-up

Priority order follows pilot harm, not implementation convenience.

1. Finish the secure phone-access physical check before pilot use: HTTPS/secure
   origin, bearer non-leakage, Safari standalone launch, and unauthorised LAN
   request rejection. Implement and verify pairing-token rotation/expiry; the
   current token is stable and the cookie lifetime is 30 days.
2. Complete runner-owned scheduling with durable user cadence,
   `enabledPlatforms`, quiet hours, per-platform last-success state, and a
   coalesced resume epoch. Until then TTTFS remains unbounded.
3. Add durable provider cursors and deep reconciliation so bursts beyond the
   newest-message caps are eventually complete. Keep the implemented
   projection/event-before-AI ordering.
4. Add bounded independent lanes only after a prototype proves local iMessage
   can bypass slow browser work without violating shared DB/session locks.
5. Close the remaining send/media crash-recovery gaps with mounted-runner,
   real-Prisma restart tests. Never "solve" uncertainty by automatically
   repeating an external send.
6. Exercise backup restore and interrupted schema-update recovery as a mounted
   application drill; duplicate-draft repair is now deterministic and tested.
7. Correct the remaining low-contrast hairlines and focus rings, then run axe,
   keyboard, light/dark screenshots, VoiceOver, and TalkBack.
8. Repair phone target geometry, the 390 x 400 composer/timeline allocation, and
   the Inbox tool carousel; then run physical iPhone and Android stress content.
9. Persist Inbox query/filter/scroll/focus across thread round trips so the calm
   triage context does not disappear.
10. Add mounted multi-client/restart/network fault tests, fixture privacy lint,
    and progressively replace high-risk source-regex tests with behavioural
    contracts.
11. Keep `/people`, `/platforms`, `/logs`, and `/demo` hidden/secondary. Do not
    expand People into CRM or expose operator diagnostics at equal weight.
12. Hand Instagram findings to PR #1045's owner; do not fold that branch into
    this audit commit.

## Deliberately not changed

- Instagram-specific code, selectors, automation, or shared adapter behaviour,
  because PR #1045 has a concurrent owner.
- Provider cooldowns, rate guards, human-like pacing for browser platforms,
  identity checks, authentication guards, or stable-key deduplication.
- Strict same-literal-thread reply validation from PR #1047, because canonical
  iMessage siblings make it incorrect.
- Broad artifact deletion from PR #1047, because a staged file may be the only
  retryable copy after an uncertain send.
- A full scheduler/parallel-scan rewrite without final scenario measurements.
- Physical sends, disconnects, resets, update installation, or use of private
  pilot conversations.
- New product features, analytics, CRM, relationship scores, default full AI
  drafts, or automatic AI sending.

## Final verification ledger

Commands used the bundled Node 22 runtime through
`PATH=/Applications/Tovi.app/Contents/Resources/runtime/node/bin:/usr/bin:/bin:/usr/sbin:/sbin`.
A failed, partial, or blocked check stays visible; it is never converted to a
silent omission.

| Verification | Exact command/scope | Result |
| --- | --- | --- |
| Inbox cache contracts | `node --import tsx --test tests/runner-inbox-response-cache.test.mjs` | PASS, 4/4 |
| draft repair and fail-closed backup | `node --import tsx --test tests/draft-uniqueness-hardening.test.mjs tests/start-app-database-backup.test.mjs` | PASS, 6/6 against SQLite, including unique index |
| scheduled payload and dictation send controls | `node --import tsx --test tests/dashboard-scheduled-send-payload.test.mjs tests/dashboard-dictation-message-send-controls.test.mjs` | PASS, 9/9 |
| freshness projection contract | `node --import tsx --test tests/runner-message-freshness-contract.test.mjs` | PASS, 3/3, including blocked-AI projection/event ordering |
| send/focus/reset/cleanup/SSE integrity batch | `node --import tsx --test tests/runner-send-integrity.test.mjs tests/runner-focus-auto-ack.test.mjs tests/runner-admin-reset-media.test.mjs tests/runner-cleanup-artifacts.test.mjs tests/runner-sse-resume-cursor.test.mjs` | PASS, 32/32 |
| WhatsApp focused batch | `node --import tsx --test tests/*whatsapp*.test.mjs` | PASS, 140/140 |
| deterministic smoke setup contracts | `node --import tsx --test tests/smoke-runner-contract.test.mjs` | PASS, 3/3: isolated performance-fixture/API-key guards, durable completed setup seed before runner start, and build-time runner port |
| dashboard lint | `npm run lint --workspace @inbox-os/dashboard` | PASS |
| runner lint | `npm run lint --workspace @inbox-os/runner` | PASS |
| runner build/typecheck | `npm run build --workspace @inbox-os/runner` | PASS |
| core build/typecheck | `npm run build --workspace @inbox-os/core` | PASS |
| production dashboard build | `node scripts/testing/build-smoke-dashboard.mjs` through `pretest:smoke` | PASS on the exact final source with the isolated runner port baked in |
| documentation | `npm run docs:check` | PASS, 54 Markdown files |
| complete repository suite | `npm run test:all` after adding the durable smoke setup contract | PASS exact-final: core build PASS; runner build PASS; unit/integration 2,788/2,788 PASS, 0 fail/cancel/skip, 42,866 ms; required Patchright browser fixtures 45/45 PASS, 0 fail/cancel/skip, 360,536 ms |
| mounted-smoke enumeration | `npx playwright test -c playwright.config.ts --list` plus project-predicate inspection in `tests/e2e/product-smoke.spec.ts` | PASS: five projects, seven scenarios, 35 project cases; 10 applicable and 25 intentional project-mismatch skips |
| complete mounted smoke | `RUST_BACKTRACE=full PRISMA_LOG_LEVEL=debug RUST_LOG=debug PATH='/Applications/Tovi.app/Contents/Resources/runtime/node/bin:/usr/bin:/bin:/usr/sbin:/sbin' npm run test:smoke` | PASS in 49.6 s: production build PASS; 35 project cases, 10 applicable PASS, 25 intentional project-inapplicable skips, 0 FAIL |
| desktop smoke 1440 x 900 | same complete smoke command, project `desktop-chromium-1440x900` | PASS: 6 applicable cases; 1 intentional project-inapplicable skip |
| constrained desktop smoke | same complete smoke command, project `desktop-small-1024x700` | PASS: 1 applicable case; 6 intentional project-inapplicable skips |
| Android-like phone smoke | same complete smoke command, project `phone-chromium-360x800` | PASS: 1 applicable case; 6 intentional project-inapplicable skips |
| iPhone-like WebKit smoke | same complete smoke command, projects `phone-webkit-390x844` and `phone-webkit-small-360x640` | PASS: 2 applicable cases; 12 intentional project-inapplicable skips; automated WebKit only |
| visual desktop/phone review | controlled mounted thread review at desktop and phone widths | PARTIAL: 80-to-160 sibling expansion and source-aware Back were visually confirmed; complete changed-state/light-dark/physical review remains blocked |
| interaction benchmark | production services, 1,000 threads / 20,000 messages, bounded browser harness | BLOCKED for final percentiles: reached 20 initial-render samples without a complete result document; no partial percentile promoted |
| API/cache benchmark | 30-sample direct endpoint run plus fresh ten-way coalescing and 52-noise retention runs | PASS for operational evidence; exact values are in the performance tables; latency improvement remains inconclusive |
| request-volume benchmark | baseline visible/hidden/resume/two-client network observation | PARTIAL: baseline 14 visible, 0 hidden, 5 resume, 28 two-client requests; post-hardening volume unmeasured and scheduling unchanged |
| freshness benchmark | `node --import tsx --test tests/runner-message-freshness-contract.test.mjs` plus controlled persisted-to-visible harness | PARTIAL: projection/event ordering PASS and prior p50/p95 33.2/34.4 ms after persistence; end-to-end TTTFS remains unbounded |
| doctor | `npm run doctor` | PASS on Node 22.23.2/npm 10.9.8; `.env` and the local database were present; expected warnings for an unset optional `DATABASE_URL` and stopped 3100/4001 services, no blockers |
| diff hygiene | `git diff --check`; `git diff --no-index --check /dev/null docs/qa/2026-08-21-full-product-hardening.md`; worktree status review | PASS for tracked and new-report whitespace; disposable smoke databases and generated browser artifacts were removed before commit |

### Final summary values for chat handoff

Count reconciliation at this report handoff: 143 workflow rows, initially 83
PASS / 45 FAIL / 15 BLOCKED / 0 NOT APPLICABLE; currently 116 PASS / 12 FAIL /
15 BLOCKED / 0 NOT APPLICABLE. The deduplicated register has 102 findings: 8 P0
/ 57 P1 / 34 P2 / 3 P3, with 54 fixed, 11 partially fixed, and 37 open or
deliberately unchanged. There are no open P0 findings; 28 P1 findings remain
open or partial.

| Required value | Durable report value |
| --- | --- |
| routes inventoried | 13 total page routes: root redirect plus 12 named pages; 5 route handlers also inventoried |
| user-facing/operator workflows inventoried | 143 explicit `WF-` rows |
| passed initially | 83 of 143 workflow rows |
| failed initially | 45 of 143 workflow rows |
| fixed | 54 defect roots; 33 workflow rows moved FAIL to PASS |
| remain blocked | 15 workflow rows |
| current workflow result | 116 PASS / 12 FAIL / 15 BLOCKED / 0 NOT APPLICABLE |
| P0/P1 | 8 P0, all fixed; 57 P1, with 28 open or partial; IDs in defect register |
| redundant surfaces | 17 cases classified; harmful Archived inference and legacy At Risk changed |
| desktop | controlled result in desktop matrix; packaged/native boundaries blocked |
| phone | baseline 21 PASS / 4 FAIL / 13 BLOCKED; current 23 PASS / 3 FAIL / 12 BLOCKED |
| performance | final cached API p50/p95 14.66/40.81 ms; no-cache Inbox 97.36/197.43 ms; fresh ten-way burst 1 miss/9 coalesced; 52/52 noise hits; thread surface 80 links/1,918 DOM nodes; browser percentiles and post-hardening request volume unmeasured |
| TTTFS | unbounded before and after; minimal thread projection/event now precedes optional AI and the prior persisted-to-visible segment was p50/p95 33.2/34.4 ms |
| deliberately unchanged | Instagram/PR #1045, unsafe PR #1047 parts, account guards, live external actions, non-pilot features |
| branch / commit | `chore/full-product-hardening` / `6efd6206d76391ed44a744e2c726d9498f71759c` |
| tests/builds | focused batches, lints, all builds, docs, doctor, operational benchmarks, exact-final 2,788/2,788 unit/integration tests, 45/45 required browser fixtures, and mounted Playwright smoke (10 applicable PASS, 25 intentional skips, 0 FAIL) pass |
