# Current feature inventory

This page is the canonical inventory for behaviour verified in the current
`develop` integration baseline. An unmerged workstream is not current behaviour,
and production release status remains governed by `main`.

Status terms:

- **Primary**: part of the student reply loop.
- **Secondary**: working and reachable, but intentionally quiet or off the
  main navigation.
- **Operator**: diagnostic, repair, or release surface.
- **Beta**: implemented but vulnerable to external UI or service change.
- **Opt-in**: implemented but disabled until explicit configuration.

## Reply workflow and presentation

| Feature | Status | Behavior and implementation |
| --- | --- | --- |
| Today queue | Primary | Focuses the next conversation needing attention, shows what follows, and supports open, snooze, and mark handled. [`today/page.tsx`](../../apps/dashboard/app/today/page.tsx) |
| Inbox | Primary | Full active list with search, platform/category/status filters, sorting, favorites, selection, bulk done/snooze/rescan, and platform degradation notices. Large results mount 80 rows at a time behind an explicit Show more control; search and filters still use the full loaded set. [`inbox/page.tsx`](../../apps/dashboard/app/inbox/page.tsx) |
| Thread workspace | Primary | Paginated messages, reply brief, open loops, memory, receipts, composer, and explicit actions. [`thread/[id]/page.tsx`](../../apps/dashboard/app/thread/[id]/page.tsx) |
| Reconnect | Primary but LinkedIn-only | Ranks dormant LinkedIn relationships using deterministic signals and optional cached AI score. Opens a thread for the user to write. [`reconnect/page.tsx`](../../apps/dashboard/app/reconnect/page.tsx) |
| Archived | Secondary | Lists archived threads with filters, selection, and restore. Reachable from Inbox and Command-K, not primary navigation. [`archived/page.tsx`](../../apps/dashboard/app/archived/page.tsx) |
| Command palette and search | Primary | Finds threads and destinations and exposes scan/navigation actions from Command-K. [`command-palette.tsx`](../../apps/dashboard/components/layout/command-palette.tsx) |
| Responsive shell | Primary | Collapsible desktop sidebar, phone bottom dock, runner status, attention count, notification center, and themes. [`app-shell.tsx`](../../apps/dashboard/components/layout/app-shell.tsx) |
| Favorites | Primary | Pins a person within existing queue/order semantics and enables favorite-only filtering. Stored as `Person.favouritedAt`. |
| Mark done | Primary | Clears active reply obligation across the correct canonical/sibling target set without sending anything. |
| Archive and restore | Primary | Removes a thread from active views until the user explicitly restores it. |
| Snooze and unsnooze | Primary | Hides active threads until a time; new inbound can clear the snooze. Suggested durations and direct unsnooze are supported. |
| Private reminder | Primary | Natural-language reminder text is stored with a snooze and shown privately when the thread returns. It is never sent. |
| Saved drafts | Primary | One or more persisted draft records are read by thread; current UI saves and deletes the active draft. |
| Relationship memory | Primary | Thread response includes durable AI memory and context from other threads for the same person. |
| Name suggestions and rename | Primary | iMessage handle names resolve from Contacts/vCard; unresolved handles can receive a heuristic suggestion the user confirms or rejects. |
| Group conversation presentation | Primary where supplied | Group name and per-message sender labels are supported. WhatsApp uses a current synthetic-Person model; a participants table does not exist. |
| Link previews | Secondary | Safe URL validation, fetch, parse, and thread cards for message links. |

## Writing and AI assistance

