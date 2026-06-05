# Relationship Inbox OS Bug Audit

This audit tracks the reliability/session bugs reproduced from baseline and fixed in this implementation pass.

## Bug Entries

### BUG-001: LinkedIn scan frequently degrades with generic unread-scan failure
- Symptom: Platform status flips to `DEGRADED` with `Failed while scanning LinkedIn unread threads` and low debugging value.
- Repro steps:
1. Trigger LinkedIn scan on a live inbox with dynamic list updates.
2. Observe scan failure in Activity Log with limited stage/thread context.
- Root cause: Adapter errors were thrown without consistent stage metadata and often with generic messages; scan logs did not include full error stack/stage/thread context.
- Fix:
1. Added stage-aware adapter failures with screenshot/DOM capture and cause chain (`toStageFailure`).
2. Added stage/thread/request details and stack fields in scan audit paths (`SCAN_AUTH_REQUIRED`, `THREAD_SYNC_FAIL`, `SCAN_FAIL`, `SELECTOR_FAIL`).
3. Added unhandled process rejection/exception audit handlers.
- Files changed:
1. `apps/runner/src/platforms/utils.ts`
2. `apps/runner/src/platforms/linkedin-adapter.ts`
3. `apps/runner/src/services/scan-queue.ts`
4. `apps/runner/src/index.ts`

### BUG-002: LinkedIn misses threads unless list is deeply scrolled
- Symptom: Only first viewport threads are collected; unread/recent thread coverage is incomplete.
- Repro steps:
1. Open inbox with many conversations.
2. Run scan without manually scrolling list.
3. Compare discovered threads against visible threads after manual deep scroll.
- Root cause: Thread discovery had fragile stability heuristics and unstable identity fallback, with transient DOM identifiers contaminating dedupe.
- Fix:
1. Hardened scroll-collect loop with explicit stop reason and metrics.
2. Removed volatile Ember-id based identity fallback.
3. Added stable-key preference chain: URN/href token/safe data-id/fallback composite.
4. Added regression tests for stop reason behavior and collection stability.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `tests/runner-linkedin-scroll.test.mjs`

### BUG-003: Inbox previews repeat/cross-contaminate across threads
- Symptom: Multiple people show the same snippet or stale snippet.
- Repro steps:
1. Scan LinkedIn inbox with several distinct recent conversations.
2. Open inbox list; observe duplicate snippets across different threads.
- Root cause: Preview selection preferred parsed message body over thread-list snippet; parse race/activation mismatch could leak previous thread text.
- Fix:
1. Preview update now prioritizes per-thread list snippet (`candidate.lastMessagePreview`) first.
2. Added explicit preview mapping regression test fixture to enforce per-thread isolation.
3. Improved open-thread activation path usage for `openThread` and message fetch.
- Files changed:
1. `apps/runner/src/services/scan-queue.ts`
2. `apps/runner/src/platforms/linkedin-adapter.ts`
3. `tests/fixtures/linkedin/thread-list-snapshots.json`
4. `tests/runner-linkedin-preview.test.mjs`

### BUG-004: `Target page/context/browser closed` across scan/connect/send/open paths
- Symptom: Intermittent failures across LinkedIn/Instagram/TikTok during active operations.
- Repro steps:
1. Trigger scans plus manual platform actions close together.
2. Observe target-closed errors while adapter-owned contexts/pages are recreated or preemptively closed.
- Root cause: Each adapter owned its own context lifecycle; session preemption closed contexts broadly; page recreation and ownership were fragmented.
- Fix:
1. Added shared `SessionManager` with one person context and per-platform tabs.
2. Migrated LinkedIn + Beta adapters to managed pages/tabs.
3. Added page recreation path when platform tab is closed.
4. Converted reset-session into shared person-context reset.
- Files changed:
1. `apps/runner/src/services/session-manager.ts`
2. `apps/runner/src/services/platform-factory.ts`
3. `apps/runner/src/platforms/linkedin-adapter.ts`
4. `apps/runner/src/platforms/beta-adapter.ts`
5. `apps/runner/src/index.ts`
6. `apps/dashboard/app/platforms/page.tsx`

### BUG-005: Scan overlap and race between manual/scheduled/control actions
- Symptom: Lifecycle races and inconsistent operations when scans and control actions happen near-simultaneously.
- Repro steps:
1. Run scheduler scan and trigger manual connect/open/send/test selectors.
2. Observe state races and unstable browser/page ownership behavior.
- Root cause: No consistent per-person+platform lock; scan queue/process loop had unmanaged async paths.
- Fix:
1. Added keyed mutex service with `queue_one` support.
2. Applied per-platform lock keys (`default:PLATFORM`) across scan and control flows.
3. Added queue processor/scheduler catch boundaries to avoid unhandled background failures.
- Files changed:
1. `apps/runner/src/services/keyed-mutex.ts`
2. `apps/runner/src/services/scan-queue.ts`
3. `apps/runner/src/index.ts`
4. `tests/runner-keyed-mutex.test.mjs`

### BUG-006: Instagram/TikTok selector/connect flow misclassified auth states
- Symptom: Login/QR pages surfaced as selector failures instead of actionable auth-required state.
- Repro steps:
1. Open IG login page or TikTok QR login page.
2. Run connect or selector tests.
3. Observe generic selector mismatch/error responses.
- Root cause: No platform-specific auth detection in beta adapter and selector test service.
- Fix:
1. Added IG login form detection and TikTok QR/login gate detection.
2. Throw `AdapterFailure(kind=AUTH_REQUIRED)` from adapter/selector service when auth is needed.
3. Mapped selector test response status to 401 for auth-required conditions.
- Files changed:
1. `apps/runner/src/platforms/beta-adapter.ts`
2. `apps/runner/src/services/selector-tests.ts`
3. `apps/runner/src/index.ts`
4. `apps/runner/src/platforms/utils.ts`

### BUG-007: Async route/loop error paths could become unhandled promise rejections
- Symptom: Silent or partially logged failures from async GET handlers and background loops.
- Repro steps:
1. Trigger async exception in `/data/*` or `/health`.
2. Trigger error in scheduler tick or detached queue processing.
3. Observe missing structured audit entries.
- Root cause: Express async handlers not consistently wrapped; detached async loops lacked catches.
- Fix:
1. Wrapped async GET routes with `asyncRoute`.
2. Added explicit catch logging for queue processor and scheduler tick.
3. Added process-level unhandled rejection/uncaught exception audit logging.
- Files changed:
1. `apps/runner/src/index.ts`
2. `apps/runner/src/services/scan-queue.ts`

