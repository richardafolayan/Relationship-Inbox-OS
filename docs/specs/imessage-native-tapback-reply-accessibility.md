# Spec: native iMessage tapbacks and threaded replies, with no SIP, via Accessibility

Status: ready to build
Owner: (assign)
Audience: the engineer/agent implementing this (referred to below as "you")
Last updated: 2026-06-12

---

## 0. One paragraph

Send real, native iMessage tapbacks (heart/like/dislike/laugh/emphasize/question) and real
threaded inline replies from Relationship Inbox OS, WITHOUT disabling System Integrity
Protection. We do it by driving the actual Messages.app UI through the macOS Accessibility
API instead of injecting into `imagent`. The runner already has the entire client side of
this built behind a transport-agnostic socket protocol (the `PrivateApiHelper` facade, used
today by a mock and by a BlueBubbles bridge). Your job is to build a third backend, the
"AX helper", a small persistent local process that listens on the same UNIX socket, speaks
the same NDJSON protocol, and performs each tapback/reply by operating the Messages window
the way a human does. The message that lands on the wire is genuine and indistinguishable
from a human send, because the real Apple-signed Messages app is doing the send.

---

## 1. Background and why this approach

A tapback and a threaded reply are, at the protocol level, just an ordinary iMessage with a
couple of extra association fields set (`associated_message_guid` + `associated_message_type`
for a tapback; a derived `threadIdentifier` / `thread_originator_guid` for a reply). There
are only two ways to make iMessage emit those fields:

1. Call the private iMessage frameworks (IMCore) directly. This is what BlueBubbles does by
   injecting a helper bundle into `imagent`/`Messages`. It is clean and headless but
   **requires SIP disabled** (plus AMFI defeat on Apple Silicon), because Messages is an
   Apple platform binary protected by library validation and entitlement checks. That is a
   non-starter for software we ship to pilot users' Macs.

2. Drive the real Messages app's own Tapback and Reply controls through the Accessibility
   API. This needs only the Accessibility permission (a TCC grant, the same kind of
   permission Keyboard Maestro, Alfred and screen readers use). **No SIP.** This is the
   approach in this spec.

The tradeoff we are accepting: the AX path is slower, needs Messages actually running, is
more sensitive to macOS UI changes, and needs a graceful fallback when it cannot complete.
We do NOT give up authenticity. For a low volume, operator-in-the-loop calm inbox (react or
reply to a handful of recent messages), the AX downsides barely bite, while the thing it
refuses to compromise, authenticity and zero ban surface, is exactly what we care about.
That is why this fits RIOS when it would not fit a high-volume relay server.

Prior art note: branch `wip/imessage-system-events` is NOT related to this. There "system
events" means iMessage's own in-band notices (e.g. "kept an audio message"), not AppleScript
System Events / Accessibility. Do not mine it for this work.

---

## 2. Goals and non-goals

### Goals
- Send a native tapback (add and remove) for the six classic kinds to a target message.
- Send a native threaded inline reply to a target message.
- Require only Accessibility + Automation + Full Disk Access permissions. Never SIP.
- Be a drop-in backend behind the existing `PrivateApiHelper` socket protocol. The runner's
  routing and fallback code must not need to know which backend is behind the socket.
- Fail safe: any failure returns a structured error so the runner falls back to a plain-text
  reaction or quoted reply. Nothing ever hard-crashes a send.
- Ship default OFF behind an opt-in setting.

### Non-goals (this spec)
- iOS 18 arbitrary-emoji and sticker tapbacks (the protocol's typed `TapbackKind` is the six
  classic kinds only). Designed-for-later in Phase 2, see section 10.
- Edits, unsends, typing indicators, group management, message effects. Out of scope.
- Replacing the BlueBubbles backend. It stays available for any user who already runs SIP
  off, for free, because it speaks the same protocol.
- Any CRM/scoring/analytics expansion. Keep to the calm-inbox direction.

---

## 3. Architecture: a drop-in helper on the existing socket

```
Relationship Inbox OS (runner)
        |
        |  createPrivateApiHelper()  (UNCHANGED facade)
        v
  PrivateApiHelper  ->  helper-bridge.ts  ->  UNIX socket (NDJSON, 1 req per connection)
                                                   |
                            +----------------------+----------------------+
                            |                      |                      |
                     mock helper            BlueBubbles bridge       AX helper  <-- YOU BUILD THIS
                     (tests only)           (needs SIP off)          (no SIP)
```

