# Main consumer failure inventory

Branch: `fix/main-consumer-error-handling`

Base: `e5eb2639d08f8825ffffb6d78cd6850cc934708e` (`origin/main`)

This inventory covers the significant failures a pilot user can meet in the dashboard, local runner, integrations, and update flow. Normal UI uses the consumer state below. Technical messages, stack traces, response bodies, request IDs, stages, screenshots, and DOM dumps stay in structured logs, audit records, or an explicitly opened diagnostics view.

| Failure | What the user sees | What is logged | Retry safe | Next action | Uncertainty |
| --- | --- | --- | --- | --- | --- |
| Unhandled render exception | A calm page recovery card | `[consumer-failure]` with digest and bounded diagnostic | No, until the page state is checked | Try the page once, then report if it repeats | Recent changes may be uncertain |
| Unhandled browser exception | A persistent recovery card in the app shell | Failure code, phase, flags, and bounded diagnostic | No | Reload, then check the last change | Data may be uncertain |
| Rejected promise | The same persistent recovery card, not a framework overlay | Failure code, phase, flags, and bounded rejection diagnostic | No | Reload, then check the action before repeating it | Data may be uncertain; delivery is flagged separately |
| Framework or root error | A branded reopen view with no stack trace | Digest and diagnostic in the browser log | No | Reopen the app | Recent changes may be uncertain |
| Runner offline | “Relationship Inbox OS is reconnecting” and Start runner | Network failure with path and phase | Yes for starting or reconnecting | Start runner, then reopen the app if needed | No data-loss claim is made; sending is paused |
| Partial startup | “Your conversations are not available yet” | Failed data path plus startup phase | Yes for one retry | Try again, then reopen | Local data availability is uncertain |
| Failed scan | Existing conversations remain visible with an out-of-date warning | Runner audit failure plus client failure code | Yes after reconnecting | Reconnect the account, then Scan now | Inbox freshness is uncertain |
| Definite send failure | “The message was not sent” with account-specific recovery | Full runner send audit, safe failure kind in API and event | Yes only when the stored failure says so | Complete the recovery step, then retry once | Delivery is not uncertain |
| Lost send response | “We could not confirm whether this sent” with no retry action | Network diagnostic and `DELIVERY_UNCERTAIN` | No | Check delivery status and the conversation first | Delivery is uncertain |
| Post-click verification failure | “Delivery could not be confirmed” with Check delivery | Full adapter cause in audit; safe `DELIVERY_UNCERTAIN` in UI | No | Check the conversation before sending again | Delivery is uncertain |
| Runner interrupted during send | The same delivery-uncertain state after restart | Persisted claimed-send diagnostic and failure kind | No | Check the conversation before sending again | Delivery is uncertain |
| AI provider failure | “AI could not help just now” | Provider diagnostic and request path | Yes | Keep writing, or retry AI later | Conversation and draft are unchanged |
| Transcription failure | “That recording was not transcribed” | Provider diagnostic and transcription path | Yes | Retry the retained recording, or type instead | Recording is retained in the current composer session |
| Update check or install failure | “The update did not start” | Update path, status, and bounded diagnostic | Yes | Check again, then reopen if needed | Current version and local data remain in place |
| Missing permission | A permission recovery state with Open Settings | Permission diagnostic and affected path | Yes after access is granted | Grant access, then retry | No false success |
| Missing credentials | “AI is not connected yet” or “This account needs reconnecting” | Credential or authentication diagnostic | Yes after reconnecting | Save a valid key or reconnect | No data or delivery success is claimed |
| Database failure | “Your local inbox data could not be opened” | Full Prisma or SQLite diagnostic in runner logs; safe code in UI | No automatic retry loop | Reopen, then send diagnostics if repeated | Recent writes may be uncertain |
| Malformed response data | “This information could not be opened safely” | Parse phase, path, status, and bounded response diagnostic | Yes once | Reload, then report if repeated | Displayed data may be incomplete |
| Stale route or ID | “This item is no longer here” and Back to Today | 404 path and safe code | No | Open the current item from Today | No data loss implied |
| Integration failure | “This account is not ready” and Open Settings | Full platform audit; safe client failure code | Yes after reconnecting | Reconnect the account | Inbox freshness may be uncertain after failed scans |
| Mutating action loses connection | “We could not confirm that change” | Path, method, phase, and diagnostic | No blind retry | Check whether the change applied first | Data is uncertain |
| Definite validation failure | A calm inline explanation; no stack or JSON | Status and validation diagnostic | Only after correcting input | Correct the input and retry | No change was applied |

## Audited surfaces

- Framework boundaries: root layout, segment errors, global errors, missing routes, unhandled browser events.
- Runner availability: health polling, inbox hydration, local runner start, partial startup.
- Reads and mutations: shared GET/POST/multipart JSON parsing, stale cache revalidation, malformed responses.
- Send lifecycle: enqueue, multipart upload, queue polling, SSE failure, claimed-send interruption, exact delivery status, retry.
- Scan and integrations: scan actions, platform connection, permissions, credentials, degraded account state.
- AI and transcription: compose, ask, reassess, style analysis, dictation retry.
- Updates: update feed, runner availability, staging, restart.
- Local data: Prisma and SQLite failures, missing rows, stale thread and person IDs.

## Representative injection matrix

| Injection | Expected visible result | Automated evidence | Live evidence |
| --- | --- | --- | --- |
| Runner endpoints unavailable | App-shell reconnect card and Start runner | `dashboard-consumer-failure`, API contract tests | Passed in production mode, 2026-07-11 |
| Inbox returns HTTP 200 with HTML | Malformed-data recovery, no HTML or overlay | `dashboard-api-recovery-contract` | Passed in production mode, 2026-07-11 |
| Send POST loses its response | Delivery-uncertain state, retry hidden | API and send delivery tests | Pending |
| Persisted interrupted send | Check-conversation state, retry unsafe | `runner-send-failure-consumer-contract` | Pending |
| Runner returns Prisma stack | Database recovery copy, raw detail only in diagnostics | API recovery contract test | Pending |
| Stale route | Not-found recovery and Back to Today | Dashboard build and route boundary | Passed with a 404 thread response containing a fake Prisma stack, 2026-07-11 |
| Unhandled promise rejection | Persistent recovery card and no raw rejection text | Client failure capture and API contract tests | Passed in production mode, 2026-07-11 |

The production browser checks used request interception only. They did not read or mutate the live database, contact data, platform sessions, or send queue. Screenshots were visually inspected at 1440 by 1000 for calm layout, readable actions, absence of raw technical text, and absence of a framework overlay.
