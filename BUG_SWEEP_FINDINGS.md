# v1 Bug Sweep — Findings Log (2026-06-05/06)

Dynamic-workflow (Ultracode) bug sweep over all 206 source files on `v1/strip-back-pr1`.
Pipeline: fan-out readers → adversarial refute-by-default verification → fix-design → adversarial review → apply → test → PR → squash-merge.

## Summary

- **42 raw findings** → after adversarial verification: **7 High + 19 Medium confirmed** (4 Medium-tier refuted), 12 Low logged.
- **Fixed, tested, and merged to v1:** all 7 Highs, both Mediums re-rated High (M15, M19), 11 Mediums, a 4-fix low-risk hardening batch, plus **M2** (#548) and **M18** (#546) — each with a regression test. Full suite green.
- **M2** (`scan-queue.ts`, Low — preserve `sentVia=automation`/`replyToMessageId` when collapsing outbound twins) and **M18** (`repair-linkedin-synthetic-timestamps.ts`, Medium — only anchor the genuinely-last synthetic cluster to `lastMessageAt`) were initially deferred because a concurrent session held uncommitted edits to those exact files in the shared working tree; they were subsequently implemented + tested in an isolated git worktree (off clean v1) and merged, without disturbing that session's uncommitted work.

## Refuted Medium findings (verified NOT real — no issue filed)

- M8 imessage-db immutable=1 (readonly sufficient in practice)
- M9 send.ts enqueueSend PENDING race (P2002 fallback only on genuine duplicate)
- M11 send.ts outbound upsert overwrite (collision not reachable)
- M13 repair-linkedin-threads needsReply (recompute already respects archived/snoozed)

## Low-severity findings (logged only — not individually filed, per review policy)

These are real but low-impact. Listed for future attention; none filed as issues.

### L1. composerSource not reset after send/schedule leaves the AI-predraft badge over an empty composer
- **File:** `apps/dashboard/app/thread/[id]/page.tsx:1070`
- **Category:** Incorrect UI state
- **Detail:** onSend (line 1070) and scheduleSend (line 1325) both clear the composer text via setComposer("") but never reset composerSource. composerSource only resets to "empty" on a threadId change (line 886), on Discard (line 3595), and on Delete-draft (line 2703). When the operator sends or schedules an AI predraft (composerSource === "predraft") while staying on the same thread, the textarea becomes empty but composerSource stays "predraft". The render then shows the accent border + soft ring (line 3554) and the "AI predraft · review before sending" badge with the Discard button (line 3578) framing a now-empty input until the operator types (which flips source to "user" via the onChange at line 3617) or navigates away.
- **Suggested fix:** In onSend's optimistic-clear block (after setComposer("") at line 1070) and in scheduleSend's success block (after setComposer("") at line 1325), also call setComposerSource("empty").

### L2. Failed send with attachments clobbers newly-staged attachments and leaks their object URLs
- **File:** `apps/dashboard/app/thread/[id]/page.tsx:1118`
- **Category:** Data loss / resource leak (race)
- **Detail:** onSend snapshots attachmentsToSend (line 1067) and clears composerAttachments to [] (line 1071) before awaiting the network call. On failure the catch restores state with setComposerAttachments(attachmentsToSend) (line 1118), unconditionally overwriting whatever is currently in state. If the operator stages new attachments while the send is in flight (addFiles appends to the now-empty list), those new entries are discarded by the restore, and because removeAttachment/onSend never revoke their previewUrl, the createObjectURL handles created in addFiles (line 1132) leak.
- **Suggested fix:** In the catch, merge rather than overwrite (e.g. setComposerAttachments(prev => [...attachmentsToSend, ...prev])) or, before restoring, revoke the previewUrls of any current attachments being dropped. Simplest correct fix: prepend the failed attachments to the current state instead of replacing it.

### L3. enqueueScan always returns status "queued", never "running"
- **File:** `apps/runner/src/services/scan-queue.ts:949`
- **Category:** logic error (incorrect status reporting)
- **Detail:** enqueueScan calls `triggerProcessNext()` at line 944, then at line 949 returns `status: processing ? "queued" : "running"`. `triggerProcessNext()` invokes `void processNext()`, and processNext runs synchronously up to its first await: it checks `if (processing) return`, shifts the job, and sets `processing = true` before `await runJob(next)` (whose first await is inside runJob/ensurePlatformRows). Therefore by the time control returns to line 949, `processing` is already `true`, so the ternary always evaluates to "queued" — even for the very job that has just started running. The "running" branch is effectively dead.
- **Suggested fix:** Capture the running/queued decision BEFORE calling triggerProcessNext (e.g. `const willRunImmediately = !processing;` computed before `queue.push`/`triggerProcessNext`), and return `status: willRunImmediately ? "running" : "queued"`.

### L4. IMessageDb constructor leaks the open SQLite handle when the pragma or smoke-test throws
- **File:** `apps/runner/src/platforms/imessage-db.ts:248`
- **Category:** resource leak
- **Detail:** The constructor opens the database at line 248 (`this.db = new Database(...)`), then runs `pragma('journal_mode = WAL')` (line 249) and a smoke-test `SELECT 1 FROM chat LIMIT 1` (line 251). If either of those throws — e.g. chat.db is locked/SQLITE_BUSY while Messages.app is writing, the file is corrupt, Full Disk Access is partially revoked, or the `chat` table can't be read — the constructor propagates the error with the underlying SQLite connection still open. The only place that closes the handle is the instance method `close()`, but the half-constructed instance is never returned to the caller. In `imessage-adapter.ts` getDb() (lines 83-100) the `new IMessageDb(...)` is wrapped in try/catch that rethrows an AdapterFailure with no reference to close the dangling handle. Because getDb() is re-invoked on every scan poll of the always-on scan loop, each failed open leaks one SQLite connection / file descriptor, accumulating over time.
- **Suggested fix:** Wrap lines 249-251 in a try/catch that calls `this.db.close()` before rethrowing, e.g. `try { this.db.pragma('journal_mode = WAL'); this.db.prepare('SELECT 1 FROM chat LIMIT 1').get(); } catch (e) { try { this.db.close(); } catch {} throw e; }`.

### L5. uploadScreenshotToRepo cannot overwrite an existing path (no sha), so re-attaching the same reportId silently produces no comment
- **File:** `apps/runner/src/services/github-attachments.ts:133`
- **Category:** error-handling
- **Detail:** uploadScreenshotToRepo PUTs to repos/{repo}/contents/{path} without the existing file's `sha` (lines 133-144). GitHub's Contents API rejects a PUT to an already-existing path with HTTP 422 unless `sha` is supplied. attachScreenshotsToIssue derives a deterministic path `pilot-feedback-attachments/<reportId>-<n>.<ext>` (line 205), so a second attach run for the SAME reportId (duplicate Apps Script webhook, or a retry after the first run's comment-post failed) hits the existing files: every PUT returns !res.ok -> null, uploadedUrls stays empty, and the function returns { ok:false, reason:'all screenshot uploads failed' } at line 218 WITHOUT posting any comment — even though the images already exist in the repo. The operator's re-attempt appears to fail with no recovery.
- **Suggested fix:** Before PUT, GET the contents path; if it exists, include its `sha` to update in place (or treat 'already exists' as success and reuse the raw URL). At minimum, when an upload fails with 422-exists, still construct the raw URL and proceed to post the comment.

### L6. findIssueByReportId retry loop aborts on the first network error instead of retrying
- **File:** `apps/runner/src/services/github-attachments.ts:99`
- **Category:** error-handling
- **Detail:** The retry loop (lines 99-115) awaits fetchImpl() with no try/catch around the call. The retry/backoff (lines 112-114) only re-runs when res.ok is false or no item matched — a thrown error from fetchImpl (DNS failure, connection reset, GitHub 5xx that rejects) propagates straight out of findIssueByReportId, so the `attempts` retries are skipped entirely. The whole attach then fails on a single transient blip even though the issue may exist and a retry would have found it.
- **Suggested fix:** Wrap the fetch in try/catch inside the loop; on a thrown error, fall through to the delay+retry the same way a non-ok response does.

### L7. convertOnce has a non-atomic cache write: concurrent conversions of the same uncached source race on the same dst path
- **File:** `apps/runner/src/services/imessage-attachment-server.ts:127`
- **Category:** race condition
- **Detail:** `convertOnce` computes a cache path `dst`, checks `existsSync(dst)`, and if absent runs `sips`/`afconvert` writing directly to `dst`. Two concurrent requests for the same not-yet-cached HEIC/CAF/video both see `existsSync(dst) === false` and both spawn the converter writing to the identical `dst`. While request A is mid-write, request B's later `existsSync(dst)` (line 130) can observe a partially written file and return it, so `pipeFile` streams a truncated/garbled attachment to the dashboard. There is no temp-file + atomic rename and no in-flight lock.
- **Suggested fix:** Convert to a unique temp file (e.g. `${dst}.${pid}.${rand}.tmp`) then `renameSync` to `dst` (atomic on the same filesystem), or serialize conversions per `dst` with an in-process promise map keyed on `dst`.

### L8. resetPlatformInboxGraph reports inaccurate per-table delete counts because the four deleteMany calls race in Promise.all against the thread cascade
- **File:** `apps/runner/src/services/admin-reset.ts:110`
- **Category:** logic-error
- **Detail:** The sendRequest/draft/message/thread deleteMany calls are issued together inside a single Promise.all (lines 110-137). thread.deleteMany has onDelete: Cascade on Message, Draft and SendRequest (schema.prisma lines 386, 527, 587), and with SQLite foreign_keys enabled the parent thread delete cascades to its children natively. Since the four promises are created together and run over one connection without a defined ordering guarantee relative to the cascade, the message/draft/sendRequest deleteMany can execute after the thread rows (and thus their children) are already gone, returning a count of 0. The returned AdminResetDeleteCounts (lines 165-169) then under-reports how many rows were actually removed.
- **Suggested fix:** Run the child deletes (sendRequest, draft, message) before the thread delete in sequence (await each, or Promise.all only the children, then await thread.deleteMany), so each count reflects rows that existed at the time of its own delete. Alternatively scope the child deletes by the already-collected threadIds and run them strictly before thread.deleteMany.

### L9. tryAcquire has a TOCTOU race: a second concurrent caller queues and blocks instead of getting acquired:false
- **File:** `apps/runner/src/services/keyed-mutex.ts:78`
- **Category:** race condition
- **Detail:** tryAcquire reads `this.states.get(key)?.running` synchronously (line 80) and, when not running, calls `await this.runExclusive(key, work)` (line 83). runExclusive always ENQUEUES. If two callers both pass the `state?.running` check while the lock is free (the key state is absent or running===false at the moment each checks), the first one starts the holder and the second's runExclusive pushes its entry onto the queue and waits behind the first, then returns `{ acquired: true }`. The documented contract is that it 'Resolves with { acquired: false } synchronously when the lock is held'. In enrichment-queue, runOnce() (HTTP-triggered, no drainPass re-entrancy guard) and drainPass() can both call tryAcquire(enrichLockKey, () => visitProfile(...)) concurrently, so the same managed LinkedIn page can end up visited twice in sequence instead of one caller deferring — exactly the collision the lock was added to avoid (see enrichment-queue.ts:314 and :399 comments 'so two drains don't fight' / 'defer if the lock is held').
- **Suggested fix:** Make tryAcquire atomic: set/check a per-key `running` (or a dedicated held flag) synchronously before returning, e.g. inspect state and, if free, mark it acquired in the same synchronous tick before awaiting work — or short-circuit in enqueue with a mode that returns a 'not acquired' sentinel when state.running is already true at enqueue time, rather than re-reading state in tryAcquire and then calling the always-enqueuing runExclusive.

### L10. A single failed appendFile permanently poisons the writeQueue chain, breaking all subsequent log writes in the smoke run
- **File:** `apps/runner/src/services/linkedin-smoke-logger.ts:110`
- **Category:** error handling
- **Detail:** emit() chains writes via `writeQueue = writeQueue.then(() => appendFile(prettyLogPath, ...))` with no `.catch`. If one appendFile rejects (disk full, file removed, permission change mid-run), writeQueue becomes a rejected promise. Every subsequent emit() does `writeQueue.then(...)` (which carries the rejection forward) and then `await writeQueue`, so each later logLine/logStep rejects. Because the smoke endpoint awaits these (index.ts:5486-5505 `await smokeLogger.logLine(...)`), the first transient write failure aborts the remaining logging/steps of the smoke run rather than degrading to best-effort.
- **Suggested fix:** Isolate each write: `writeQueue = writeQueue.then(() => appendFile(...)).catch(() => {})` (swallow/log the write error) so a single failed append does not poison subsequent writes, and don't let a logging failure propagate into the smoke pipeline.

### L11. A throwing onDone shows a success toast then a contradictory error toast
- **File:** `apps/dashboard/lib/feedback.ts:85`
- **Category:** error-handling
- **Detail:** In runActionWithFeedback, the success branch first shows the success toast (line 83), then awaits opts.onDone(value) (line 85) inside the same .then. Because the .catch on line 87 is chained after this .then, any rejection thrown by onDone propagates into the .catch, which then ALSO shows an error toast (reusing the same pendingId, so it overwrites the success toast), sets the failure text via opts.setError, and console.warns. The net effect: a primary action that genuinely SUCCEEDED is reported to the user as a failure. The sibling helper runAction in api.ts (lines 197-214) documents this exact hazard ('a throwing onDone would leak ... and re-trigger the bug') but only protects against the unhandled-rejection; feedback.ts additionally mis-signals success as failure because it has already emitted the success toast before awaiting onDone.
- **Suggested fix:** Move the onDone await out of the toast-success path, or guard it: await opts.onDone in its own try/catch that does NOT re-show an error toast or call setError on the already-succeeded action (mirror the intent of runAction but suppress the duplicate failure UI). For example, run onDone before showing the success toast, or wrap it so a refresh failure logs only and does not flip the toast/error state.

### L12. readThreadSource open-redirect guard misses backslash / encoded-slash prefixes
- **File:** `apps/dashboard/lib/thread-source.ts:68`
- **Category:** security
- **Detail:** readThreadSource() validates a sessionStorage value before it is handed to router.push() at apps/dashboard/app/thread/[id]/page.tsx:2774-2781. The guard rejects empty, non-'/', and '//' (protocol-relative) prefixes and '/thread/'. It does NOT reject a single leading slash followed by a backslash (e.g. '/\\evil.com') or an encoded slash ('/%2Fevil.com'). Browsers normalise backslashes to forward slashes when resolving URLs, so router.push('/\\evil.com') resolves to '//evil.com', a protocol-relative URL that navigates the tab off-origin to evil.com. The module comment explicitly claims this validation 'closes the door on a malicious storage value being used as a router destination', so this is a gap in a security control that advertises completeness.
- **Suggested fix:** After the existing checks, reject any value whose second character is '\\' (and ideally normalise/decode before validation), or better, parse with new URL(stored, location.origin) and confirm the resolved origin equals location.origin before returning; otherwise return FALLBACK. e.g. add `if (/^\/[\\/]/.test(stored)) return FALLBACK;` to cover both '//' and '/\\'.



---

# Pass 2 — Deeper diverse-lens sweep (2026-06-06)

A second pass over current `origin/v1` (incl. the new #550 self-updater) using per-file security/concurrency/data-integrity/crash/logic/resource lenses, excluding everything pass 1 already covered. **45 confirmed new bugs** (13 High, 22 Medium, 10 Low).

## Merged to v1 (fix + regression test each)
- **10 Highs**: LinkedIn voice-guid routing (#559), iMessage timestamp drift (#561), profile-url scheme/host allowlist (#563), send atomic-claim crash-resend (#565), multipart path-traversal (#567), file-stream runner-crash guards (#569), thread-page cross-thread composer leaks (#573).
- **10 Mediums**: mic/spinner (#579), scan-queue metadata+abort (#582), voice-scope/name-label/reassess-canonical (#586), enrichment job lifecycle (#589), thread JSON safe-parse (#593).
- **2 Lows**: import-history db handle + favourite revert guard (#605).

## Open PRs (NOT auto-merged)
- **#574 / #575** — self-updater https-only gate + stop-app-before-DB-copy (for the #550 author / PR 2 of 2).
- **#591 / #595** — enrichment scan-lock serialization + session-manager teardown TOCTOU (concurrency changes, want a human review).

## Deferred to tracked issues
- **#553 / #554 / #555** (High) — self-updater unauth-channel RCE, torn-DB-copy, runner 0.0.0.0 bind.
- **#596 / #597** (Medium) — iMessage canonical-sibling display divergence (delicate #499 area; needs a careful dedicated fix).
- **#598–#602** (Medium) — #550 self-updater version-compare + minimumInstallerVersion enforcement.

## Logged Lows (not individually fixed)

### PL1. Favourite toggle failure path can set a stale favOverride onto the next thread after navigation  _( ✅ FIXED (#605) )_
- **File:** `apps/dashboard/app/thread/[id]/page.tsx:2321`  ·  **Lens:** state-race
- `toggleFavourite` (line 2315) captures `next` from thread A, optimistically sets `favOverride`, and on request failure calls `setFavOverride(!next)` (line 2321) with no check that the user is still on thread A. The threadId-change effect (lines 503-505) resets `favOverride` to null on navigation, but a late `.catch` that fires after navigating to thread B will write A's reverted favourite value into the shared `favOverride` state, which thread B's header star reads via `favOverride ?? thread.personFavourite` (line 2314). The star for B then briefly shows the wrong (A-derived) favourite state until the next refresh reconciles it.
- **Suggested fix:** Capture the thread id at toggle time and gate the `.catch` revert on it still matching the current route thread id (or store the override keyed by thread/person id) so a failed toggle for A cannot repaint B's star.

### PL2. /control/imessage/import-history leaks the chat.db IMessageDb handle on every call  _( ✅ FIXED (#605) )_
- **File:** `apps/runner/src/index.ts:1569`  ·  **Lens:** resource
- The POST /control/imessage/import-history route opens `db = new IMessageDb(runnerConfig.imessage.dbPath)` at index.ts:1569 and uses it via `db.listThreads(5000, ...)` at line 1577, but never calls `db.close()` anywhere in the rest of the handler (lines 1582-1662). There is no try/finally around the opened handle (the try at 1568-1573 only guards construction and re-throws nothing). The handle leaks on every code path: (a) the dryRun early-return at line 1605 returns after only listThreads; (b) the normal path runs the entire `withPlatformControlLock`/ingest loop and returns at 1654 with the handle still open; (c) if any await inside the loop or the lock body rejects, asyncRoute's rejection propagates and the handle is still never closed. Each invocation leaks one better-sqlite3 connection to chat.db plus its WAL read mark. This route is the ONLY one of the several IMessageDb call sites in this file that fails to close: the boot probe (index.ts:6340-6341), the /data/imessage-attachment route (1676/1699 try-finally), the attachment resolver (318/332 try-finally), the adapter (closeSession at imessage-adapter.ts:441), and birthday-sync (88/100 try-finally) all release the handle. Trigger: repeatedly POSTing to /control/imessage/import-history (e.g. a tester re-running history import, or any retry loop) accumulates open SQLite handles/file descriptors against ~/Library/Messages/chat.db until the process hits its fd limit or GC eventually finalizes them non-deterministically.
- **Suggested fix:** Wrap the handle in try/finally: after `db = new IMessageDb(...)` succeeds, put the listThreads call, dryRun branch, and the withPlatformControlLock ingest loop inside a `try { ... } finally { db.close(); }` so every return path (dryRun early-return, normal completion, and thrown errors inside the lock/loop) releases the chat.db connection — mirroring the pattern already used at index.ts:1681-1700 and 322-333.

### PL3. enqueue() coalescing is a check-then-act race: concurrent non-manual enqueues create duplicate PENDING jobs for the same person  _( logged — low impact )_
- **File:** `apps/runner/src/services/enrichment-queue.ts:141`  ·  **Lens:** concurrency
- enqueue() coalesces by doing `await prisma.enrichmentJob.findFirst({ where: { personId, status: { in: [PENDING, RUNNING] } } })` and, if none found, `await prisma.enrichmentJob.create(...)` (lines 142-149). There is no unique constraint on EnrichmentJob.personId (schema.prisma:183-205 has only a non-unique `@@index([personId])`), so this is a pure in-application check-then-act. The two `await`s straddle an event-loop yield point. Two enqueues for the same person that interleave there both observe 'no existing row' and both create a PENDING job. Concretely this is reachable today: the scan path fires `void enrichmentQueue.enqueue(personId, 'first_seen')` fire-and-forget (index.ts:734, via onNewPerson at scan-queue.ts:2782/2797), and the hourly periodicTick (line 453-455) also calls `await enqueue(p.id, 'periodic')` for active stale contacts. A scan discovering/auto-URLing a person while the periodic tick is iterating the same person (or two scans landing the same new person) interleaves at the findFirst/create boundary and yields two PENDING rows. The drain then visits the SAME LinkedIn profile twice, burning two slots of the daily cap (deps.dailyCap) that exists specifically to throttle this highest-fingerprint activity, and the dashboard 'Enriching N profiles' counter (index.ts:1337 counts PENDING jobs) over-reports.
- **Suggested fix:** Make coalescing atomic. Either add a partial/unique constraint so at most one non-DONE/FAILED job per personId can exist and catch the P2002 on create (treating it as 'already queued'), or perform the dedup inside a transaction with `SELECT ... FOR UPDATE`-equivalent semantics. An in-memory `Set<personId>` of in-flight enqueues guarding the await window would also close it for the single-process runner.

### PL4. Reassess classifier is fed the requested sibling's stale summary/whatTheyWant, not the canonical sibling's, for multi-handle iMessage persons  _( ✅ already fixed by PM11 (#586) )_
- **File:** `apps/runner/src/services/reassess-thread.ts:146`  ·  **Lens:** logic
- For an iMessage Person split across handle-specific sibling threads, runReassessForThread correctly (a) classifies over the MERGED sibling messages (orderedMessages, lines 129-135) and (b) targets the CANONICAL sibling for the summary refresh and cache burn (canonicalThreadId, lines 121-128, 140, 161). But the summary/whatTheyWant context lines passed to classifyThreadCategory (lines 146-147) are read from `thread.rollingSummary`/`thread.whatTheyWant`, where `thread` is the REQUESTED row fetched up front (lines 83-93). When Reassess is triggered on a non-canonical (dormant) sibling — e.g. via a notification deep-link that uses the inbound row's own threadId, a bookmarked/old thread URL, or a direct API call — `thread.rollingSummary` is the dormant row's stale summary, which neither the /data/thread reader nor the scan pipeline ever surface (both source AI fields from the canonical sibling via pickCanonicalThread, index.ts lines 3861-3866). classifyThreadCategory injects this stale 'Summary so far:' / 'What they want:' line into its prompt (ai.ts lines 2413-2426), so the classifier is biased by a summary that may not describe the merged live conversation, while every other input (merged messages) and the write target are canonical.
- **Suggested fix:** After resolving canonicalThreadId for the iMessage multi-sibling case, read the summary/whatTheyWant for the classifier from the canonical sibling row rather than the requested `thread`. The siblingRows query already runs (lines 117-120); add rollingSummary/whatTheyWant to its select and feed the canonical row's values (falling back to `thread`'s when single-sibling/non-iMessage) into classifyThreadCategory at lines 146-147.

### PL5. Row can render needsReply=true while riskLevel=GREEN and slaCountdown='No SLA' when lastInboundAt is null  _( logged — low impact )_
- **File:** `apps/runner/src/services/thread-row-shaping.ts:330`  ·  **Lens:** logic
- The row's needsReply field (line 330) comes from deriveNeedsReply(source), which for a row with lastInboundAt===null returns the stored DB column row.needsReply (line 218) — which can be true (e.g. AI summary.needs_reply=true, or a seeded thread). But riskLevel (line 329) and slaCountdown (line 339) come from calculateRisk, which for a null lastInboundAt returns level:'GREEN' and slaDueAt:undefined (risk.ts:20-27). Since needsReply is true, line 339 calls formatSlaCountdown(undefined) which returns 'No SLA' (risk.ts:64-65). Net: a row that is flagged needs-reply but shows GREEN risk and 'No SLA' — a self-contradictory state, and it survives the needsReplyOnly inbox filter (index.ts:3682) while never aging to amber/red.
- **Suggested fix:** Derive needsReply consistently with risk: when lastInboundAt is null, treat needsReply as false (no inbound = nothing owed), or compute needsReply from the same calculateRisk result used for riskLevel so the badge, risk colour and SLA countdown can't contradict each other.

### PL6. A dangling --notes (or --notes-file) flag publishes a latest.json the updater will refuse  _( ↳ deferred to #550 author )_
- **File:** `scripts/build-student-release.mjs:103`  ·  **Lens:** correctness
- parseArgs uses `next = () => argv[++i]` (line 53). A trailing `--notes` with no following value pushes `undefined` into out.notes (line 57). readNotes() then returns args.notes because `args.notes.length` is truthy (line 102), so releaseNotes becomes `[undefined]`, which JSON.stringify writes as `[null]` (verified). validateLatestJson in release-manifest.mjs flags `releaseNotes` whose members aren't strings (`obj.releaseNotes.some((n) => typeof n !== 'string')`), so loadManifest() in update-student.mjs dies with 'latest.json is malformed' for every pilot that fetches the feed. The `--notes-file` path is a milder variant: an empty or all-blank notes file yields `releaseNotes: []` (valid but empty — pilots see no 'what's new').
- **Suggested fix:** After building the notes/args, drop non-string/empty note entries (e.g. `out.notes.push(next())` guarded so undefined isn't pushed, and filter Boolean+typeof string in readNotes). Optionally run validateLatestJson on the manifest object before writing latest.json so the builder fails loudly instead of shipping a manifest the updater rejects.

### PL7. Temp staging directory leaks when the forbidden-file scan triggers die()  _( ↳ deferred to #550 author )_
- **File:** `scripts/build-student-release.mjs:231`  ·  **Lens:** correctness
- build() wraps its work in try/finally where the finally removes the staging dir (line 231 `rmSync(staging, ...)`). But die() (line 84) calls `process.exit(1)`, which terminates the process immediately and skips the finally block. The two in-try die() paths — the staged-tree forbidden scan (line 191) and the in-zip forbidden scan (line 206) — therefore leave the mkdtemp staging directory (line 170, containing a full extracted copy of the tracked source tree) behind in tmpdir on every failed build.
- **Suggested fix:** Don't process.exit from inside the try. Either throw from these checks and let the outer .catch (line 235) report+exit after the finally has run, or explicitly `rmSync(staging, { recursive: true, force: true })` immediately before each die() call in build().

### PL8. minimumInstallerVersion is required+validated in the manifest but never checked before applying, so an outdated updater will apply a build it cannot correctly handle  _( ↳ deferred to #550 author )_
- **File:** `scripts/update-student.mjs:314`  ·  **Lens:** security
- The manifest requires and validates minimumInstallerVersion (release-manifest.mjs lines 31, 97-101) and the updater imports compareVersions (line 44), but applyUpdate (called at 314/316) never compares the installer's own version against manifest.minimumInstallerVersion — compareVersions is imported and never used (confirmed by grep: only isNewer, sha256Buffer, validateLatestJson are referenced). A release that explicitly demands a newer updater (e.g. because the swap/preserve protocol changed) will still be applied by an old updater, which can mis-handle the new layout (wrong PRESERVE set, changed folder name) and, combined with the swap, risk data loss the gate exists to prevent.
- **Suggested fix:** Before applying, compute the running updater's version (from its own package.json/release.json) and refuse with a clear message when compareVersions(installerVersion, manifest.minimumInstallerVersion) < 0, instructing the pilot to update the updater/installer first.

### PL9. Non-numeric/missing --keep-backups value silently disables all backup pruning  _( ↳ deferred to #550 author )_
- **File:** `scripts/update-student.mjs:278`  ·  **Lens:** correctness
- parseArgs does out.keepBackups = Number(next()) (line 64). If --keep-backups is passed without a value or with a non-numeric value (e.g. `--keep-backups all`), Number(...) is NaN. At line 278, Math.max(0, NaN) is NaN, and pruneBackups' loop `while (backups.length > keep)` is `len > NaN`, which is always false, so no old backup is ever removed. Each backup is a full copy of the app directory, so backups then accumulate without bound across every update.
- **Suggested fix:** Validate the parsed number: `const keep = Number.isFinite(args.keepBackups) ? Math.max(0, Math.floor(args.keepBackups)) : 2;` and pass that to pruneBackups; die() on an explicitly malformed --keep-backups value.

### PL10. --dry-run on an up-to-date install prints a contradictory 'would update X → X'  _( ↳ deferred to #550 author )_
- **File:** `scripts/update-student.mjs:315`  ·  **Lens:** correctness
- In main(), `--dry-run` without `--apply` always routes into applyUpdate regardless of whether an update is available (line 315-317: `else if (args.dryRun) await applyUpdate(...)`). applyUpdate's dry-run branch (line 194) unconditionally prints `[dry run] would update <current> → <manifest.version>` and lists download/verify/swap steps. When latest == current (or older), report() has just printed 'You're up to date', and the dry-run then prints 'would update 0.1.0 → 0.1.0' plus a full plan to download and swap, directly contradicting it. Concrete trigger: `node scripts/update-student.mjs --dry-run` against a feed whose version equals the installed version.
- **Suggested fix:** Gate the standalone dry-run on availability too: only call applyUpdate for --dry-run when `report` returned available (or when --apply is also set), otherwise print the same 'nothing to do' message report() already shows.