The runner connects to `IMESSAGE_PRIVATE_API_SOCKET`, writes one request line, reads one
response line, closes. Whatever is listening on that socket is the backend. The mock proves
the runner side already works end to end. You are writing a new listener that, instead of
logging (mock) or calling a BlueBubbles REST server, drives the Messages UI.

This is the single most important constraint in the spec: **match the wire protocol exactly**
(section 4). If you match it, the runner needs zero changes to route to you.

---

## 4. The exact contract you must implement

Source of truth lives on branch `feat/imessage-private-api-send`:
`apps/runner/src/platforms/imessage-private-api/protocol.ts`. Reproduced essentials:

- Transport: NDJSON over a UNIX domain socket. One JSON request object terminated by `\n`;
  exactly one JSON response object terminated by `\n`, correlated by `id`. One short-lived
  connection per request (the client opens, writes, reads one line, closes). Your server must
  therefore be a persistent listener that handles many short connections, exactly like
  `tools/mock-imessage-helper/server.mjs`.
- `PRIVATE_API_PROTOCOL_VERSION = 1`.
- Ops: `ping`, `sendThreadedReply`, `sendTapback`.

Request shape:
```jsonc
{ "id": "<uuid>", "op": "<op>", "params": { ... } }
```

Params:
```ts
// ping: {}  (no params)

SendThreadedReplyParams {
  chatGuid: string;          // Apple chat GUID == our Thread.platformThreadId, e.g. "iMessage;-;+447700900123"
  parentMessageGuid: string; // Apple message GUID of the message being replied to
  text: string;
}

SendTapbackParams {
  chatGuid: string;
  targetMessageGuid: string; // Apple message GUID being reacted to
  kind: "heart"|"like"|"dislike"|"laugh"|"emphasize"|"question";
  action: "add"|"remove";
}
```

Success responses:
```jsonc
{ "id": "<uuid>", "ok": true, "result": { ... } }
// ping     -> { helper?: string, protocol?: number, capabilities?: { tapbackKinds?: TapbackKind[], threadedReply?: boolean } }
// reply    -> { messageGuid?: string }   // include the new reply's Apple GUID if you can read it back from chat.db
// tapback  -> { }                         // empty object today
```

Error responses (use the stable code so the runner can branch):
```jsonc
{ "id": "<uuid>", "ok": false, "error": { "code": "<code>", "message": "<human readable>" } }
```
Codes: `unsupported_op`, `unsupported_kind`, `invalid_params`, `not_found`, `send_failed`,
`internal`. (`transport` is synthesised client-side; never send it yourself.)

Mapping you MUST honour:
- Unknown `op` -> `unsupported_op`.
- Missing/blank required param -> `invalid_params`.
- `kind` outside the six (or one this build cannot do) -> `unsupported_kind`. This is the
  clean degrade path; the runner will fall back to a plain reaction emoji.
- Target conversation or bubble not locatable -> `not_found`.
- The UI gesture started but did not complete (menu missing, click failed, timeout) ->
  `send_failed`.
- Anything unexpected -> `internal`.

Reference implementation to mirror for protocol behaviour (NOT for the UI work):
`tools/mock-imessage-helper/server.mjs` on the `feat` branch. Your helper should pass the
same protocol/transport tests the mock passes:
`tests/runner-imessage-private-api-protocol.test.mjs` and
`tests/runner-imessage-private-api-transport.test.mjs`.

---

## 5. Porting plan (the scaffolding is on a stale branch)

The client scaffolding (`imessage-private-api/` dir, mock helper, bridge, protocol tests)
exists only on `feat/imessage-private-api-send`, which branched before the v1 strip-back and
is far behind `main`. Do NOT merge that whole branch into main.

Instead:
1. Branch from current `main`.
2. Port across only the self-contained private-API client layer:
   - `apps/runner/src/platforms/imessage-private-api/` (protocol.ts, helper-bridge.ts,
     health.ts, send-reply.ts, send-tapback.ts, index.ts)
   - `tools/mock-imessage-helper/server.mjs`
   - the two protocol/transport tests above, plus
     `tests/runner-imessage-bluebubbles-bridge.test.mjs` if you keep the BlueBubbles backend.