### BUG-008: Message model lacked sender/raw fields for full conversation reconstruction
- Symptom: Conversation view and normalized payload cannot preserve sender identity/raw platform message metadata.
- Repro steps:
1. Fetch thread API payload.
2. Observe missing sender/raw fields despite platform DOM containing useful metadata.
- Root cause: Message schema/types/api omitted sender/raw fields.
- Fix:
1. Extended Prisma `Message` model with `senderName` and `rawJson`.
2. Extended `NormalizedMessage` with `senderName` and `raw`.
3. Persisted sender/raw in scan pipeline and returned fields via thread API.
4. Rendered sender labels in conversation UI.
- Files changed:
1. `packages/core/prisma/schema.prisma`
2. `packages/core/src/types.ts`
3. `apps/runner/src/services/scan-queue.ts`
4. `apps/runner/src/index.ts`
5. `apps/dashboard/lib/types.ts`
6. `apps/dashboard/app/thread/[id]/page.tsx`

### BUG-009: Local catch blocks for thread send/open swallowed failure context
- Symptom: Thread open/send failed responses lacked stage/thread/platform diagnostics and stack context.
- Repro steps:
1. Trigger send/open failure.
2. Observe only generic HTTP error message with reduced traceability.
- Root cause: Catch blocks returned 500 without structured audit diagnostics.
- Fix:
1. Reworked send/open control routes to log stage-tagged failures with thread/platform IDs and stack context.
2. Coordinated these actions through platform mutex to avoid concurrent lifecycle interference.
- Files changed:
1. `apps/runner/src/index.ts`

### BUG-010: LinkedIn selector tests failed with `page.evaluate` `__name is not defined`
- Symptom: Platforms page `Run selector tests` failed with `500` and raw frontend exception text (`ReferenceError: __name is not defined`).
- Repro steps:
1. Open Platforms page.
2. Click `Run selector tests` for LinkedIn.
3. Observe backend `500` and frontend crash-style error text from `lib/api.ts`.
- Root cause: Browser-context function serialization pulled in transpiler helper leakage (`__name`) through unsafe evaluate usage patterns; endpoint returned non-structured raw error strings.
- Fix:
1. Reworked selector-test evaluation path to a pure browser callback contract (`page.evaluate((arg) => { ... }, arg)`).
2. Added explicit selector-test stage pipeline with first-class `auth_check`.
3. Added structured failure payload contract (`ok:false`, `platform`, `stage`, `error`, `requestId`, optional `reason/receipts/artifacts`) and structured success envelope.
4. Added auth-required `401` handling for LinkedIn/Instagram/TikTok selector runs.
5. Added regression tests for evaluate safety, contract guarantees, and integration-ish local-page selector execution.
- Files changed:
1. `apps/runner/src/services/selector-tests.ts`
2. `apps/runner/src/index.ts`
3. `tests/runner-selector-evaluate-safety.test.mjs`
4. `tests/runner-selector-contract.test.mjs`
5. `tests/runner-selector-service.test.mjs`

### BUG-011: Unread-only LinkedIn scans did not enforce the Unread filter pill
- Symptom: Unread scans could include stale/non-unread list state depending on LinkedIn UI state and missed intended unread-only context.
- Repro steps:
1. Start LinkedIn scan in unread mode.
2. Keep inbox on `All` filter.
3. Observe scan relying only on badge parsing without forcing Unread tab activation.
- Root cause: `scanUnreadThreads` did not explicitly activate `button[data-test-messaging-inbox-filters__filter-pill=\"UNREAD\"]`.
- Fix:
1. Added unread-pill activation helper with active-state detection.
2. Added bounded refresh waiting strategy: active-state flip OR spinner cycle OR bounded settle delay fallback.
3. Added safe fallback when pill is missing or not clickable.
4. Added unread-pill regression tests and LinkedIn fixture.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `tests/runner-linkedin-unread-pill.test.mjs`
3. `tests/fixtures/linkedin/unread-pill.html`

### BUG-012: Extra `about:blank` tab introduced nondeterministic managed-page ownership
- Symptom: Shared managed session could keep an extra default blank tab before platform pages, making page mapping brittle.
- Repro steps:
1. Launch managed browser context for a person.
2. Open LinkedIn platform page.
3. Observe extra blank tab remains in context.
- Root cause: Session manager always created a new page and did not reuse eligible default blank page or clean unassigned blank leftovers.
- Fix:
1. Added blank-page reuse logic gated by URL blank/open state/unmapped ownership.
2. Added page ownership metadata tracking per platform mapping.
3. Added cleanup of unassigned blank pages while preserving mapped platform pages.
4. Added session manager tests for reuse and non-reuse when mapped to another platform.
- Files changed:
1. `apps/runner/src/services/session-manager.ts`
2. `tests/runner-session-manager.test.mjs`

### BUG-013: Frontend selector-test failures were not rendered as structured UI errors
- Symptom: Platforms UI threw raw text errors and did not show stage/reason/requestId/artifact pointers.
- Repro steps:
1. Trigger selector-test failure.
2. Observe frontend throw from `apiPost` with raw response text and no structured error panel.
- Root cause: `apiPost` only threw plain `Error(text)` and UI had no typed selector-failure contract handling.
- Fix:
1. Added `ApiRequestError` with status + parsed payload + raw fallback text.
2. Added JSON-then-text fallback error parsing for non-JSON responses.
3. Added typed selector-test success/failure models.
4. Added inline selector error panel in Platforms UI with stage/reason/requestId/artifact links.
- Files changed:
1. `apps/dashboard/lib/api.ts`
2. `apps/dashboard/lib/types.ts`
3. `apps/dashboard/app/platforms/page.tsx`

### BUG-014: LinkedIn unread live scan failed at `collect_threads` during unread-filter transition, with root cause hidden by wrapper message
- Symptom: Dashboard showed `Failed while scanning LinkedIn unread threads` while selector tests passed; real collect-stage runtime cause was not surfaced.
- Repro steps:
1. Trigger LinkedIn unread scan in live runner session.
2. Observe degraded run for `jobId/requestId: c3aac437-6578-40a0-b03a-6f8f5bc2abdf`.
3. Inspect artifacts and receipt data:
   - stage: `collect_threads`
   - action: `SELECTOR_FAIL`
   - screenshot: `data/screenshots/linkedin-scan-unread-2026-02-18T15-44-40-904Z.png`
   - DOM dump: `data/dom_dumps/linkedin-scan-unread-2026-02-18T15-44-40-904Z.html`
   - observed state: unread pill active, spinner visible, `thread_item` count `0`.
