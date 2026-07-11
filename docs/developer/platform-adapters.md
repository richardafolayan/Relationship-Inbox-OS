# Platform adapters

The canonical adapter interface is
[`PlatformAdapter`](../../packages/core/src/adapters.ts). All adapters must
normalize candidates, messages, attachments, and send receipts before the
scan/send services see them. Optional methods expose only capabilities the
platform can verify.

## Capability matrix

| Capability | LinkedIn | iMessage | Instagram | TikTok | WhatsApp |
| --- | --- | --- | --- | --- | --- |
| Current status | Primary | Primary on macOS | Beta | Beta | Opt-in, off by default |
| Integration | Patchright/Playwright browser | Read `chat.db`, send via AppleScript/Messages | Shared browser beta adapter | Shared browser beta adapter | `whatsapp-web.js` and its Puppeteer |
| Auth | Personal Chrome mirror or isolated profile | Signed-in Messages plus macOS permissions | Isolated/managed browser session | Isolated/managed browser session | LocalAuth and linked-device QR |
| Unread/recent scan | Yes | Yes | Yes | Yes | Yes |
| Change trigger | Scheduled/manual, streaming row ingest within a scan | Filesystem watcher plus database watermark | Scheduled/manual | Scheduled/manual | Incoming library event plus scheduled/manual |
| Text send | Yes, verified bubble | Yes, post-send `chat.db` check | Yes, beta verification | Yes, beta verification | Yes, library best effort plus guard |
| Attachments | No | Yes | No | No | Yes |
| Groups | Limited by platform rows | Group names and senders | Selector-dependent | Selector-dependent | Yes, group JID and sender names |
| Reaction action | Yes | No adapter action | No | No | No |
| Outbound edit | Yes | No | No | No | No |
| Poll send/vote | No | No | No | No | Yes |
| Incremental watermark | No adapter watermark | Yes | No | No | No |
| Retracted outbound sweep | No | Yes | No | No | No |
| Open thread | Controlled browser | Messages app | Controlled browser | Controlled browser | No-op, operations use JID |
| Selector registry | LinkedIn JSON plus overrides | None | Instagram JSON plus overrides | TikTok JSON plus overrides | Stub file is not read |

The UI must check optional methods before exposing reactions, edit, poll, or
profile actions. A schema enum value does not prove a usable adapter.

## Shared contract and factory

[`platform-factory.ts`](../../apps/runner/src/services/platform-factory.ts)
constructs adapters and the shared browser session manager. WhatsApp receives a
real adapter only when `WHATSAPP_ENABLED=true` and Prisma is available;
otherwise a fail-closed stub keeps the runner healthy. The factory currently
constructs iMessage on every host, while `IMESSAGE_ENABLED` gates macOS boot
probing, attachment serving, the watcher, and related services. Normal pilot
configuration enables it only on macOS.

## LinkedIn

Source:
[`linkedin-adapter.ts`](../../apps/runner/src/platforms/linkedin-adapter.ts),
[`linkedin-send-verification.ts`](../../apps/runner/src/platforms/linkedin-send-verification.ts),
and [`session-manager.ts`](../../apps/runner/src/services/session-manager.ts).

### Read path

- Uses a persistent managed browser context.
- Personal mode mirrors the selected Chrome profile and bridges the signed-in
  cookie state; isolated mode keeps an app-owned profile.
- The streaming scan path extracts and de-duplicates rows while walking the
  inbox, opens only candidates selected by update/full rules, and can collect
  pre-parsed messages during hydration.
- Canonical thread identity must resolve after open. Temporary or ambiguous
  IDs fail closed and are not persisted.
- Selector defaults live in
  [`selectors/linkedin.json`](../../packages/core/selectors/linkedin.json);
  persisted operator overrides are read from the `settings` table.

### Send and actions

- Text send verifies the active thread and confirms the new outbound bubble.
- Reactions and outbound message edits are implemented as optional adapter
  capabilities.
- Open thread and open profile reuse the authenticated controlled browser.
- Auto-login credentials exist as an explicit fallback but require
  `LINKEDIN_AUTO_LOGIN`; manual sign-in is the safer default.

### Limits

- LinkedIn UI and account defenses can change without notice.
- Headful offscreen mode is the pilot default. True headless can be enabled in
  Settings but is more fingerprintable.
- Scan caps, stable-row stopping, cooldowns, and enrichment pacing are account
  safety controls, not merely performance settings.

Relevant tests include
[`runner-linkedin-streaming-scan.test.mjs`](../../tests/runner-linkedin-streaming-scan.test.mjs),
[`runner-linkedin-identity.test.mjs`](../../tests/runner-linkedin-identity.test.mjs),
[`runner-linkedin-send-verification.test.mjs`](../../tests/runner-linkedin-send-verification.test.mjs),
and [`runner-linkedin-reliability.test.mjs`](../../tests/runner-linkedin-reliability.test.mjs).

## iMessage and SMS

Source:
[`imessage-adapter.ts`](../../apps/runner/src/platforms/imessage-adapter.ts),
[`imessage-db.ts`](../../apps/runner/src/platforms/imessage-db.ts), and
[`imessage-send.ts`](../../apps/runner/src/platforms/imessage-send.ts).