3. Re-wire the adapter on top of current main's `imessage-adapter.ts` (section 7). The send
   path on main is AppleScript-only today; you are adding the "try native, then fall back"
   decision around it.
4. Resolve any drift (types, imports) against current main. Keep the changes minimal and
   additive; do not refactor unrelated code.

If porting proves noisy, it is acceptable to recreate the small client layer fresh against
main using the `feat` branch files as the reference, since the protocol is the real contract,
not the file history.

---

## 6. The new component: the AX helper

This is the bulk of the work. It is a NEW, persistent, local process. Unlike the BlueBubbles
bundle it is NOT injected and needs NO special signing, so it can live in this repo and be
launched by the runner.

### 6.1 Language and runtime
- Recommended: a small Swift command-line binary using `ApplicationServices` /
  `AXUIElement` for the Accessibility tree and `CGEvent` for any synthetic clicks/keys, plus
  `SQLite` (read-only) for chat.db lookups. Swift gives stable AX access and easy packaging.
- Acceptable prototype path to de-risk first: JXA (`osascript` JavaScript) or AppleScript
  System Events GUI scripting, which can reach the same menus quickly for a spike, then port
  the proven gesture sequence to Swift for the shipped helper.
- The helper must be dependency-light and startable as a child process by the runner.

Put helper source under `tools/imessage-ax-helper/` (mirrors `tools/mock-imessage-helper/`).
If Swift, include a tiny build script and check in the built universal binary under a
predictable path, or build on launch if a toolchain is present. Decide based on what the
release pipeline can support; document it.

### 6.2 Protocol parity
Implement the section 4 contract precisely. Persistent listener, one response line per
request line, correct error codes. Add a `IMESSAGE_AX_DRY_RUN=true` mode that does everything
EXCEPT the actual UI gesture (resolve chat.db, find the target, then return `ok:true` without
touching Messages). Dry-run is what lets CI exercise the helper headlessly (section 9).

### 6.3 Resolve chatGuid + messageGuid to an on-screen target (read chat.db)
The helper is given Apple GUIDs, not screen coordinates. Resolve them read-only from
`~/Library/Messages/chat.db` (the app already requires Full Disk Access for this):

- From `chatGuid`: get `chat.chat_identifier` and the participant handle(s) via
  `chat` join `chat_handle_join` join `handle`. This tells you which conversation to focus
  and (for 1:1) the handle to address.
- From `targetMessageGuid`: get `message.text`, `message.attributedBody`, `message.date`,
  `message.is_from_me`, `message.handle_id` via `message` join `chat_message_join`. This is
  the text you will match against the rendered bubble, and the recency you will use to find
  it. Note some messages carry their text only in `attributedBody` (a binary plist); if
  `text` is null, decode `attributedBody` or rely on the AX-rendered string for matching.

Relevant existing SQL to copy the column names and joins from (on main):
`apps/runner/src/platforms/imessage-db.ts` (search with `grep -a`; the file trips binary
detection). See `fetchMessages()` (around lines 758-835) and `listThreadsSelect()` (around
447-468).

### 6.4 Focus the right conversation
You must get the target conversation visible in Messages before you can touch its bubbles.
Recommended order, fall through on failure:
1. For a 1:1 chat, `open "imessage://<handle>"` (or the equivalent LSOpen) focuses/opens that
   conversation fast. Verify afterwards via AX that the open conversation matches.
2. Otherwise (or if step 1 lands on the wrong/new conversation, or for groups): activate
   Messages and select the conversation in the sidebar via AX by matching the row whose
   title/handle equals the participant name/handle from chat.db.
3. If neither lands on the right conversation, return `not_found`.

### 6.5 Locate the target bubble
- Walk the AX tree of the focused conversation's transcript scroll area. Message bubbles
  expose their text via `AXValue`/`AXDescription`. Build a list of (bubble element, rendered
  text, inbound/outbound) in transcript order.
- P0 scope: the target is almost always the most recent inbound message (you are reacting to
  what they just sent), which is the last inbound bubble at the bottom and on-screen. Take the
  last inbound bubble, normalise whitespace, and confirm its text equals the chat.db target
  text. If it matches, that is your bubble.