| Feature | Status | Behavior and implementation |
| --- | --- | --- |
| Rolling summary and current ask | Primary with key | Generated when the versioned inbound hash changes; prior state is preserved on transient failure. |
| Reply brief | Primary with key | Combined with summary generation and sanitized into where-things-stand plus required, optional, and handled points. Older rows get a safe derived fallback. |
| Open-loop checklist | Primary | AI-derived points can be dismissed by the operator without deleting the canonical generated list. Draft coverage checks mark addressed/partial items. |
| Things to remember | Primary with key | AI extracts durable facts with optional dates into thread memory. |
| Conversation category | Secondary with key | First-pass `outreach` versus `genuine` classification supports inbox filtering. |
| Open/closed verdict | Secondary with key | Versioned last-inbound classifier complements deterministic heuristics and stores a reason. Memory-only help reduces this organizational classification. |
| Reassess | Primary, explicit | Rebuilds current derived state on user request and clears applicable transcription refresh flags. |
| Writing transformations | Primary at writing-support level | Shorten and warmer transformations act on user text and return editable text. |
| Compose from intent | Full-drafts opt-in | Turns the user's stated intent into an editable complete reply. |
| Suggested replies and predraft | Full-drafts opt-in | Cached provider-backed suggestions and optional predraft remain secondary to the user's composer. |
| Voice profile | Primary | Stores name, self-description, interests, common/avoided phrases, preferred tone, and help level. The user can ask AI to infer only style fields from sent messages. |
| Observed per-thread style | Primary with AI calls that draft | Measures message length, emoji, full-stop, and capitalization patterns separately for operator and contact. |
| Deterministic voice enforcement | Primary with AI | Removes forbidden dash/semicolon/colon forms, applies sentence-start rules, and sanitizes model output after generation. |
| Multi-provider routing | Secondary/operator | OpenAI, Gemini API, and Z.AI GLM clients, configured-key selection, retries, OpenAI fallback, and limited user-visible provider racing. [AI reference](ai.md) |

## Composer and message actions

| Feature | Status | Behavior and implementation |
| --- | --- | --- |
| Explicit immediate send | Primary | Creates a durable send request and returns queue acknowledgement before external dispatch. Nothing auto-sends. |
| Scheduled send | Primary | Creates a future `SCHEDULED` row; due rows are promoted atomically, can be edited or canceled while still scheduled. |
| Failed-send retry | Primary | The operator explicitly retries a failed request. Interrupted uncertain sends require platform verification first. |
| App-level reply threading | Secondary | Stores a parent message ID and nests the bubble in the dashboard. iMessage recipients still receive a normal unthreaded bubble for app-created replies. |
| Attachments | Platform-dependent | iMessage sends supported files/voice notes through Messages; WhatsApp supports media; LinkedIn and beta adapters are text-only in the verified boundary. |
| Voice recording | Platform-dependent | Explicit microphone capture can produce a voice attachment. |
| Dictation | Primary when local transcription is ready | Records audio, transcribes it, and returns editable composer text. |
| Composer formatting | Platform-dependent | WhatsApp formatting helpers and poll creation are offered where supported. |
| Reactions | LinkedIn | Adds a verified emoji reaction through the optional adapter capability. Parsed platform reactions display on supported messages. |
| Edit outbound message | LinkedIn | User-triggered edit through the optional adapter capability. |
| Poll send and vote | WhatsApp | Sends polls and votes through optional WhatsApp adapter methods. |
| Open source thread/profile | Platform-dependent | Opens the authenticated platform thread or LinkedIn profile in the runner-controlled browser; iMessage opens the Messages chat. |
| Late-night send nudge | Primary | Offers an explicit later time rather than silently sending during a late period. |

## Ingestion, enrichment, and media

| Feature | Status | Behavior and implementation |
| --- | --- | --- |
| Manual update/full scan | Primary | User requests a cheap update scan or a full sweep. Queue, cooldown, caps, and identity guards remain active. |
| Scheduled auto-scan | Primary but user/config controlled | Per-platform due checks, active-hour UI control, adaptive idle backoff, cooldown, and serialized execution. |
| iMessage change watcher | Primary on enabled macOS | Watches `chat.db`, WAL, and SHM activity, debounces bursts, checks user-enabled platforms, then requests an update scan. |
| iMessage incremental watermark | Primary | Skips unchanged databases, collects changed chats, and requests a full sweep when deletions cannot be attributed safely. |
| WhatsApp inbound callback | Opt-in | Debounces library message events into targeted WhatsApp scan requests; normal scheduled scan remains a fallback while connected. |
| LinkedIn streaming scan | Primary | Walks the inbox, uses list-side change signals to limit opens, hydrates messages, supports first full backfill, and stops safely on identity/auth failures. |
| Outbound reconciliation | Primary | Deduplicates send-time and platform-scan rows, including iMessage sibling handles, while preserving automation and reply metadata. |
| Audio/video transcription | Opt-in in code, enabled by pilot `.env.example` | Transformers, local Whisper, or explicit OpenAI provider. Attempts, selected tier, errors, and refresh need persist in SQLite. |
| Progressive local Whisper | Advanced opt-in | Runs configured fast/standard/max tiers without allowing a failed or worse tier to replace the selected transcript. |
| GPT text refinement | Advanced opt-in | Sends transcript text and nearby context, not audio, to the configured OpenAI model after the standard local tier. |
| LinkedIn profile enrichment | Secondary, automatic queue off by default | Manual research remains available. Automatic first-seen/periodic queue requires `ENRICH_AUTO_ENABLED`; pacing and daily caps limit risk. |
| Contacts name sync | Primary on macOS | Reads local AddressBook and optional vCard, repairs existing iMessage people, and preserves manual names. |
| Birthday sync | Secondary on macOS | Reads Contacts birthdays at boot/daily and surfaces upcoming birthdays. |