- Root cause:
1. Unread filter can trigger DOM replacement + transient loading windows (spinner + zero rows), causing collect instability unless list/container is reacquired on retry.
2. Failure persistence prioritized wrapper message, so the actionable inner exception was not promoted into platform-level scan summary.
- Fix:
1. Added stage receipts and runtime context snapshots in LinkedIn unread scan path (`navigate`, `auth_check`, `unread_filter`, `collect_threads`).
2. Hardened collect loop for transient execution-context/detachment races with bounded retries and fresh reacquisition of list/container state.
3. Treated spinner+zero-row windows as transient loading (bounded retries) instead of immediate hard failure.
4. Improved failure summarization and reason extraction in scan queue to prefer inner actionable messages and classify reasons when explicit reason is absent.
5. Extended `/data/platforms` failure summary derivation to read nested `innerError/error` messages.
6. Added regression fixture/tests for unread rerender, transient execution-context failure retry, and container-only scrolling behavior.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `apps/runner/src/services/scan-queue.ts`
3. `apps/runner/src/index.ts`
4. `tests/fixtures/linkedin/unread-rerender-scroll.html`
5. `tests/runner-linkedin-scan-resilience.test.mjs`
6. `apps/dashboard/app/platforms/page.tsx`
7. `apps/dashboard/components/common/degraded-banner.tsx`
8. `apps/dashboard/lib/types.ts`

### BUG-015: LinkedIn unread `collect_threads` crashed with `page.evaluate: ReferenceError: __name is not defined`
- Symptom: Live unread scans failed at stage `collect_threads` and dashboard showed `collect_threads · unknown · request <id>`.
- Repro steps:
1. Connect LinkedIn and trigger unread scan from live runner.
2. Observe failure at `collect_threads` with `page.evaluate: ReferenceError: __name is not defined`.
3. Confirm selector tests still pass, proving this is specific to live unread collect path.
- Root cause:
1. `collect_threads` used a large browser-context `page.evaluate` callback.
2. In dev/runtime transpilation, browser-context function serialization pulled in module helper leakage (`__name`) not present in page context.
3. Reason mapping did not classify this specific runtime failure, so UI showed `unknown`.
- Fix:
1. Rewrote LinkedIn `collect_threads` extraction/scroll loop to use locator-driven DOM reads and container scrolling without `page.evaluate` in collect stage.
2. Kept deep-scroll + dedupe behavior and added `.msg-conversation-listitem` / `.msg-conversation-listitem__link` alignment, including `scrollIntoViewIfNeeded()` before row clicks.
3. Added explicit failure categorization for `__name`/reference/timeout paths (`evaluate_helper_missing`, `evaluate_reference_error`, `timeout`) in scan reason resolution.
4. Added regression coverage for the real production collect path and a guard test preventing string evaluate usage in unread scan flow.
5. Added message-iterator sanity test fixture for `div.msg-s-event-listitem[data-event-urn]` parsing and non-text/system fallback handling.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `apps/runner/src/services/scan-queue.ts`
3. `tests/runner-linkedin-scan-resilience.test.mjs`
4. `tests/runner-linkedin-scroll.test.mjs`
5. `tests/fixtures/linkedin/message-events.html`
6. `tests/runner-linkedin-message-iterator.test.mjs`

### BUG-016: LinkedIn unread scans could loop at end-of-list, trigger recovery/reload churn, and surface weak failure reasons
- Symptom:
1. Live unread scans could keep scrolling after reaching list end.
2. Repeated failures caused rapid re-run/recovery churn instead of bounded retries.
3. Some failures still surfaced as `unknown`, including `Target page/context/browser has been closed` races.
4. Manual scans during active failure windows had no explicit cooldown UX.
- Repro steps:
1. Trigger LinkedIn unread scan against a live inbox with transient rerenders/loading and virtualized list behavior.
2. Observe repeated deep-scroll iterations at list end and repeated recovery navigation attempts.
3. In failure cases, observe generic/unknown reason summary and limited user-facing actionability.
- Root cause:
1. End-of-list detection relied too much on volatile visible-set churn rather than unique-growth + stable bottom-key/no-move signals.
2. Retry/recovery limits were only request-local; no process-level cooldown/backoff guard across repeated failed runs.
3. Queue reason categorization did not explicitly classify some known signatures (`page_closed_mid_stage`, repeated reload suppression).
4. Session reset/close operations could continue after lease-wait timeout, allowing mid-stage lifecycle races.
- Fix:
1. Hardened LinkedIn collect loop termination using deterministic no-growth/bottom-repeat/no-move streaks and stable-key fallback without volatile timestamp token.
2. Added bounded process-wide recovery guard in LinkedIn adapter and explicit `repeated_reload_guard_triggered` failure path.
3. Added queue-level retry controller with per-platform cooldown progression `30s -> 60s -> 120s` and scheduler/manual cooldown enforcement.
4. Added `/control/scan` blocked payload contract (`ok:false`, `blocked:true`, `reason:"cooldown_active"`, `retryAfterSeconds`, `requestId`) and dashboard inline cooldown rendering.
5. Added explicit queue reason mapping for `page_closed_mid_stage` and reload suppression.
6. Added lease-drain timeout failure in session manager close/reset path to avoid forced close during active leased work.
7. Added regression tests for real collect path/no-string-evaluate guard/deep-scroll termination/circuit-breaker/page-closed reason classification.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `apps/runner/src/services/scan-queue.ts`
3. `apps/runner/src/services/scan-retry-controller.ts`
4. `apps/runner/src/services/session-manager.ts`
5. `apps/runner/src/index.ts`
6. `apps/dashboard/lib/types.ts`
7. `apps/dashboard/app/platforms/page.tsx`
8. `tests/runner-linkedin-scroll.test.mjs`
9. `tests/runner-linkedin-collect-threads-no-name-error.test.mjs`
10. `tests/runner-linkedin-deep-scroll-terminates.test.mjs`
11. `tests/runner-linkedin-no-string-evaluate.test.mjs`
12. `tests/runner-scan-retry-circuit-breaker.test.mjs`
13. `tests/runner-page-closed-mid-stage-reason.test.mjs`