- If the last inbound does not match (they sent something newer, or the target is older),
  P0 may return `not_found` and let the runner fall back. P1 adds: scroll up and match by
  text, disambiguating ties by recency.
- Normalisation: trim and collapse internal whitespace on both sides before comparing (mirror
  the runner's `normalizeOutboundTextForDedup` philosophy so a one-character whitespace diff
  does not defeat the match).

### 6.6 Perform a tapback
- Discover the exact gesture live and record the AX path; expected primary gesture: invoke
  the bubble's context menu (right-click via `CGEvent`, or `AXShowMenu` if exposed) -> click
  the "Tapback" menu item -> the tapback palette popover appears -> click the button matching
  `kind`.
- Map `kind` to the palette control. Prefer matching by the control's AX label
  (e.g. heart -> "Heart"/"Loved", like -> "Thumbs Up", dislike -> "Thumbs Down",
  laugh -> "Ha Ha"/"Laughed", emphasize -> "Exclamation"/"Emphasized",
  question -> "Question Mark"). If labels are unreliable on a given build, fall back to the
  stable left-to-right index of the six classic icons. Document whichever you rely on.
- `action: "remove"`: tapbacks toggle. Clicking the currently-applied reaction removes it.
  Detect the applied state if the palette exposes it; otherwise treat remove as "click the
  same icon to toggle off" and verify via chat.db (a `3000`-series row appears).
- Confirm success: after the gesture, optionally verify a new associated-message row exists in
  chat.db for the target (`associated_message_type` in 2000-2005 for add, 3000-3005 for
  remove). If you cannot confirm within a short timeout, still return `ok` only if the gesture
  completed cleanly; return `send_failed` if any step did not complete.

### 6.7 Perform a threaded reply
- Invoke the bubble's context menu -> "Reply". An inline reply composer appears with the
  target quoted above the input.
- Insert `text` into the compose field (set `AXValue` on the field if writable, else type via
  `CGEvent` keystrokes), then send (press Return, or click the send button).
- If you can, read the new outbound row back from chat.db (most recent outbound with a
  `thread_originator_guid` pointing at `parentMessageGuid`) and return its `guid` as
  `messageGuid`. This is optional but improves dedup downstream.

### 6.8 Capabilities and graceful degradation
- `ping` returns `{ helper: "imessage-ax-helper", protocol: 1, capabilities: {
  tapbackKinds: ["heart","like","dislike","laugh","emphasize","question"], threadedReply: true } }`.
  If a given macOS build cannot do replies or some kind, narrow these so the runner can avoid
  it. The runner may also just attempt and handle `unsupported_kind`.
- Every failure path returns a precise code (section 4). Never throw across the socket; always
  answer with one response line.

### 6.9 Focus stealing
Driving Messages brings it forward. This is the same problem the runner already solved for
the LinkedIn browser in `services/runner-window.ts` (PR #683: offscreen position +
CDP-minimise + refocus). Reuse that thinking:
- P0: accept a brief Messages activation. Restore the previously frontmost app afterwards
  (record it before, reactivate it after).
- P1: move the Messages window offscreen (set `AXPosition` way off-screen) or onto a separate
  Space for the duration of the gesture, then restore position. Goal: no visible flash, no
  Space switch, no stolen focus, matching the bar set by #683.
- Honour a `RIOS_VISIBLE_BROWSER_LAUNCH`-style kill switch for debugging (e.g.
  `IMESSAGE_AX_VISIBLE=1` to skip the hide and watch it work).

### 6.10 Permissions and first run (NO SIP)
The helper (or the app process that posts events on its behalf) needs:
- Accessibility (System Settings > Privacy & Security > Accessibility) to read the AX tree
  and post synthetic input to Messages.
