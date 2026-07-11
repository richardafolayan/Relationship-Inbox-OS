# Event-driven message sync audit

Issue: #802

Branch: `perf/event-driven-message-sync`

Base: `fcf51204a5642e5ca123c075e921e33f5e1ae2d1` (`origin/v1/strip-back-pr1`)

## Scope

This work owns receive watchers, scan triggers, persistence-to-UI propagation,
send acknowledgement and reconciliation. It does not include general React
rendering optimisation, which remains in #801.

The currently supported pilot platforms were audited independently. LinkedIn,
iMessage and the opt-in WhatsApp integration are covered below. Instagram and
TikTok remain coming-soon adapters, so no watcher, send path or performance
claim was added for either platform.

## Platform audit

| Stage | LinkedIn | iMessage | WhatsApp |
| --- | --- | --- | --- |
| Receive detection | A `MutationObserver` fingerprints the visible inbox thread rows. The earliest DOM change time is retained. | The Messages database directory is watched through `fs.watch`; change bursts are debounced while retaining the earliest event time. | `whatsapp-web.js` emits an inbound `message` event with its chat JID and event time. |
| Fallback and backoff | A local 15 second fingerprint check detects observer misses without network polling. Binding retries back off when the page is unavailable. The normal adaptive scan remains a safety net. | Watcher reattachment uses exponential backoff capped at 60 seconds. The normal adaptive scan remains a safety net. | Client reconnect handling remains in the existing adapter. The normal adaptive scan remains a safety net. |
| Scan targeting | A change coalesces into a platform scan without forcing inbox navigation. It respects cooldown and an in-flight scan is allowed to cover the signal. | Changes coalesce into an incremental scan using the persisted database watermark. Cooldown and in-flight work are respected. | The changed JID is mapped to a targeted `fetchThreadById` scan. Multiple events for the same thread coalesce. |
| Ordering and deduplication | Existing platform timestamp ordering, stable-key upsert and thread matching remain authoritative. | Existing Apple epoch cursor, stable GUID key and timestamp ordering remain authoritative. | Existing stable message ID key and timestamp ordering remain authoritative. |
| Persistence | The scan queue records source-to-persistence latency only after the transaction has committed message changes. | Same shared scan queue path. | Same shared scan queue path. |
| UI propagation | `MESSAGES_PERSISTED` is emitted immediately after persistence, before downstream AI enrichment. The open thread refreshes immediately and reports visibility after two animation frames. | Same shared propagation path. | Same shared propagation path. |
| Send initiation | User-triggered Playwright send remains unchanged. | User-triggered AppleScript send remains unchanged. | User-triggered adapter send remains unchanged. |
| Platform acknowledgement | A successful click records a visible acknowledgement timestamp, but final success still requires the existing outgoing-bubble verification. | The adapter actively checks `chat.db` for the sent GUID during a bounded five second window. `is_sent` is a platform acknowledgement; delivered state is stronger bubble verification. | The adapter waits up to five seconds for the matching `message_ack` event. Server acknowledgement or better is recorded as `platform_acknowledged`; error acknowledgements fail the send. |
| Reconciliation | The existing ten second outgoing-bubble verification remains the trustworthy result. A missing bubble is a failure, not success. | The bounded active window requires a matching GUID plus sent or delivered state. The existing follow-up scan reconciles the persisted thread. | A timed-out acknowledgement remains explicitly `best_effort`; it is not promoted to verified delivery. Stable message keys allow later scans to reconcile it. |
| Failure handling | Browser/page errors and missing bubbles retain the existing failed-send path. Watcher cleanup removes bindings, timers and observers. | AppleScript errors or absent database acknowledgement fail the send. Watch timers are cancelled on stop. | Error acknowledgements and adapter errors fail the send. Listener and timeout cleanup are guaranteed. |

The shared scheduler is now self-scheduling rather than a fixed one second
interval. It checks frequently while work is active, then backs off to at most
60 seconds while idle. Triggered work is coalesced by target, keeps the earliest
source timestamp and is retried after cooldown or in-flight blocking rather
than silently dropped.