### Read path

- Opens `~/Library/Messages/chat.db` read-only through `better-sqlite3`.
- Reads unread/recent chats, a generous message window, attachments,
  reactions, native reply metadata, group names, delivery error state, and
  cheap change-watermark values.
- Filters known Messages system events before they affect presentation or AI.
- Resolves raw handles through live macOS Contacts and optional
  `data/contacts.vcf`, preserving manual names.
- The watcher observes `chat.db`, WAL, and SHM changes, debounces them, then
  queues an update scan if iMessage remains enabled in Settings.

### Send path

- Uses AppleScript to ask Messages to send only after an explicit dashboard
  action.
- Text needs Automation permission. File/voice attachment UI scripting also
  needs Accessibility permission for the responsible app or terminal.
- A post-send database check verifies observed delivery state. Later scans can
  remove a row that `chat.db` retroactively marks not delivered.
- App-created reply threading is local presentation metadata. It does not
  create native reply linkage for the recipient.

### Limits

- Requires a logged-in graphical macOS session for sending.
- Full Disk Access has no programmatic prompt; the app can only open the
  relevant System Settings pane and explain the restart.
- One person may have phone and email sibling chats. Persistence keeps both;
  presentation folds them through canonical sibling rules.

Relevant tests include
[`runner-imessage-watcher.test.mjs`](../../tests/runner-imessage-watcher.test.mjs),
[`runner-imessage-scan-watermark.test.mjs`](../../tests/runner-imessage-scan-watermark.test.mjs),
[`runner-imessage-chatdb-open-denied.test.mjs`](../../tests/runner-imessage-chatdb-open-denied.test.mjs),
and [`runner-imessage-receipt-sibling-chat.test.mjs`](../../tests/runner-imessage-receipt-sibling-chat.test.mjs).

## Instagram and TikTok

Both use [`beta-adapter.ts`](../../apps/runner/src/platforms/beta-adapter.ts)
with platform-specific selector JSON.

The shared adapter can connect, find unread/recent conversations, parse
messages, send text after verifying thread context, open a thread, and close
the session. It does not implement attachments, reactions, edits, polls,
incremental watermarks, or platform events.

These adapters are beta because their external DOM contracts shift often.
Selector failure should set the platform degraded and preserve other platform
operation rather than trigger speculative selector changes. Use the selector
test control and audit artifacts before editing selectors.

Relevant tests include
[`runner-selector-service.test.mjs`](../../tests/runner-selector-service.test.mjs),
[`runner-selector-contract.test.mjs`](../../tests/runner-selector-contract.test.mjs),
and [`core-selectors.test.mjs`](../../tests/core-selectors.test.mjs).

## WhatsApp

Source:
[`whatsapp-adapter.ts`](../../apps/runner/src/platforms/whatsapp-adapter.ts) and
[`platforms/whatsapp`](../../apps/runner/src/platforms/whatsapp).

### Connection and read path

- Loads `whatsapp-web.js` lazily only after WhatsApp is enabled and Connect is
  requested.
- Uses LocalAuth in `data/profiles/whatsapp`; the first link and expired links
  use a QR displayed in Settings.
- `whatsapp-web.js` starts its own always-headless Puppeteer/Chromium. The
  dashboard's LinkedIn headless toggle does not control it.
- Library chat/message APIs replace selector scraping. Inbound `message`
  events request a debounced scan; persistence still uses the normal scan
  queue.
- Groups use stable group JIDs and per-message sender names. Media is copied to
  `data/whatsapp-media` for local serving.

### Send path

- Direct sends are checked by the guard for contact safety, minimum interval,
  and rolling daily cap.
- Text, images, videos, GIFs, stickers, documents, audio/voice notes, and polls
  are supported by the current adapter.
- Poll voting is implemented. Vote tallies are not persisted because they
  become stale continuously.
- Send receipts are `best_effort`; they do not claim recipient delivery.

### Limits

- Disabled by default and not part of the required student setup.
- Running it adds a second browser process independent of the shared
  Patchright/Playwright session.
- Library and WhatsApp Web changes can break the integration; do not weaken
  the send guard to work around connection failures.

Relevant tests include
[`runner-whatsapp-adapter.test.mjs`](../../tests/runner-whatsapp-adapter.test.mjs),
[`runner-whatsapp-send-guard.test.mjs`](../../tests/runner-whatsapp-send-guard.test.mjs),
[`runner-whatsapp-media.test.mjs`](../../tests/runner-whatsapp-media.test.mjs),
and [`runner-whatsapp-group-resolver.test.mjs`](../../tests/runner-whatsapp-group-resolver.test.mjs).

## Adding or changing an adapter

1. Update the shared types/contract only for behavior that can be normalized.
2. Add platform identity tests before persistence changes.
3. Cover unread/recent discovery, message key stability, timestamp ordering,
   duplicate scans, auth failure, thread mismatch, send result, and session
   teardown.
4. Wire every extraction path. LinkedIn has both streaming row snapshots and
   `ThreadStub` construction paths; a new field must reach both.
5. Update this capability table and the feature inventory only after the
   behavior is merged or explicitly verified on the documentation base.
