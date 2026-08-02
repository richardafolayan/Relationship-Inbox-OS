# Scheduled audit disposition, 2026-08-01

## Scope and method

This review covers every open GitHub issue whose title began with `[Scheduled Audit]` on 2026-08-01. Each finding was checked against `origin/develop` at `23f01593e921150acf8fe6d362d02b5942daac7d`, including the actual call path and existing tests. A finding was only changed when the current code still exposed the reported failure.

There were 52 open issues representing 46 distinct findings. Six were duplicate reports. The duplicate issue numbers are retained below so none disappear from the audit trail.

## Disposition

| Issue | Current? | Disposition |
| --- | --- | --- |
| #952, #1005 | Yes, duplicate reports | Enforce one draft per thread in the schema, repair existing duplicates before schema sync, and use an atomic upsert. |
| #954, #993 | Yes, related reports | Invalidate and destroy the cached WhatsApp client and ready promise after authentication, initialization, or runtime disconnect failures. |
| #957 | Yes | Remove plain HTTP/LAN phone access, bind the proxy to loopback, require Tailscale HTTPS, rotate the pairing token per launch, consume the pairing link once, and issue a separate secure session cookie. |
| #958 | Yes | Add synchronous in-flight guards for per-message and send-all dictation actions. |
| #960 | Yes | Continue recording ordinary browser errors without turning every error or rejected promise into a persistent global warning. |
| #961 | Yes | Serialize favourite writes per person and roll back to the last server-confirmed value. |
| #962 | Yes | Keep native update intent until a terminal outcome and retry transient updater failures. |
| #963, #1002 | Yes, duplicate reports | Replace fixed LinkedIn fallback scroll sleeps with bounded adaptive polling over bottom row, visible-set hash, and row count. |
| #964, #984 | Yes, duplicate reports | Restore both host and React quiet-hours state when persistence fails. |
| #965 | Yes | Await Today snooze/handled mutations before advancing, block rapid re-entry, and expose running/success state inline. |
| #966 | Yes | Refresh mobile search results while visible, respond to runner resync, and surface refresh failures. |
| #967 | Yes | Let Cmd/Ctrl+A keep its native text-selection behavior inside editable controls. |
| #968 | Yes | A manual calendar refresh now waits for an in-flight fetch, clears any cache filled by it, and performs a fresh fetch. |
| #969, #990, #999 | Yes, duplicate reports | Do not close or mark setup complete until every required runner save succeeds; flush pending voice-profile edits first. |
| #970 | Yes | Treat a missing enrichment person (`P2025`) as a terminal orphan rather than rescheduling forever. |
| #971 | Yes | Track macOS Contacts as birthday provenance and clear a removed birthday only when the source is proven. Legacy values without provenance are treated as externally sourced and remain protected by explicit product decision. |
| #972 | Yes | Persist the delivered receipt as `SENT` immediately after platform delivery; later local persistence failures cannot expose a retryable failure. |
| #973 | Yes | Validate that reply metadata names a message in the same thread, and repair invalid legacy links before schema sync. |
| #974 | Yes | Add a marked dashboard health endpoint and require the application/service marker in desktop readiness checks. |
| #975 | Yes | Detect SSE cursors ahead of the new runner's event range and emit `RESYNC_REQUIRED`. |
| #976 | Yes | Format a scheduled send as relative only when it is genuinely in the future and within seven days. |
| #977 | Yes | On a unique-key scheduling race, re-read and return the winning row's actual scheduled time. |
| #978 | Yes | Separate toast activation and dismiss controls so interactive elements are no longer nested. |
| #979 | Yes | Run the complete per-platform reset graph inside one database transaction. |
| #980 | Yes | Pre-draft the first three rows from the same sorted Today queue the operator sees. |
| #981 | Yes | Purge in-memory and persisted API snapshots after destructive resets/disconnects. |
| #982 | Yes | Clear a reconnect page error after the next successful refresh. |
| #983 | Yes | Retain dictation audio for retryable 4xx transport/rate-limit statuses while treating known permanent reasons as final. |
| #985 | Yes | On Windows, terminate each complete process tree gracefully, then force the tree if it remains alive. |
| #986 | Yes | Track the pending note independently of the selected person, serialize flushes, flush before navigation, and use a keepalive write on page exit. |
| #988 | Yes | Run update polling only in visible tabs and coordinate it with a cross-tab browser lease. |
| #989 | Yes | Remove validated staged-attachment directories after success, terminal failure, cancellation, replay, and enqueue/schedule rejection. |
| #991 | Yes | Guard pre-draft persistence with the thread version captured before generation and emit updates only when that guarded write wins. |
| #992 | Yes | Attribute send enqueue/schedule audit failures to the target thread's real platform. |
| #994 | Yes | Serialize open-loop read/modify/write operations by thread. |
| #995 | Yes | Guard summary persistence with the captured thread version and return the newer stored result when the generated summary loses the race. |
| #996 | Yes | Include the Message id in audio fingerprints so identical platform keys in different threads cannot collide. |
| #997 | Yes | Preserve explicit international country codes and stop matching unrelated numbers by their trailing ten digits. |
| #998 | Yes | Restore a saved desktop window only when it still overlaps a live display, clamp it to that work area, otherwise center it on the primary display. |
| #1000 | Yes | Await scan actions in mobile search, keep the screen open, and show inline running/success/error state. |
| #1001 | Yes | Coordinate automatic scans across tabs with a browser lease and skip hidden tabs. |
| #1003 | Yes | Require the marked dashboard health endpoint before macOS launchers reuse port 3100. |
| #1004 | Yes | Reserve LinkedIn enrichment visits transactionally in a durable rolling-24-hour Setting, so a restart cannot reset the cap. |
| #1006 | Yes | Before deleting retracted outbound duplicates, repoint replies to an exact surviving duplicate or clear the link transactionally. |
| #1007 | Yes | Count every attachment in durable WhatsApp history, reserve the entire outgoing batch, and include concurrent in-flight reservations in the cap check. |
| #1008 | Yes | Give the command palette a combobox/listbox/option relationship, active-descendant state, and focus restoration. |

## Verification

- Core, runner, and dashboard production builds.
- The full repository run passed 2,748 of 2,750 tests. The two browser-heavy fixtures that timed out under concurrent local resource pressure passed in focused runs after stabilization. Focused regressions also cover database preflight repair, birthday removal, window restoration, send delivery persistence, schedule races, WhatsApp media caps, and audio fingerprint scope.
- Browser verification of changed interactive surfaces at desktop and phone widths.

The exact command results and GitHub Actions result are recorded in the pull request.
