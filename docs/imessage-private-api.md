# iMessage private-API native send layer (opt-in)

> **Status: opt-in, off by default, advanced.** The app works fully without
> this. Turning it on requires installing an **external** helper that injects
> into Messages.app, which in turn requires **disabling System Integrity
> Protection (SIP)** on the Mac that runs the runner. That permanently weakens
> that Mac's security model. Do not enable this on a daily-driver Mac that also
> holds sensitive data unless you have genuinely weighed the trade-off. Many
> people who want this run it on a dedicated, secondary Mac (e.g. an old Mac
> mini) — the runner is already a separate process, so that works cleanly.

## What this is

Normally Relationship-Inbox-OS sends iMessage **threaded replies** as plain
text bubbles and stores **tapbacks** as app-level rows the dashboard renders.
The operator sees rich threads and reactions; the contact sees a plain bubble
(reply) or nothing on the wire (tapback). That asymmetry is by design — the
app-level data model (`Message.replyToMessageId`, `MessageReaction`) is the
canonical source of truth.

This layer is a thin, **opportunistic** enhancement on top of that. When an
external private-API helper is reachable, the runner upgrades the *wire*
behavior so the contact sees the **real native experience**:

- A **threaded reply** appears in their Messages.app as an actual threaded
  reply with the quoted parent — not a plain bubble.
- A **tapback** (heart, like, dislike, laugh, emphasize, question) appears as a
  real native reaction on the message within seconds.

When the helper is **not** reachable, everything degrades to the existing
behavior with no change to the dashboard. The canonical app-level row is always
written **first**, before any wire send is attempted, so the dashboard is
consistent regardless of outcome. Each row records whether the contact actually
saw the native action:

- `Message.deliveredNative` — true when a reply went out natively.
- `MessageReaction.deliveredNative` / `sentVia` — `true` / `"automation"` when a
  tapback went out natively; `false` / `"dashboard_only"` when only the operator
  saw it.

## Architecture

```
send(reply | tapback)
  1. write the canonical app-level row (replyToMessageId / MessageReaction)
  2. if privateApiHelper.isReachable():
        try native send via the helper
          success -> mark deliveredNative=true, sentVia="automation"
          failure -> fall through (logged), row stays deliveredNative=false
  3. fallback:
        reply   -> plain text bubble (existing AppleScript send)
        tapback -> dashboard-only (row already written; no wire send)
```

`isReachable()` is fast and cached:

- **Disabled** (the default) → returns false instantly, never touches the
  socket. Send latency is unchanged.
- **Enabled but no helper listening** → the socket connect fails immediately
  (ENOENT / ECONNREFUSED), so a probe is sub-millisecond, and the negative
  result is cached.
- **Enabled and healthy** → one local UNIX-socket `ping` round-trip (a few ms),
  cached for `IMESSAGE_PRIVATE_API_HEALTH_CACHE_MS`.

The runner only ever **speaks the protocol**; it never injects anything. The
injecting helper lives entirely outside this repository.

## Configuration (runner env)

| Variable | Default | Meaning |
| --- | --- | --- |
| `IMESSAGE_PRIVATE_API_ENABLED` | `false` | Master switch. Also requires macOS (`darwin`). When false, the layer is inert and the dashboard tapback trigger is hidden. |
| `IMESSAGE_PRIVATE_API_SOCKET` | `~/.relationship-inbox/imessage-helper.sock` | UNIX socket the helper listens on. Deliberately outside the repo so the runner and the external helper agree on a fixed path regardless of checkout location. |
| `IMESSAGE_PRIVATE_API_TIMEOUT_MS` | `5000` | Per-request timeout for helper calls. |
| `IMESSAGE_PRIVATE_API_HEALTH_CACHE_MS` | `3000` | How long an `isReachable()` result is cached. |

Enabling the switch alone does nothing useful until a helper (real or mock) is
listening on the socket.

## The wire protocol

Newline-delimited JSON (NDJSON) over a UNIX domain socket. One request object
per line; the helper replies with exactly one response object per line,
correlated by `id`. The runner opens a short-lived connection per request, so
the helper may restart freely. The canonical definition lives in
[`apps/runner/src/platforms/imessage-private-api/protocol.ts`](../apps/runner/src/platforms/imessage-private-api/protocol.ts).

Request:

```json
{ "id": "<uuid>", "op": "ping" | "sendThreadedReply" | "sendTapback", "params": { ... } }
```

Response (success / error):

```json
{ "id": "<uuid>", "ok": true,  "result": { ... } }
{ "id": "<uuid>", "ok": false, "error": { "code": "<code>", "message": "..." } }
```

Operations:

- `ping` → `{ helper?, protocol?, capabilities? }`. Used for liveness.
- `sendThreadedReply` → params `{ chatGuid, parentMessageGuid, text }`, result
  `{ messageGuid? }`. `chatGuid` is the Apple chat GUID; `parentMessageGuid` is
  the Apple message GUID of the parent. Returning the new message's `messageGuid`
  lets a later `chat.db` scan dedup against the row the runner persists.