## Platform, operations, and pilot support

| Feature | Status | Behavior and implementation |
| --- | --- | --- |
| LinkedIn | Primary | Personal or isolated Chrome session, scan, verified send, reactions, outbound edit, open thread/profile, selector diagnostics. |
| iMessage/SMS | Primary on macOS | Local database read, watcher, Contacts names, media read, text/file send through Messages automation, delivery/retraction reconciliation. |
| Instagram | Pilot beta | Standard installed Chrome with a dedicated persistent profile, manual login and security checks, stable thread URLs, unread/recent scan, safe media placeholders, exact-thread open, and user-triggered text send confirmed by a new outgoing bubble. Selector changes fail closed without content-bearing diagnostics. |
| TikTok | Scaffold only | Retains the generic shared beta adapter. This Instagram work does not expand or verify TikTok support. |
| WhatsApp | Opt-in | QR-backed `whatsapp-web.js`, local session, inbound callback, groups, rich media, polls, voting, and outbound rate guard. Disabled by default. |
| Health endpoint and doctor | Operator | `/health` provides live queue/platform status; `npm run doctor` checks host, runtime, paths, services, Messages, Chrome, AI, and transcription without mutation. |
| Audit activity and receipts | Operator | SQLite audit log and hidden `/logs` page show control, scan, send, selector, and system outcomes. Optional run traces add file artifacts. |
| Platform diagnostics | Operator | Hidden `/platforms` page can connect, scan, open browser, test selectors, and reset a session. |
| People detail/enrichment | Secondary, off primary nav | Hidden `/people` page retains notes, profile URL, groups, enrichment, relationship summary, questions, and scan-all controls. It is not a signal to expand into a CRM. |
| At Risk route | Existing legacy/secondary | `/at-risk` still resolves and offers batch actions, but it is removed from pilot navigation and current strategy says not to build an At Risk dashboard. |
| Presenter modes and full demo | Operator/demo | Safe seeded sandbox and live read-only presentation modes, plus guided tours and reset. External actions are server-guarded. |
| Pilot feedback | Primary | User-entered report plus safe context; optional confirmed screenshot; webhook delivery with copy fallback and optional GitHub attachment. |
| App updates | Primary | Source installs use the checksum-verified source updater. Free stable signed macOS builds use Electron's native updater with a complete pre-signed app. Ad-hoc packaged builds require manual replacement. Developer checkouts are refused. |
| Source release publishing | Operator | Builds tracked-only ZIP, guards secret/user-data exclusions, creates manifest/checksum, publishes to stable Dropbox paths, and verifies live artifacts. |
| Electron DMG | Operator/build | Produces an architecture-specific Electron app with bundled Node 22, prebuilt workspaces, hardened-runtime entitlements, strict code-sign verification, DMG verification, immutable code, and external user storage. Not the same as the published source ZIP. |

## Deliberately absent

- automatic AI reply sending;
- hosted message storage or a multi-user backend;
- analytics, relationship scoring dashboards, Lead OS crossover, or broad CRM
  expansion;
- a committed Prisma migration history;
- signed/notarized universal DMG distribution in the verified baseline;
- a server-safe headless iMessage sender;
- current camera capture despite the packaged plist usage string.
