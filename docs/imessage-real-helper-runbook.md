# Real iMessage delivery — BlueBubbles helper runbook (opt-in)

> **Read this first.** Everything below is **optional** and **only** needed if
> you want tapbacks / threaded replies you send from the dashboard to appear as
> **real native actions on the recipient's iPhone/Mac**. The app works fully
> without it. Turning it on requires **disabling SIP (System Integrity
> Protection)** on the Mac that runs the runner, which **permanently weakens
> that Mac's security model** until you turn it back on. Anything running as
> root can then tamper with system processes. Prefer a dedicated/secondary Mac
> (e.g. an old Mac mini) for this; don't do it on a daily-driver that holds
> sensitive data unless you've genuinely weighed the trade-off.

## How it fits together

```
Dashboard ──▶ Runner ──(NDJSON over UNIX socket, #273 protocol)──▶ helper
                                                                     │
   mock helper  → logs only, never touches Messages.app (default; for dev/test)
   BlueBubbles bridge → forwards to a local BlueBubbles server ──▶ Messages.app
                        (tools/bluebubbles-helper-bridge.mjs)        (real send)
```

The runner never changes. It just speaks the same socket protocol either way.
The **mock** is the default and proves routing without SIP. The **bridge**
(`tools/bluebubbles-helper-bridge.mjs`) is the real path: it translates the
runner's `sendTapback` / `sendThreadedReply` calls into
[BlueBubbles](https://bluebubbles.app) Private-API HTTP calls, and BlueBubbles
is what actually drives Messages.app. BlueBubbles already solved the hard part
(SIP-off + injecting the Private API bundle), so we reuse it instead of shipping
our own injector.

## Prerequisites

- A Mac signed into iMessage with the conversations you want to react to.
- Admin access and willingness to disable SIP on that Mac.
- This repo set up and runnable (`npm install` done).

---

## Step 1 — Disable SIP (only you can do this)

1. Apple menu → **Restart**, and hold the key to enter **Recovery**:
   - **Apple Silicon:** hold the **power button** until "Loading startup options", then **Options → Continue**.
   - **Intel:** hold **⌘ + R** during boot.
2. In Recovery: **Utilities → Terminal**, then run:
   ```
   csrutil disable
   ```
3. Reboot normally. Verify in a normal Terminal:
   ```
   csrutil status        # should report: System Integrity Protection status: disabled.
   ```

> To undo later: boot to Recovery again and run `csrutil enable` (see Rollback).

## Step 2 — Install the BlueBubbles Server

1. Download the **BlueBubbles Server** macOS app from <https://bluebubbles.app>
   and install it.
2. Launch it. When prompted, **set a server password** — note it down.
3. Grant the permissions it asks for: **Full Disk Access** and **Accessibility**
   (System Settings → Privacy & Security). Restart BlueBubbles after granting.
4. Note the **server port** it's listening on (the app shows the local address;
   the default is commonly `1234`).

## Step 3 — Enable the Private API in BlueBubbles

1. In BlueBubbles Server → **Settings → Private API Features** → enable.
2. Follow its prompt to **install the Private API helper bundle** into
   Messages.app (BlueBubbles automates the install/re-sign). This is what
   actually requires SIP to be off.
3. Restart Messages.app if asked. Confirm BlueBubbles shows Private API as
   **active/connected**.

> Sanity check the server is reachable (replace port/password):
> ```
> curl "http://localhost:1234/api/v1/ping?password=YOUR_PASSWORD"
> # → {"status":200,"message":"pong",...}
> ```

## Step 4 — Run the bridge

From the repo root, point the bridge at your BlueBubbles server. It listens on
the **same socket the runner uses by default**:

```bash
BLUEBUBBLES_SERVER_URL=http://localhost:1234 \
BLUEBUBBLES_PASSWORD=YOUR_PASSWORD \
IMESSAGE_PRIVATE_API_SOCKET="$HOME/.relationship-inbox/imessage-helper.sock" \
npm run bridge:bluebubbles
```