- `sendTapback` → params `{ chatGuid, targetMessageGuid, kind, action }` where
  `kind` is one of `heart | like | dislike | laugh | emphasize | question` and
  `action` is `add | remove`.

Error codes: `unsupported_op`, `unsupported_kind`, `invalid_params`,
`not_found`, `send_failed`, `internal`. **`unsupported_kind` is important** —
even with a private API, some newer (iOS 18+ expanded-emoji) tapback kinds may
not be drivable. Returning `unsupported_kind` lets the runner degrade that one
tapback cleanly to the dashboard-only path instead of treating it as a hard
failure.

## Testing without disabling SIP — the mock helper

A dependency-free mock helper implements the exact protocol so you can verify
the **routing**, **persistence**, dashboard trigger, and **fallback** end to end
without touching SIP or Messages.app. It does not send anything to anyone — it
logs what it was asked to do and acknowledges.

```bash
# Terminal 1 — start the mock helper (prints the socket path it listens on)
npm run mock:imessage-helper

# Terminal 2 — start the runner pointed at it
IMESSAGE_PRIVATE_API_ENABLED=true \
IMESSAGE_PRIVATE_API_SOCKET="$HOME/.relationship-inbox/imessage-helper.sock" \
npm run dev
```

With the mock up:

- Send a threaded reply from the dashboard's focused-thread composer → the
  runner logs `MESSAGE_SENT … sendPath=private_api`, the mock logs the reply,
  and the `Message` row has `deliveredNative=true`.
- Click **react** under a message and pick a tapback → the badge appears, the
  mock logs the tapback, and the `MessageReaction` row has
  `deliveredNative=true`, `sentVia="automation"`.

Stop the mock (Ctrl-C) and repeat: replies fall back to plain text and tapbacks
persist as `deliveredNative=false`, `sentVia="dashboard_only"`. The dashboard
view is identical either way.

Mock knobs (env): `MOCK_UNSUPPORTED_KINDS=question` makes the mock reject that
kind with `unsupported_kind` (to exercise the degrade path);
`MOCK_FAIL_REPLIES=true` makes every reply fail (to exercise reply fallback).

## Installing the real helper (advanced, external)

> **The supported real-delivery path is the BlueBubbles bridge** —
> `tools/bluebubbles-helper-bridge.mjs` (run via `npm run bridge:bluebubbles`).
> It speaks the protocol above and forwards to a local BlueBubbles server, so
> you don't have to build/inject your own bundle. Follow the step-by-step
> [real-helper runbook](./imessage-real-helper-runbook.md) — SIP-off,
> BlueBubbles install, and verification included.

The runner integrates with a helper; it does **not** ship an injector. Two
open-source projects already implement native iMessage send via Messages.app's
private API; the BlueBubbles bridge above reuses one of them, but the connector
portion of either can also be adapted to speak the protocol directly:

- **imessage-rs** — Rust core plus a dedicated Swift Private API connector. The
  Swift connector is the cleanly separable part.
- **BlueBubbles** — an Objective-C tweak inside Messages.app. Older and more
  entangled, but battle-tested.

Both depend on the same macOS prerequisites, in order:

1. **Disable SIP** (System Integrity Protection) — from Recovery, `csrutil
   disable`. This is the big one; see the warning at the top of this document.
2. **AMFI / library-validation** tweaks so an unsigned/foreign library can load
   into Messages.app.
3. **Re-sign Messages.app** after injecting the helper bundle.
4. **SIMBL / MacForge-style injection** infrastructure to load the bundle into
   Messages.app on launch.

This is not a one-flag toggle and is **out of scope for this repository** by
design. Follow the chosen upstream project's own installation instructions, and
point its socket at `IMESSAGE_PRIVATE_API_SOCKET`.

> **Licence check before lifting any code.** imessage-rs and BlueBubbles are
> open source, but verify the licence before copying code into a derived helper.
> A permissive licence (MIT / Apache-2.0) is fine; a copyleft licence (GPL)
> could impose obligations on whatever you link it into. Read the LICENSE file
> first.

## Honest considerations

- **SIP off is a real, lasting cost.** Anything running as root on that Mac can
  then tamper with system processes. Prefer a dedicated secondary Mac.
- **Injection is involved.** SIP off + AMFI tweaks + library validation disabled
  + re-signing Messages.app. SIMBL/MacForge handles a lot but it is fiddly.
- **Even private APIs have gaps.** Expect some iOS 18+ tapback kinds to return
  `unsupported_kind` and degrade to the dashboard-only path.
- **macOS update treadmill.** Each macOS minor bump may require rebuilding and
  re-signing the helper.

If any of this feels like too much, that's the expected reaction — the
app-level layer alone is designed to be enough for most use. This wire layer is
purely for when the "operator sees threads/tapbacks, contact sees plain bubbles"
asymmetry actually bothers you in practice.
