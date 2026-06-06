# v1 Bug Sweep — Findings Log (2026-06-05/06)

Dynamic-workflow (Ultracode) bug sweep over all 206 source files on `v1/strip-back-pr1`.
Pipeline: fan-out readers → adversarial refute-by-default verification → fix-design → adversarial review → apply → test → PR → squash-merge.

## Summary

- **42 raw findings** → after adversarial verification: **7 High + 19 Medium confirmed** (4 Medium-tier refuted), 12 Low logged.
- **Fixed, tested, and merged to v1:** all 7 Highs, both Mediums re-rated High (M15, M19), 11 Mediums, and a 4-fix low-risk hardening batch — each with a regression test. Full suite green.
- **Deferred (concurrent-session contention on the shared working tree):**
  - **M2** (`scan-queue.ts`, Low) — cross-sibling outbound dedup drops `sentVia=automation`/`replyToMessageId`. Fix designed + tested, not merged because another session held uncommitted edits to `scan-queue.ts` and the file could not be staged cleanly.
  - **M18** (`repair-linkedin-synthetic-timestamps.ts`, Medium) — synthetic-cluster anchoring. A concurrent session was already implementing the same fix (present uncommitted in the working tree), so it was not double-applied.

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