### BUG-017: LinkedIn unread smoke ingest debug path + visible logging
- Symptom:
1. LinkedIn unread troubleshooting was hard because terminal logs were easy to miss and run artifacts were hard to locate quickly.
2. Existing unread scans include deep-scroll/recovery complexity, making it difficult to validate the minimal parse/persist path.
- Repro steps:
1. Run LinkedIn unread scan while debugging selector/runtime instability.
2. Observe loop/retry-heavy path and ambiguous run visibility when `RUN_TRACE=0`.
- Root cause:
1. No dedicated single-thread smoke path existed for unread filter validation.
2. No obvious always-on terminal prefix logs and no stable latest-pointer for smoke runs.
- Fix:
1. Added `POST /control/platform/linkedin/smoke-unread` and `npm run linkedin:smoke`.
2. Added LinkedIn adapter `smokeUnreadIngest()` with strict no deep-scroll/no reload/retry loops and exactly-one-thread processing.
3. Added smoke selector extractors for first thread row + visible message parsing.
4. Reused normal DB persistence pipeline via `scanQueue.syncThreadForIngest(...)`.
5. Added prominent `[LI][SMOKE][req=...][step=x/8]` logs, start/end `LOG_DIR` lines, `pretty.log`, and latest pointer file `logs/runs/LATEST_LINKEDIN_SMOKE.txt`.
6. Added parser fixture test `runner-linkedin-smoke-parsing.test.mjs` using `page.setContent()`.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `apps/runner/src/services/scan-queue.ts`
3. `apps/runner/src/services/run-logger.ts`
4. `apps/runner/src/services/linkedin-smoke-logger.ts`
5. `apps/runner/src/index.ts`
6. `apps/runner/src/cli.ts`
7. `apps/runner/package.json`
8. `package.json`
9. `.env.example`
10. `tests/fixtures/linkedin/smoke-unread.html`
11. `tests/runner-linkedin-smoke-parsing.test.mjs`
12. `README.md`

### BUG-018: LinkedIn unread smoke saw `0` rows while unread view was visibly populated
- Symptom:
1. Live LinkedIn unread view showed populated rows/counters, but smoke logs reported `threadRowCount=0` and failed before ingest.
2. Runs often started from `/messaging/thread/...` and selector assumptions around `.msg-conversation-listitem` were too strict for live variants.
- Repro steps:
1. Open LinkedIn messaging with unread threads visible and run `npm run linkedin:smoke`.
2. Observe unread pill activation succeeds, but row detection remains `0` despite visible unread counters.
3. Smoke fails at `collect_threads` with an empty/unapplied interpretation.
- Root cause:
1. Smoke path relied on brittle wrapper selectors and did not classify populated-but-undetectable list state separately from true empty state.
2. Entry URL handling could remain in thread route context.
3. Probe artifacts were not guaranteed for every smoke run/failure branch.
- Fix:
1. Forced smoke entry URL to `https://www.linkedin.com/messaging/?filter=unread` with one corrective navigation when redirected to thread URL.
2. Replaced row discovery with structure-based participant-name plus clickable-ancestor detection and spacer filtering.
3. Added bounded unread settle polling (12s) for rows or true empty-state phrases without scroll/reload/retry loops.
4. Added selector-mismatch classification (`selector_mismatch_thread_rows`) with exact high-signal error sentence and mismatch guardrails.
5. Added mandatory smoke probe artifacts (`list-probe.json/.html/.png`) and failure artifacts (`dom.html`, `failure.png`), with richer unread counter probes/samples.
6. Updated endpoint/direct smoke response shape to include `outcome`, `unreadCount`, `messagesParsed`, and `probeArtifacts`; empty unread now returns success (`UNREAD_EMPTY`).
7. Expanded fixture/tests for spacer rows, convo-item-link click targets, unread counter variants, fallback clickable ancestor discovery, and outcome classification.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `apps/runner/src/index.ts`
3. `apps/runner/src/services/linkedin-smoke-direct.ts`
4. `tests/fixtures/linkedin/smoke-unread.html`
5. `tests/runner-linkedin-smoke-parsing.test.mjs`
6. `README.md`

### BUG-019: LinkedIn smoke navigate failed early with `messaging_shell_not_ready` when LinkedIn landed on thread URL
- Symptom:
1. `npm run linkedin:smoke` failed in stage `navigate` with reason `messaging_shell_not_ready`.
2. Live sessions often landed on `/messaging/thread/<id>/?filter=unread` with messaging UI visible, but smoke still failed before unread activation.
- Repro steps:
1. Open LinkedIn messaging where URL resolves to `/messaging/thread/<id>/?filter=unread`.
2. Run `npm run linkedin:smoke`.
3. Observe early navigate failure before unread/list ingest flow.
- Root cause:
1. Navigate readiness was a one-shot selector check and included redirect-correction behavior that treated thread-route landing as problematic.
2. Readiness criteria were too brittle for SPA hydration timing and route variants.
- Fix:
1. Added DOM-based shell readiness helper (`isLinkedInMessagingShellReady`) that accepts either root messaging or thread messaging route when left panel/list row signals are present.
2. Removed hard corrective redirect behavior and switched to bounded multi-phase navigate wait (15s, polling).
3. Added explicit navigate-state classifier (`login_required`, `checkpoint_required`, `blocked_by_modal`) for early, specific failures.
4. Added navigate diagnostics artifacts on navigate failure:
   - `navigate-probe.json`
   - `navigate-failure.png`
   - `dom.html`
5. Added high-signal terminal/pretty log line:
   - `[LI][SMOKE][req=...][navigate] url=... title=... ready=false counts={...} reason=...`
6. Added fixture/tests for thread-route shell readiness and navigate-state classification paths.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `apps/runner/src/index.ts`
3. `apps/runner/src/services/linkedin-smoke-direct.ts`
4. `tests/fixtures/linkedin/smoke-thread-shell.html`
5. `tests/runner-linkedin-smoke-parsing.test.mjs`

### BUG-020: LinkedIn smoke false modal block + spacer-row unread discovery failures
- Symptom:
1. Smoke runs failed with `blocked_by_modal` while screenshot showed normal messaging UI (Unread active, rows visible, center “No messages...yet!” state).
2. Runs also misclassified unread rows as absent when list contained spacer `<li>` entries and rows hydrated with variant markup.
- Repro steps:
1. Open LinkedIn messaging unread view where URL can be `/messaging/thread/...`.
2. Run `npm run linkedin:smoke`.
3. Observe occasional `blocked_by_modal` false positives and/or selector-mismatch due to zero detected rows despite visible list rows.
- Root cause:
1. Modal detection used DOM-presence style checks that could match non-blocking scaffolding.
2. Shell readiness was coupled to row signals.
3. Row discovery relied on brittle selectors rather than direct-list structure and real row filtering.
- Fix:
1. Changed modal classification to visible overlay/dialog detection only (`isVisible` + bounding box threshold).
2. Refactored shell readiness to shell-level UI (search input + list container + filter pills), independent of row hydration.
3. Added bounded `waitForLinkedInShellReady` and `waitUnreadRowsOrEmptyState` helpers.
4. Added `getConversationRowCandidates` using direct `:scope > li` evaluation, spacer skipping, and required participant+link structure.
5. Enforced unread behavior rule: in Unread view, all discovered rows are candidates; unread badge is optional metadata.
6. Added stronger mismatch diagnostics and compact list probe content (direct li counts + first 8 li outerHTML).
7. Added milestone logs (`navigate`, `unread`, `rows`, `candidates`) to terminal/pretty log.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `tests/fixtures/linkedin/smoke-thread-shell.html`
3. `tests/runner-linkedin-smoke-parsing.test.mjs`