It prints `listening on …` and `forwarding to BlueBubbles at …`. Leave it
running in its own terminal (it logs each real send).

## Step 5 — Run the app against your REAL threads

Real delivery needs **real** conversations (so the chat/message GUIDs are the
real Apple ones BlueBubbles expects) — not the synthetic test-bed. In another
terminal, from the repo root:

```bash
IMESSAGE_ENABLED=true \
IMESSAGE_PRIVATE_API_ENABLED=true \
IMESSAGE_PRIVATE_API_SOCKET="$HOME/.relationship-inbox/imessage-helper.sock" \
npm run dev
```

- `IMESSAGE_ENABLED=true` scans your real `chat.db` so your actual threads
  appear in the dashboard (needs Full Disk Access for the runner's terminal).
- `IMESSAGE_PRIVATE_API_ENABLED=true` routes tapbacks/replies through the
  socket → bridge → BlueBubbles.

Open the dashboard, pick a **real** iMessage thread.

## Step 6 — Verify real delivery

> **Test on a safe thread first.** Use a low-stakes conversation — best of all,
> message **yourself** (your own number / another device you own), or a friend
> who's expecting the test — *not* an important contact. Tapbacks and replies go
> out for real once this works.

1. **Tapback:** hover one of the contact's messages → **react** → pick a
   reaction. Watch the bridge terminal log `tapback add love …`. Within a few
   seconds the reaction should appear on the **contact's** Messages.app, and the
   dashboard badge shows `sentVia=automation`, `deliveredNative=true`.
2. **Threaded reply:** reply in the focused-thread composer. The bridge logs
   `threaded reply …`; the contact sees a real threaded reply (quoted parent),
   not a plain bubble.
3. Change the reaction → it swaps (one tapback per message). Tap the active one
   → it's removed on their device too.

If the contact sees it natively, real delivery works.

## Troubleshooting

- **Bridge logs `BlueBubbles rejected the password`** → fix `BLUEBUBBLES_PASSWORD`.
- **Bridge logs `BlueBubbles unreachable`** → wrong `BLUEBUBBLES_SERVER_URL`/port,
  or the server isn't running.
- **BlueBubbles returns chat/message not found** → the stored `chatGuid` /
  `messageGuid` didn't match. Re-scan the thread (it must have been ingested by
  the real `chat.db` scan, not seeded), and confirm Private API is active in
  BlueBubbles.
- **Reaction rejected as unsupported** → some newer iOS-18+ expanded-emoji
  tapbacks aren't drivable; the runner degrades that one to dashboard-only.
- **Dashboard shows the reaction but the contact doesn't** → the wire send fell
  back (bridge down/unreachable). Check the bridge terminal for the error.

## Rollback

**Return to the safe default (no reboot, keeps SIP as-is):** the mock is always
the default — you only get real delivery while the bridge is running and the
runner has `IMESSAGE_PRIVATE_API_ENABLED=true`. To stop sending for real:

1. **Stop the bridge** (Ctrl-C its terminal).
2. Run the app **without** `IMESSAGE_PRIVATE_API_ENABLED` (or just run the mock
   via `npm run mock:imessage-helper`). With no reachable helper the runner
   degrades automatically: replies go out as plain text, tapbacks stay
   dashboard-only. No data or config change needed.

**Fully re-enable SIP (separate, optional):**

1. In BlueBubbles, disable Private API features and quit the app.
2. Stop the bridge and the runner.
3. Boot to Recovery (Step 1) and run:
   ```
   csrutil enable
   ```
4. Reboot. `csrutil status` should report **enabled**. The app keeps working on
   the default mock/fallback path.

---

**Security recap:** SIP off is a real, lasting cost while it's disabled. Keep
this to a machine where that trade-off is acceptable, and re-enable SIP when you
no longer need native delivery.