## Measurements

All figures are milliseconds. The controlled results isolate application
latency from external provider and network latency. Quantiles use 25 to 30
samples unless otherwise noted.

### Source change to persisted message

The persistence component used 30 privacy-safe writes against a temporary
SQLite database containing the production schema but no private message rows:
p50 10 ms, p95 92 ms. End-to-end figures below combine that measured component
with the measured trigger component.

| Platform | Baseline p50 | Baseline p95 | Final p50 | Final p95 | Method |
| --- | ---: | ---: | ---: | ---: | --- |
| iMessage | 550.69 | 645.39 | 327.82 | 506.90 | Real filesystem watcher timing plus controlled persistence |
| WhatsApp | 4,016.42 | 4,098.43 | 766.51 | 848.52 | Previous fixed timer versus event-to-targeted-scan timing plus controlled persistence |
| LinkedIn | 629,928 | 765,003 | 813.06 | 895.07 | Previous 8 to 13 minute periodic wait model, 10,000 samples, versus DOM observer and coordinator plus controlled persistence |

The final LinkedIn result applies while an established LinkedIn inbox page is
alive. When it is not alive, the adaptive safety scan remains authoritative.

### Persisted message to visible UI

| Measurement | Baseline p50 | Baseline p95 | Final p50 | Final p95 |
| --- | ---: | ---: | ---: | ---: |
| Persistence event to visible open-thread update | 483.8 | 484.8 | 33.2 | 34.4 |

The baseline combines the previous 450.43 ms refresh debounce with the same
two-frame render harness used for the final result. The final value was measured
in a headless browser with a stubbed data response, DOM update and two animation
frames. Production telemetry measures the same boundary in the actual app.

### Send click measurements

| Measurement | p50 | p95 | Qualification |
| --- | ---: | ---: | --- |
| Send click to visible acknowledgement | 33.4 | 34.4 | Browser-controlled optimistic bubble after two animation frames; this path was already immediate at baseline |
| Send click to trustworthy WhatsApp result | 0.262 | 4.097 | Controlled event acknowledgement overhead using a matching fake `message_ack`; excludes provider and network latency |

No trustworthy live send latency is claimed for LinkedIn or iMessage without a
user-selected recipient. Their production boundaries are instrumented and will
populate from real user-triggered sends.

## Production telemetry

The runner records a content-free rolling window of 500 samples per metric:

- `source_change_to_persisted_message`
- `persisted_message_to_visible_ui`
- `send_click_to_visible_acknowledgement`
- `send_click_to_trustworthy_platform_result`

`GET /data/message-sync-latency` returns count, p50, p95, minimum and maximum.
The dashboard submits only timing and correlation identifiers to
`POST /control/message-sync-latency`; it never submits message content.

## Verification boundaries

### Mac-only verification

- Opened the real `~/Library/Messages/chat.db` read-only and obtained a valid
  incremental watermark.
- Armed the real Messages directory watcher without errors.
- Did not send a real iMessage because no recipient was specified.

### Cloud and external-platform verification

- No cloud-hosted provider session was available in the isolated worktree.
- Existing LinkedIn and WhatsApp profile directories were deliberately not
  opened or copied because doing so could contend with live browser/session
  locks and create platform account risk.
- No real LinkedIn or WhatsApp message was sent because no recipient or test
  conversation was specified.
- Event delivery, acknowledgement, timeout and error paths were verified with
  controlled adapter tests. These are not presented as live provider results.

## Safety invariants

- Scan cooldowns remain enforced; change events do not force browser navigation.
- Trigger coalescing retains the earliest source time and never turns a blocked
  signal into a silently lost signal.
- Stable message keys and existing transactional upsert logic remain the source
  of truth for deduplication and identity.
- A click or local API return is not reported as trustworthy delivery.
- Missing or error acknowledgements remain best-effort or failed states.
- No new platform was enabled and no message content enters performance logs.