- Automation permission for Messages and System Events the first time it scripts them.
- Full Disk Access for chat.db (already granted for the app's existing reads).
- Explicitly NOT SIP. Do not add any instruction that disables SIP.

First-run UX: detect missing Accessibility via `AXIsProcessTrusted()`. If untrusted, return a
helper-down signal (so the runner falls back) AND surface a one-time, calm hint in the app
that links to the Accessibility settings pane, mirroring how the iMessage contact-names and
FDA hints are surfaced today. Keep copy ASCII-only and in the operator's neutral voice; do
not hardcode any persona.

---

## 7. Runner-side integration

Most of this already exists on the `feat` branch; you are re-applying it on main.

- The adapter (`apps/runner/src/platforms/imessage-adapter.ts`) gains the "try native, then
  fall back" decision for two triggers:
  1. Operator sends a tapback from the dashboard (reaction trigger).
  2. Operator sends a reply that is explicitly threaded to a specific parent message.
- Decision flow per send:
  1. If the helper is enabled and `isReachable()` (cheap cached probe), call `sendTapback` /
     `sendThreadedReply`.
  2. On success, mark the row delivered-native (so the UI shows the genuine reaction/reply).
  3. On `PrivateApiError` of ANY code, fall back to what AppleScript can do:
     - tapback -> send the matching reaction emoji as a normal message
       (heart -> heart emoji, etc.), or
     - threaded reply -> send a plain message, optionally quoting the parent inline
       ("Re: \"<short quote>\" ..."), staying in the operator's voice, ASCII only.
  4. Never surface a hard error to the operator for a reaction; degrade quietly with inline
     status (running -> sent), per the action-status-feedback convention.
- The plain-text reaction/quote fallback copy must pass the no-UI-dashes gate and the
  capitalise-after-sentence-end rule.

Keep the dashboard affordance minimal and calm: a tapback control on a message and a "reply
to this" affordance that sets the threaded parent. Do not build a reactions analytics surface.

---

## 8. Configuration

Reuse the existing env names so the mock, BlueBubbles, and AX backends are interchangeable:
- `IMESSAGE_PRIVATE_API_ENABLED` (default false) gates the whole native path.
- `IMESSAGE_PRIVATE_API_SOCKET` (default `~/.relationship-inbox/imessage-helper.sock`) is the
  socket the runner connects to and the AX helper listens on.
- New, AX-specific:
  - `IMESSAGE_AX_DRY_RUN` (tests/CI: resolve but do not touch the UI).
  - `IMESSAGE_AX_VISIBLE` (debug: skip window-hide).
- A user-facing settings toggle ("Send native reactions and replies", default OFF) that, when
  enabled, (a) launches the AX helper as a child process and (b) sets
  `IMESSAGE_PRIVATE_API_ENABLED`. The toggle copy explains it operates Messages briefly and
  needs Accessibility permission. ASCII only.

The runner should spawn the AX helper at boot when the toggle is on (like other child
processes), health-probe it, and fall back silently if it is not up.

---

## 9. Testing and verification

### 9.1 Headless / CI (must pass in the normal suite)
- Protocol + transport parity: run the existing
  `tests/runner-imessage-private-api-protocol.test.mjs` and
  `...-transport.test.mjs` against the AX helper started in `IMESSAGE_AX_DRY_RUN=true`. It
  must behave like the mock for: ping capabilities, `invalid_params`, `unsupported_op`,
  `unsupported_kind`, id echo, malformed-JSON handling, one-response-per-line framing.
- chat.db resolution unit test: point the helper at a fixture chat.db (build a tiny SQLite
  with a chat + handle + a couple of messages) and assert it resolves a known `chatGuid` +
  `messageGuid` to the expected handle/text/recency. Mirror how other runner db tests build
  fixtures.
- Runner routing/fallback test: with the mock (or dry-run AX helper) returning each error
  code in turn, assert the adapter falls back correctly (reaction emoji / quoted reply) and
  marks delivered-native on success. (This exists for the mock on the `feat` branch; keep it.)
- Do NOT write a test that sends to a real contact. Live sends are manual (9.2).

### 9.2 Live verification (the only way to prove the AX gesture; manual, on a real Mac)
Provide a documented manual checklist (add to `docs/specs/` or `docs/qa/`) that a person runs
on a Mac with SIP ON, Accessibility granted, against a throwaway/self conversation:
1. Enable the toggle; confirm the helper launches and `ping` reports reachable.
2. Tapback add: react heart to the most recent inbound; confirm the recipient sees a native
   heart (not a heart emoji message) and a `2000` row appears in chat.db.
3. Tapback remove: remove it; confirm a `3000` row and the reaction disappears.
4. Each of the six kinds at least once.
5. Threaded reply: reply to a specific older-but-visible message; confirm the recipient sees a
   real inline reply with the quoted bubble, and `thread_originator_guid` is set.
6. Fallback: disable the helper / force `not_found`; confirm the operator still gets a plain
   reaction emoji / quoted reply with no error.
7. Focus: confirm the activation behaviour matches the phase (brief flash P0; no visible
   disruption P1).
Record the run (notes or screen capture) and attach to the PR. The PR must state the exact
macOS version it was verified on.

### 9.3 Acceptance criteria (Definition of Done)
- [ ] AX helper passes the protocol + transport tests in dry-run, same as the mock.
- [ ] chat.db resolution unit test passes against a fixture db.
- [ ] Runner falls back correctly on every error code; success marks delivered-native.
- [ ] Manual live run on a real Mac (SIP ON) demonstrates: all six tapback adds, at least one
      remove, and at least one threaded reply, all appearing NATIVELY on the recipient side,
      verified by chat.db association rows.
- [ ] No path anywhere instructs or requires disabling SIP.
- [ ] Default OFF; opt-in toggle launches the helper and explains the permission.
- [ ] Focus is restored to the previously frontmost app after each gesture.
- [ ] All new user-facing copy is ASCII (passes no-ui-dashes gate) and de-personalised.
- [ ] Full local suite green (this is the real gate; CI does not run lint/test on v1 PRs).

---

## 10. Phasing

- P0 (prove it): 1:1 chats, target = most recent inbound, six classic tapbacks (add) +
  threaded reply, brief activation, manual live verification, fall back on any miss. Default
  OFF. This is the spike that answers "does AX reliably work" with real numbers.
- P1 (make it good): offscreen/refocus so there is no visible disruption (reuse #683),
  older-message scroll-and-match, group chats, tapback remove with state detection, basic
  reliability logging (success/fallback counts).
- P2 (reach further): iOS 18 arbitrary-emoji tapbacks. This needs (a) a protocol extension
  to carry the emoji, e.g. add optional `emoji?: string` to `SendTapbackParams` and a new
  capability flag, and (b) palette navigation to the emoji picker. The AX path can in
  principle do what the IMCore path cannot here, since it drives the real expanded palette.
  Stickers remain out of scope.

Ship P0 behind the OFF toggle, gather reliability data, then decide P1/P2 scope.

---

## 11. Risks and unknowns

| Risk | Likelihood | Handling |
| --- | --- | --- |
| AX tree shape differs across macOS versions | High | Fail safe to `not_found`/`send_failed` -> runner falls back. Keep gesture/selector logic in one place; allow per-version overrides. Record the verified macOS version on every PR. |
| Tapback palette buttons not cleanly AX-labelled | Medium | Match by label first, fall back to stable left-to-right index of the six icons; document which. |
| Cannot locate an older target bubble | Medium | P0 returns `not_found` and falls back; P1 adds scroll-and-match. |
| Focus steal / Space switch annoys the operator | Medium | P0 restores prior frontmost app; P1 hides the window offscreen per #683. |
| Message text only in `attributedBody`, not `text` | Medium | Match on the AX-rendered string; decode `attributedBody` only if needed for resolution. |
| Helper process dies / Messages relaunches | Low | Transport already treats this as a transport error and re-probes; runner falls back. Runner relaunches the helper on next enable/boot. |
| Permission not granted | Low | `AXIsProcessTrusted()` check -> helper-down -> fallback + one-time settings hint. |
| Sending to a live contact during testing | Low but sensitive | No automated live-send tests; manual verification on a throwaway/self conversation only. |

Open questions to resolve live (record answers in the PR):
- Exact AX gesture/path to reach Tapback and Reply on the target macOS build.
- Whether `imessage://<handle>` reliably focuses the EXISTING conversation vs starting a new
  draft, per macOS version.
- Whether the tapback palette exposes applied-state for clean `remove`.

---

## 12. What stays true to the product

This is the calm-inbox direction, not a platform expansion: a small, opt-in, operator-driven
ability to react and reply natively, with a quiet fallback and zero ban surface. No scoring,
no analytics, no persona hardcoding. The whole point is that the message that reaches the
other person is real, and that the user never had to weaken their Mac to send it.
