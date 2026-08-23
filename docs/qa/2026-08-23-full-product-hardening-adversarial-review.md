# Full product hardening adversarial review

Review date: 2026-08-23

Milestone under review: `qa/full-product-hardening-2026-08-21`

Milestone commit: `be936f81984bf3e8208ba3b2795a1521e2f030e7`

Implementation commit: `6efd6206d76391ed44a744e2c726d9498f71759c`

Original report: `docs/qa/2026-08-21-full-product-hardening.md` on the milestone tag

## Purpose

The milestone report is immutable evidence of what the first audit concluded.
This document is its dated errata layer. It does not rewrite the
milestone, erase the fixes that remain valid, or manufacture a new aggregate
count. It records where the adversarial review disproved a claimed disposition,
found an interaction bug, or established a release gate that the original
report did not cross.

The live release gate and current execution state belong in
`docs/strategy/current-product-direction.md` and
`docs/strategy/current-build-status.md`. If those documents later differ from
this one, their newer live state controls.

The correct integration decision is **NO MERGE**. Treat
`chore/full-product-hardening` as evidence and source material for smaller
corrective branches, not as an integration branch.

## Stop-ship findings

| Area | Original truth | Adversarial truth | Evidence at the milestone commit | Required regression |
| --- | --- | --- | --- | --- |
| Focus auto-ack eligibility | F-057/F-058 FIXED; F-083 FIXED | A scheduled scan can emit `MESSAGES_PERSISTED` while category is still null. Auto-ack accepts that thread and can send before later classification marks it outreach. Reopen the F-057/F-058 safety family; F-083 is only partial. | `apps/runner/src/services/scan-queue.ts:3802-3819,3940-3957`; `apps/runner/src/index.ts:1290-1298`; `apps/runner/src/services/focus-auto-ack.ts:81-90` | Latch classification for a covered null-category thread that resolves to outreach and prove the send queue and adapter remain untouched. |
| Admin reset/send fencing | F-048 MEDIA FIXED, cross-table atomicity OPEN | A worker can claim and load a send, pause before its platform lock, then physically send after reset deletes the request and thread. This is an external-action safety blocker. | `apps/runner/src/services/send.ts:391-451,494-555`; `apps/runner/src/index.ts:1949-1975,3915-3977`; `apps/runner/src/services/admin-reset.ts:257-290` | Latch a claimed worker, complete reset, release the worker, and prove the adapter is never called. Enqueue during reset must block or reject. |
| Scheduled-send reconciliation | F-011/F-025 FIXED | A successful schedule response that arrives after A to B navigation leaves A's captured session intact, so returning to A resurrects already-scheduled text. A same-thread late response can also clear newer text. | `apps/dashboard/app/thread/[id]/page.tsx:669-693,1597-1617,2762-2805` | Defer scheduling, navigate A to B to A, and prove only A's captured version is consumed. Separately edit while pending and prove newer text survives. |
| Clean packaged first launch | Not exercised physically | The exact signed package fails twice when its SQLite path does not yet exist. Pre-creating an empty mode-600 file makes the same package complete `prisma db push` and reach a healthy native window. | `scripts/start-app.mjs:201-214,270-287`; packaged reproduction on 2026-08-21 | Launch the signed app against a completely absent Application Support/data directory and require a healthy runner, dashboard, and native window without manual preparation. |
| Setup persistence ordering | F-038/F-040 FIXED | Setup can advance after a failed fire-and-forget preference write. Rapid AI/source choices can resolve out of order, and the server performs non-serialized read-modify-writes. | `apps/dashboard/components/common/SetupWizard.tsx:159-165,229-257,311-324,368-376`; `apps/runner/src/index.ts:2697-2734` | Mounted deferred and reordered requests must prove failure never advances, errors are visible, and the latest source/AI choice wins in every durable/runtime representation. |
| Existing database Draft invariant | F-024/F-060/F-064 FIXED | Duplicate repair is deterministic, but unattended startup calls `prisma db push` without the acknowledgement Prisma requires when adding a unique constraint. The actual upgrade path can stop before applying the invariant. | `packages/core/prisma/schema.prisma:528-537`; `scripts/lib/repair-schema-data.mjs:16-28`; `scripts/lib/prisma-command.mjs:10-16`; `scripts/start-app.mjs:276-287` | Run the exact launcher command against a legacy SQLite fixture and assert success plus a real unique index. Prefer creating and validating this one index in the guarded repair step over globally accepting future warnings. |

## Reopened or narrowed dispositions