### BUG-021: LinkedIn duplicate threads, absurd recency, sponsored pollution, and missed read-but-unreplied items
- Symptom:
1. Inbox/People showed duplicate rows for the same LinkedIn conversation/person.
2. Recency rendered absurd values (for example `9000+d ago`).
3. Sponsored conversation rows were ingested into the inbox.
4. Read-but-not-replied threads (no unread badge) were missed.
- Root cause:
1. Ingestion persisted unstable fallback identities when canonical thread IDs were missing.
2. Candidate timestamps used ambiguous short date parsing and invalid values leaked into UI formatting.
3. Full scan candidate selection over-relied on unread badge signal and unread filter assumptions.
4. API shaping did not quarantine unresolved zero-message placeholders.
- Fix:
1. Added canonical LinkedIn identity helpers and temporary in-memory candidate IDs; persistence now skips unresolved canonical IDs after open.
2. Added sponsored-row skip at list parsing and smoke discovery paths.
3. Added preview-signal capture (`You:` detection) and inclusion rule `(unread > 0) OR (needsReplyFromPreview)`.
4. Refactored persistence order to parse/open first, resolve canonical ID, then upsert by `{platform, platformThreadId}` only.
5. Added deterministic LinkedIn list timestamp parser and safer message timestamp normalization.
6. Added thread-row shaping service for API dedupe, unresolved warning tagging, and unresolved zero-message exclusion.
7. Updated dashboard time guards to reject invalid/out-of-range timestamps and show `-`.
8. Added conservative LinkedIn repair CLI with dry-run default and explicit opt-in destructive cleanup flag.
- Files changed:
1. `apps/runner/src/linkedin/linkedinIdentity.ts`
2. `apps/runner/src/linkedin/linkedinTime.ts`
3. `apps/runner/src/linkedin/linkedinRowSignals.ts`
4. `apps/runner/src/platforms/linkedin-adapter.ts`
5. `apps/runner/src/services/scan-queue.ts`
6. `apps/runner/src/services/thread-row-shaping.ts`
7. `apps/runner/src/scripts/repair-linkedin-threads.ts`
8. `apps/runner/src/index.ts`
9. `apps/dashboard/lib/time.ts`
10. `apps/dashboard/lib/types.ts`
11. `apps/dashboard/app/inbox/page.tsx`
12. `apps/dashboard/app/people/page.tsx`
13. `packages/core/src/types.ts`
14. `apps/runner/package.json`
15. `package.json`
16. `tests/runner-linkedin-time-parser.test.mjs`
17. `tests/runner-linkedin-collect-threads-no-name-error.test.mjs`
18. `tests/runner-inbox-row-shaping.test.mjs`
19. `tests/runner-repair-linkedin-threads.test.mjs`
20. `tests/fixtures/linkedin/unread-rerender-scroll.html`
21. `README.md`
- Repair script:
1. Dry-run (default, non-destructive): `npm run repair:linkedin-threads`
2. Apply conservative merge/recompute: `npm run repair:linkedin-threads -- --apply`
3. Optional destructive unresolved cleanup (explicit opt-in only): `npm run repair:linkedin-threads -- --apply --delete-zero-message-unresolved`

### BUG-022: LinkedIn virtualized scan reload loop, residual inbox duplication, unsafe reset path, and artifact churn
- Symptom:
1. LinkedIn full scans slowed dramatically near end-of-list and emitted repeated `THREAD_SYNC_FAIL` with recovery churn.
2. Inbox/People still showed repeated rows for the same thread entity under some polluted states.
3. Reset tooling exposed an unsafe unguarded DB-clear endpoint.
4. Runtime artifacts (`logs/runs`, scan pointers, traces/reports) polluted git status.
- Root cause:
1. Scan queue still used pre-collect candidate lists and stale row open assumptions that break on LinkedIn virtualized DOM rows.
2. Row shaping did identity-level collapse before enforcing thread-entity uniqueness.
3. Dashboard "Clear DB" path called unguarded destructive route.
4. Runtime artifact outputs were partially tracked and not consistently ignored/pruned.
- Fix:
1. Integrated LinkedIn queue path with streaming virtualized scan callback (`scanInboxThreadsStream`) and pre-parsed message handoff to centralized `syncThread`.
2. Added first-pass `thread.id` dedupe in row shaping while preserving unresolved warning/quarantine behavior.
3. Added dev-only token+confirm guarded `POST /admin/reset` with shared reset service, platform-scoped LinkedIn graph delete, orphan-person cleanup, and endpoint deprecation for unguarded clear-db.
4. Added dashboard settings reset modal requiring typed `RESET` + token each run.
5. Added reset CLI (`db:reset:linkedin`), `dev:fast`, and artifact cleanup script (`cleanup:artifacts`, dry-run by default, `--apply` opt-in).
6. Expanded `.gitignore` for runtime artifacts and added streaming scan regression coverage for no reload/goto churn.
- Files changed:
1. `apps/runner/src/platforms/linkedin-adapter.ts`
2. `apps/runner/src/services/scan-queue.ts`
3. `apps/runner/src/services/thread-row-shaping.ts`
4. `apps/runner/src/services/admin-reset.ts`
5. `apps/runner/src/index.ts`
6. `apps/runner/src/scripts/reset-linkedin-inbox.ts`
7. `apps/runner/src/scripts/cleanup-artifacts.ts`
8. `apps/dashboard/app/settings/page.tsx`
9. `apps/dashboard/lib/api.ts`
10. `.gitignore`
11. `apps/runner/package.json`
12. `package.json`
13. `tests/fixtures/linkedin/streaming-virtualized.html`
14. `tests/runner-linkedin-streaming-scan.test.mjs`
15. `tests/runner-inbox-row-shaping.test.mjs`
16. `tests/runner-admin-reset.test.mjs`
17. `tests/runner-cleanup-artifacts.test.mjs`
18. `README.md`
- Reset and cleanup commands:
1. `npm run db:reset:linkedin` (requires `ADMIN_RESET_TOKEN`, confirm enforced by script/service).
2. `npm run cleanup:artifacts` (dry-run).
3. `npm run cleanup:artifacts -- --apply` (explicit prune apply).

