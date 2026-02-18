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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/utils.ts`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`
3. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`
4. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/tests/runner-linkedin-scroll.test.mjs`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`
3. `/Users/richard/IdeaProjects/relationship-inbox-os/tests/fixtures/linkedin/thread-list-snapshots.json`
4. `/Users/richard/IdeaProjects/relationship-inbox-os/tests/runner-linkedin-preview.test.mjs`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/session-manager.ts`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/platform-factory.ts`
3. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`
4. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/beta-adapter.ts`
5. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`
6. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard/app/platforms/page.tsx`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/keyed-mutex.ts`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`
3. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`
4. `/Users/richard/IdeaProjects/relationship-inbox-os/tests/runner-keyed-mutex.test.mjs`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/beta-adapter.ts`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/selector-tests.ts`
3. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`
4. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/utils.ts`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/packages/core/prisma/schema.prisma`
2. `/Users/richard/IdeaProjects/relationship-inbox-os/packages/core/src/types.ts`
3. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`
4. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`
5. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard/lib/types.ts`
6. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard/app/thread/[id]/page.tsx`

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
1. `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`

## Final Changed Files by Bug ID

- BUG-001: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/utils.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`
- BUG-002: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/tests/runner-linkedin-scroll.test.mjs`
- BUG-003: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/tests/fixtures/linkedin/thread-list-snapshots.json`, `/Users/richard/IdeaProjects/relationship-inbox-os/tests/runner-linkedin-preview.test.mjs`
- BUG-004: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/session-manager.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/platform-factory.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/linkedin-adapter.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/beta-adapter.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard/app/platforms/page.tsx`
- BUG-005: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/keyed-mutex.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/tests/runner-keyed-mutex.test.mjs`
- BUG-006: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/beta-adapter.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/selector-tests.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/platforms/utils.ts`
- BUG-007: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`
- BUG-008: `/Users/richard/IdeaProjects/relationship-inbox-os/packages/core/prisma/schema.prisma`, `/Users/richard/IdeaProjects/relationship-inbox-os/packages/core/src/types.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/services/scan-queue.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard/lib/types.ts`, `/Users/richard/IdeaProjects/relationship-inbox-os/apps/dashboard/app/thread/[id]/page.tsx`
- BUG-009: `/Users/richard/IdeaProjects/relationship-inbox-os/apps/runner/src/index.ts`