| Finding | Milestone disposition | Corrected disposition | Reason |
| --- | --- | --- | --- |
| F-001 | FIXED | PARTIAL | People passes a name query. Inbox matches name or preview substring, so duplicate names and unrelated mentions are not exact-person navigation. |
| F-008 | FIXED | PARTIAL | Activity can render its error and perpetual loading state together after the initial request fails. |
| F-011 | FIXED | PARTIAL/REOPEN | Per-thread sessions preserve text/source only. Reply parent and attachments are silently discarded, and scheduled completion can resurrect captured text. |
| F-024 | FIXED | PARTIAL | The runtime invariant is sound only after the existing-database upgrade actually applies. |
| F-025 | FIXED | PARTIAL | Payload preservation exists, but completion/session reconciliation can create duplicate intent or erase newer text. |
| F-026 | PARTIAL | PARTIAL, expanded | A receipt-persistence failure after provider success can leave a claim-marked PENDING request hidden from queue selection until restart. |
| F-038 | FIXED | PARTIAL/REOPEN | Setup can still advance after failed preference persistence. |
| F-040 | FIXED | FAILED/REOPEN | Reordered setup writes can let an older response overwrite the user's final choice. |
| F-048 | PARTIAL | OPEN, stop-ship | Reset remains non-atomic and can race a claimed physical send. |
| F-051 | FIXED | PARTIAL | Resync is globally broadcast before the newcomer subscribes, disturbing healthy clients while not targeting the stale client. |
| F-057 | FIXED | PARTIAL/REOPEN | Durable dedupe does not prevent pre-classification auto-ack. |
| F-058 | FIXED | PARTIAL/REOPEN | A definitively failed focus-note attempt suppresses later safe attempts in the same window; pre-classification auto-ack also remains. |
| F-060 | FIXED | FAILED/REOPEN | Exact unattended schema application is not proved and can refuse the unique-index change. |
| F-064 | FIXED | PARTIAL/FAILED UPGRADE PATH | Duplicate repair is deterministic, but the following real schema application can fail. |
| F-076 | FIXED | PARTIAL | Dashboard `fetch(..., { cache: "no-store" })` can translate to request `Cache-Control: no-cache`, which the runner treats as an application-cache bypass. |
| F-077 | FIXED | PARTIAL | Cache primitives pass direct HTTP tests, but the actual dashboard request path may bypass them. |
| F-083 | FIXED | PARTIAL | Early persistence improves visibility, but it creates the unsafe pre-classification auto-ack ordering. A projection failure can also permanently lose the event on retry. |
| F-097 | FIXED | PARTIAL | Only the literal browser group has the intended serial/skip-rejection behavior; workspace group behavior was not exercised by child-process tests. |
| F-098 | FIXED | PARTIAL | The claimed deterministic grouping is not behaviorally established for every workspace entrypoint. |
| F-103 | FIXED | PARTIAL | Workspace scripts route to grouped runners, but their browser inclusion/skip semantics remain insufficiently proved. |

## Additional interaction findings

- A definitively failed focus-note SendRequest is treated as an existing attempt
  forever within the window, even when it is retry-safe. Delivery-uncertain
  outcomes must remain non-automatic.
- A delivery acknowledgement can overwrite a newer stopped or replaced focus
  window because it writes a stale whole-window copy without compare-and-swap.
- If message insertion commits and freshness projection/event emission fails,
  retry sees no new message and may never emit `MESSAGES_PERSISTED`.
- If the adapter succeeds and the first terminal SendRequest update fails, the
  claim-marked PENDING row is excluded from queue selection until restart.
- The shipped production dependency tree contained 23 audit advisories in the
  exact package check. The `onnxruntime-node` to `node-tar` chain is assessed
  separately in `docs/qa/2026-08-23-onnxruntime-node-tar-assessment.md`.

## Findings that remained coherent under review

The adversarial pass found no new defect in canonical replay/P2002 winner
handling, deterministic retry reservation, durable WhatsApp poll payloads,
normal WhatsApp teardown, cleanup path confinement, isolated SQLite backup,
phone-access security defaults, source-aware Back, stale-thread identity,
reviewed-dictation duplicate protection, or the core cache/LRU/single-flight
primitives themselves.

These no-finding areas are not a clean bill of health. They mean the review did
not find a new source-backed defect in the stated path.

## Corrective priority and execution dependency

The safety priority is external-action safety first, then scheduled-send
correctness, clean packaged first launch, complete composer-intent recovery,
setup latest-wins persistence, and the existing-database Draft invariant.

That priority is not permission to create competing shared-path implementations.
Work without meaningful Instagram overlap can proceed independently. The clean
packaged-first-launch correction and Draft upgrade path are examples. Focus,
send, thread, and setup corrections must wait for Instagram's intended shared
path to stabilise or be explicitly based on that post-Instagram integration
state. Once that base exists, implement the conflicting corrections in the
safety order above and adversarially review each branch.

After the corrective branches, reverify every Instagram-shared path and run the
physical iPhone/PWA critical flows. Only after the pilot release gate is clear
should resume-to-trustworthy-fresh-state work begin.

## Pilot release gate

Tovi is not pilot-ready until all of the following are true:

- No known path can unexpectedly send or duplicate a real message.
- A completely clean signed install launches successfully.
- Failed or reordered setup writes cannot create false state.
- Recovered composer state faithfully represents the user's intended send.
- Existing databases upgrade through every new integrity constraint.
- Instagram integration is resolved and the shared paths are reverified.
- Physical iPhone/PWA critical flows have been checked.