## Final Changed Files by Bug ID

- BUG-001: `apps/runner/src/platforms/utils.ts`, `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/index.ts`
- BUG-002: `apps/runner/src/platforms/linkedin-adapter.ts`, `tests/runner-linkedin-scroll.test.mjs`
- BUG-003: `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/platforms/linkedin-adapter.ts`, `tests/fixtures/linkedin/thread-list-snapshots.json`, `tests/runner-linkedin-preview.test.mjs`
- BUG-004: `apps/runner/src/services/session-manager.ts`, `apps/runner/src/services/platform-factory.ts`, `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/platforms/beta-adapter.ts`, `apps/runner/src/index.ts`, `apps/dashboard/app/platforms/page.tsx`
- BUG-005: `apps/runner/src/services/keyed-mutex.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/index.ts`, `tests/runner-keyed-mutex.test.mjs`
- BUG-006: `apps/runner/src/platforms/beta-adapter.ts`, `apps/runner/src/services/selector-tests.ts`, `apps/runner/src/index.ts`, `apps/runner/src/platforms/utils.ts`
- BUG-007: `apps/runner/src/index.ts`, `apps/runner/src/services/scan-queue.ts`
- BUG-008: `packages/core/prisma/schema.prisma`, `packages/core/src/types.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/index.ts`, `apps/dashboard/lib/types.ts`, `apps/dashboard/app/thread/[id]/page.tsx`
- BUG-009: `apps/runner/src/index.ts`
- BUG-010: `apps/runner/src/services/selector-tests.ts`, `apps/runner/src/index.ts`, `tests/runner-selector-evaluate-safety.test.mjs`, `tests/runner-selector-contract.test.mjs`, `tests/runner-selector-service.test.mjs`
- BUG-011: `apps/runner/src/platforms/linkedin-adapter.ts`, `tests/runner-linkedin-unread-pill.test.mjs`, `tests/fixtures/linkedin/unread-pill.html`
- BUG-012: `apps/runner/src/services/session-manager.ts`, `tests/runner-session-manager.test.mjs`
- BUG-013: `apps/dashboard/lib/api.ts`, `apps/dashboard/lib/types.ts`, `apps/dashboard/app/platforms/page.tsx`
- BUG-014: `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/index.ts`, `tests/fixtures/linkedin/unread-rerender-scroll.html`, `tests/runner-linkedin-scan-resilience.test.mjs`, `apps/dashboard/app/platforms/page.tsx`, `apps/dashboard/components/common/degraded-banner.tsx`, `apps/dashboard/lib/types.ts`
- BUG-015: `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/services/scan-queue.ts`, `tests/runner-linkedin-scan-resilience.test.mjs`, `tests/runner-linkedin-scroll.test.mjs`, `tests/fixtures/linkedin/message-events.html`, `tests/runner-linkedin-message-iterator.test.mjs`
- BUG-016: `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/services/scan-retry-controller.ts`, `apps/runner/src/services/session-manager.ts`, `apps/runner/src/index.ts`, `apps/dashboard/lib/types.ts`, `apps/dashboard/app/platforms/page.tsx`, `tests/runner-linkedin-scroll.test.mjs`, `tests/runner-linkedin-collect-threads-no-name-error.test.mjs`, `tests/runner-linkedin-deep-scroll-terminates.test.mjs`, `tests/runner-linkedin-no-string-evaluate.test.mjs`, `tests/runner-scan-retry-circuit-breaker.test.mjs`, `tests/runner-page-closed-mid-stage-reason.test.mjs`
- BUG-017: `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/services/run-logger.ts`, `apps/runner/src/services/linkedin-smoke-logger.ts`, `apps/runner/src/index.ts`, `apps/runner/src/cli.ts`, `apps/runner/package.json`, `package.json`, `.env.example`, `tests/fixtures/linkedin/smoke-unread.html`, `tests/runner-linkedin-smoke-parsing.test.mjs`, `README.md`
- BUG-018: `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/index.ts`, `apps/runner/src/services/linkedin-smoke-direct.ts`, `tests/fixtures/linkedin/smoke-unread.html`, `tests/runner-linkedin-smoke-parsing.test.mjs`, `README.md`
- BUG-019: `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/index.ts`, `apps/runner/src/services/linkedin-smoke-direct.ts`, `tests/fixtures/linkedin/smoke-thread-shell.html`, `tests/runner-linkedin-smoke-parsing.test.mjs`
- BUG-020: `apps/runner/src/platforms/linkedin-adapter.ts`, `tests/fixtures/linkedin/smoke-thread-shell.html`, `tests/runner-linkedin-smoke-parsing.test.mjs`
- BUG-021: `apps/runner/src/linkedin/linkedinIdentity.ts`, `apps/runner/src/linkedin/linkedinTime.ts`, `apps/runner/src/linkedin/linkedinRowSignals.ts`, `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/services/thread-row-shaping.ts`, `apps/runner/src/scripts/repair-linkedin-threads.ts`, `apps/runner/src/index.ts`, `apps/dashboard/lib/time.ts`, `apps/dashboard/lib/types.ts`, `apps/dashboard/app/inbox/page.tsx`, `apps/dashboard/app/people/page.tsx`, `packages/core/src/types.ts`, `apps/runner/package.json`, `package.json`, `tests/fixtures/linkedin/unread-rerender-scroll.html`, `tests/runner-linkedin-collect-threads-no-name-error.test.mjs`, `tests/runner-linkedin-time-parser.test.mjs`, `tests/runner-inbox-row-shaping.test.mjs`, `tests/runner-repair-linkedin-threads.test.mjs`, `README.md`
- BUG-022: `apps/runner/src/platforms/linkedin-adapter.ts`, `apps/runner/src/services/scan-queue.ts`, `apps/runner/src/services/thread-row-shaping.ts`, `apps/runner/src/services/admin-reset.ts`, `apps/runner/src/index.ts`, `apps/runner/src/scripts/reset-linkedin-inbox.ts`, `apps/runner/src/scripts/cleanup-artifacts.ts`, `apps/dashboard/app/settings/page.tsx`, `apps/dashboard/lib/api.ts`, `.gitignore`, `apps/runner/package.json`, `package.json`, `tests/fixtures/linkedin/streaming-virtualized.html`, `tests/runner-linkedin-streaming-scan.test.mjs`, `tests/runner-inbox-row-shaping.test.mjs`, `tests/runner-admin-reset.test.mjs`, `tests/runner-cleanup-artifacts.test.mjs`, `README.md`

---

# Audit Pass 2 — Pilot Hardening (2026-05-28)

A full-codebase correctness audit of the `v1/strip-back-pr1` baseline (6 parallel
agents across LinkedIn scraper, runner API/session, scan orchestration,
AI/transcription, dashboard, and core/iMessage/beta). Findings are correctness
bugs only (wrong behaviour / incorrect data flow), not style. Shipped as a stack
of subsystem PRs so the high-risk LinkedIn scraper work is reviewable in
isolation. Status legend: **Fixed** (landed) · **Confirmed** (real, scheduled in a
later PR in the stack) · **Deferred** (low-confidence / out of correctness scope,
documented here instead of changed).

## PR1 — Safe pilot hardening (Fixed)

- **RT-3** `apps/runner/src/config.ts` — `port: Number(env.RUNNER_PORT ?? 4001)` binds port `0`/`NaN` on an empty or garbage value (`Number("") === 0`). Now uses `parseIntOrDefault`. Same file: `IMESSAGE_ENABLED` (RT-7) only accepted the exact string `"true"`; now normalised (`.trim().toLowerCase()`).
- **RT-4** `apps/runner/src/services/send.ts`, `apps/runner/src/index.ts` — scheduled replies dropped `replyToMessageId` (only immediate sends forwarded it), so a promoted scheduled reply went out un-threaded. `enqueueScheduledSend` now persists it.
- **RT-6** `apps/runner/src/index.ts` — `GET /data/logs?limit=` (empty) returned 0 rows (`Number("") === 0`, not NaN) and a negative limit reversed order. Now validated to a positive bounded integer.
- **AI-1** `apps/runner/src/services/ai.ts` — composeInVoice late-reply hint hardcoded "his register"; now "their register" (de-personalisation + no-gendered-pronoun rules).
- **AI-2** `apps/runner/src/services/ai.ts` — snooze-suggestion prompt advertised `hours: 1-168` but the zod validator caps 72, so one out-of-range value threw out the whole batch. Template corrected to `1-72` and parsing made per-item resilient (clamp + keep valid).
- **AI-3** `apps/runner/src/services/ai.ts` — composeInVoice fed the model the raw `[Voice note]` placeholder for the recipient's last message; now uses `renderMessageBody` so the transcript is injected.
- **AI-4** `apps/runner/src/services/transcription/{transcription-service,selection}.ts` — refinement assumed the attempt list was "best/highest-tier last", but it was built from an unordered `findMany`; now sorted by `TIER_RANK`.
- **AI-5** `apps/runner/src/services/ai.ts` — `updateThreadSummary` returned `summary`/`what_they_want`/`open_loops`/`tone_notes` without the dash/coaching-phrase scrub its reply_brief siblings get; now run through `stripBannedPhrases`.
- **AI-6** `apps/runner/src/services/ai.ts` — composeInVoice gated the late hint with a lexicographic string timestamp compare while computing the gap numerically; now numeric on both.
- **SC-2** `apps/runner/src/services/scan-queue.ts` — `consecutiveNoChange` (adaptive scheduled-scan backoff) was bumped for ANY 0-thread scan, so manual refreshes and failed/cooldown-blocked runs inflated the auto-scan interval up to 4x. Now only a clean SCHEDULED scan that found no changes increments it.
- **SC-3** `apps/runner/src/services/scan-queue.ts` — during cooldown the 1s scheduler tick re-enqueued every second (the block never advances the scheduled clock), and each blocked enqueue overwrote the stored last-run summary. Scheduler now skips cooldown-blocked platforms; the blocked enqueue no longer clobbers `latestRunSummaryByPlatform`.
- **UI-1** `apps/dashboard/app/today/page.tsx` — replying to ANY thread (even one not in Today's queue) incremented and persisted Today's "Tonight's outline" done counters. Now guarded to threads actually present in Today's rows.
- **UI-2** `apps/dashboard/app/inbox/page.tsx` — the "Snoozed" tab actually filtered on `scheduledSendAt` (queued outbound sends), not `snoozedUntil`, and truly-snoozed threads are excluded from `/data/inbox` upstream. Renamed the tab to **Scheduled** to match the data. (See follow-up note below.)
- **UI-3** `apps/dashboard/app/today/page.tsx` — a single `MESSAGE_SENT` triggered two refreshes (a direct one and the advanceHero one). Consolidated onto the advanceHero path.
- **UI-4** `apps/dashboard/app/thread/[id]/page.tsx` — image-attachment `createObjectURL` previews leaked on every successful send and on unmount. Now revoked on success and via an unmount cleanup.
- **UI-7** `apps/dashboard/app/thread/[id]/page.tsx` — the debounced draft-coverage effect depended on the whole `thread` object (a fresh reference each poll), re-arming its 1.4s timer continuously. Now depends on `thread.id` + open-loop count.
- **CORE-3** `apps/runner/src/platforms/imessage-db.ts` — the automated-sender filter ran on group chats too and could drop groups with short `chatNNN` identifiers. Now skipped for group-style (43) chats.
- **CORE-4** `apps/runner/src/platforms/imessage-db.ts` — in group chats, two people sending the same tapback kind collapsed into one reaction. Reactor `handle_id` now included in the aggregation key.
- **CORE-5** `apps/runner/src/platforms/imessage-db.ts` — the four "last message" correlated subqueries could resolve to different rows on a `date` tie (preview text from one row, direction from another). Added a `ROWID` tie-break so all four pick the same row.
- **CORE-6** `apps/runner/src/platforms/imessage-db.ts` — the unread-count subquery counted inbound tapbacks/reactions as unread messages. Now excludes the tapback ranges.
- **CORE-7** `apps/runner/src/platforms/imessage-db.ts` — the inbox preview/last-author could be a tapback row ("[reaction or attachment]" with the reactor as author). The last-message subqueries now exclude tapbacks, mirroring the timeline filter.

## PR2 — LinkedIn scraper hardening (Fixed)

- **LI-1** [high] `linkedin-adapter.ts` `collectThreadMessagesWithBackfill` — deep-fetch stamped a message with today's date when its group `<li>` lacked a date heading (later groups in a date run inherit no heading), reintroducing the timestamp drift #431 addressed. Fixed: carry an inherited date heading like `collectVisibleThreadMessages` does.
- **LI-2** [high] `linkedin-adapter.ts` `getActiveThreadDescriptor` — when no row carried the active CSS class it fell back to the FIRST inbox row, attributing the opened thread (and in the deep-fetch path, a canonical thread id) to the wrong person. Fixed: return an empty descriptor (caller degrades to `page.url()`); add aria-current/aria-selected signals.
- **LI-3** [med] `linkedin-adapter.ts` — messages without a stable id got a positional fallback key that shifted across backfill scroll passes, duplicating timeline entries. Fixed: content-fingerprint fallback key.
- **LI-4** [med] `linkedin/linkedinIdentity.ts` — a `urn:li:msg_thread:` id was lowercased when it arrived via query param but not via the path token, so one thread could split into two records. Fixed: route the path token through `extractStableLinkedInUrn` too. Regression test: `tests/runner-linkedin-identity.test.mjs`.
- **LI-6** [low] `linkedin-adapter.ts` — a read row was counted unread=1 when an empty unread-count container was present; multi-digit counts truncated at the comma. Fixed: require non-empty badge text; strip thousands separators.

## PR3 — Send / concurrency hardening (Fixed)

- **RT-1** [high] `apps/runner/src/index.ts` `/retry-send` — re-queued text only, dropping the original send's attachments and `replyToMessageId`. Fixed: parse `attachmentsJson` and forward both (staged files persist after a FAILED send, so the paths are still valid).
- **RT-2** [med] `send.ts` — a send during a scan drove the same managed Playwright page concurrently (the platform lease only counts active holders, it doesn't serialize). Fixed: `processSendRequest` now wraps `adapter.sendMessage` in `withPlatformLock`, the SAME per-platform mutex key (`<personKey>:<platform>`) the scan queue uses, so sends and scans serialize on the shared page.
- **RT-5** [low] `send.ts` `enqueueSend` — an idempotent replay of a SCHEDULED/CANCELLED `clientSendId` was mis-reported as `PENDING`; the SCHEDULED case told the dashboard it was queued though the PENDING worker never drains it. Fixed: PENDING is handled explicitly; SCHEDULED/CANCELLED now throw a conflict error (mirroring `enqueueScheduledSend`).

## PR4 — Beta / hidden correctness (Fixed)

- **CORE-1** [high within beta] `beta-adapter.ts` — IG/TikTok direction was derived from English substrings in hashed classnames, so virtually every inbound message was labelled OUT (wrongly marking threads as "you replied last"). Fixed: check inbound and outbound keyword sets explicitly and default the ambiguous case to IN, the safe error for an unread inbox.
- **CORE-2** [med] `beta-adapter.ts` — multi-line IG/TikTok messages were flattened by `cleanText`. Fixed: use `cleanMessageText` (preserves line breaks), matching the iMessage/LinkedIn paths.
- **CORE-9** [low] `beta-adapter.ts` — the index-based `stableKey` fallback duplicated a thread across scrapes when name+preview+href were all missing. Fixed: key off the row's text instead of its scroll index.
- **CORE-10** [low] `beta-adapter.ts` — TikTok auth detection (`/log in/ && !/messages/`) was inert (the messages surface contains "messages"). Fixed: removed the dead/false-positive-prone check; detection relies on the QR phrases + the `/login` URL match.
- **SC-1** [high] `enrichment-queue.ts` — a job that deferred on a busy enrich-lock still burned a retry attempt (the increment preceded the lock acquire), so lock contention could permanently FAIL a job that never visited a profile. Fixed: attempts is incremented only on the failure path (a real visit), not at the RUNNING step; give-up progression for real failures is unchanged.

## Deferred (documented, not changed this pass)

Low-confidence, dev-only, or out of correctness scope. Reproduction notes kept here per PM guidance.

- **RT-8** [low] `index.ts` — stale-summary self-heal in `/data/thread` is keyed by thread id and can run a resummarize twice if a second request arrives after the 120s timeout rejected but before the underlying work settles. Last-writer-wins; redundant AI spend only.
- **AI-7** [low] `ai.ts` — GLM/Gemini requests still send `response_format` though other GPT-5 knobs are stripped for those providers. Works for the models in use; pin with a test before relying on it.
- **UI-5** [low] `thread/[id]/page.tsx` — `setComposerSource` is called from inside a `setComposer` functional updater (impure under StrictMode). Currently idempotent.
- **UI-6** [low] `thread/[id]/page.tsx` — `timelineRows`/`dateLabelFormatter` memos are computed every render but unused (the JSX uses `dayDividerLabel`). Dead work, not wrong output.
- **UI-8** [low] `thread/[id]/page.tsx` — redundant mount-time write of `dashboard_threads_collapsed`. Resolves correctly given effect ordering; likely a non-issue.
- **SC-4** [low] `scan-queue.ts` `enqueueScan` — a just-started job is reported `status: "queued"` instead of `"running"` because `processNext` flips `processing` synchronously before control returns. Cosmetic.
- **SC-5** [low] `enrichment-queue.ts` — a job enqueued in the narrow window after a drain's final `pickNextJob()` but before `running` resets can wait for the next periodic tick. Re-kick on drain exit if a rerun was requested.
- **SC-6** [med, dev-only] runner `dev-flags.isAutoScanDisabledInDev` defaults auto-scan OFF in dev (`LINKEDIN_DEV_DISABLE_AUTOSCAN` default true) while the front-end `resolveAutoScanDisabled` defaults ON — the two layers disagree. Left unchanged because the runner scheduler and the front-end topbar toggle may be intentionally separate; changing the default risks double-scanning. Needs a product decision on which layer owns auto-scan in dev.
- **SC-7** [low] `scan-queue.ts` — a second message in the same displayed clock-minute with an unchanged unread count can be treated as "unchanged" and skipped (row time is minute-precision, db time second-precision). Edge case.
- **LI-5** [low] `linkedin-adapter.ts` — send-verification can report a false `timestamp_advanced` when the latest bubble's `<time>` is unparseable and falls back to `Date.now()` on both snapshots. Rare.
- **CORE-8** [low] iMessage `AttachmentPlaceholder.type` carries the media `kind` instead of a stable discriminator, diverging from the beta adapter's `type: "attachment"`. Cosmetic/consistency.

## Follow-up notes

- **UI-2 follow-up:** a true snoozed-thread view (`snoozedUntil`) is not currently surfaced. `/data/inbox` excludes snoozed threads upstream, so a dedicated "Snoozed" view would need a new data path. Out of scope for this hardening pass.
