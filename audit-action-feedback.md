# Action Feedback Audit — Relationship Inbox OS

Goal: every user-triggered action must surface a visible response (running state, success confirmation, error state). A label flip alone is **not** sufficient (project convention, AGENTS.md §UI changes).

Scope: `apps/dashboard/**` (Next.js frontend). All app routes, layout, and shared components. Backend / runner code paths are excluded.

Conventions used below
- 🟢 fully covered: visible running state + visible success acknowledgement + error state
- 🟡 partial: at least one of {running, success, error} is missing (e.g. label flip + disabled but no success toast)
- 🔴 silent: no visible feedback at all on the happy path (only the page refreshing some data — which an operator may not notice)

Helpers referenced
- `runAction` (`lib/api.ts`) — captures errors into a local `setError` slot only; does **not** show a running or success toast.
- `runActionWithFeedback` (`lib/feedback.ts`) — shows a pending toast, replaces it with a success toast on resolution, and an error toast on rejection. This is the only helper that is fully covered by default.
- `showToast` / `ToastHost` (`components/common/toast-host.tsx`) — the global toast surface; also mirrors selected runner SSE events (`SEND_FAILED`, `SEND_CONFIRMED`).
- `SystemStatusBar` (`components/layout/system-status-bar.tsx`) — passive surface that announces scans/sends/enrichment derived from `/health` polling. Provides indirect feedback for actions that kick off background runner work.

---

## Today (`app/today/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Click hero card → open thread | today/page.tsx:295 | navigation | navigation | — | 🟢 (navigation is feedback) |
| `Open & reply` button | today/page.tsx:343 | navigation | navigation | — | 🟢 (navigation is feedback) |
| `Snooze ’til tomorrow` | today/page.tsx:346 | hero fades + label "Snoozed — next up" via `advanceHero` | hero advances on next refresh | inline `setError` banner | 🟡 — running/success carried by hero transition; no toast, no spinner |
| `Mark as handled` | today/page.tsx:360 | hero fades + label "Handled — next up" via `advanceHero` | hero advances on next refresh | inline `setError` banner | 🟡 — same as above |
| Predraft warm-up (background, top 3 rows) | today/page.tsx:204 | — | — | — | n/a (not user-triggered) |
| Degraded banner `Run selector tests` | today/page.tsx:277 | — | — | only `setError` | 🔴 |

---

## Inbox (`app/inbox/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Search input | inbox/page.tsx:135 | live filter | live filter | — | 🟢 |
| Filter chip (`All`/`Unread`/`Needs reply`/`Genuine`) | inbox/page.tsx:145 | active style | active style | — | 🟢 |
| Platform filter `<select>` | inbox/page.tsx:157 | dropdown | filter applies | — | 🟢 |
| Degraded banner `Run selector tests` | inbox/page.tsx:179 | — | — | only `setError` | 🔴 |
| Degraded banner `Open receipts` | inbox/page.tsx:186 | drawer opens | drawer visible | — | 🟢 |
| Open thread (row click) | thread-row.tsx:36 | navigation | navigation | — | 🟢 |
| Periodic refresh (`setInterval` 10s) | inbox/page.tsx:75 | — | — | — | n/a (not user-triggered) |

---

## Thread view (`app/thread/[id]/page.tsx`)

### Header / toolbar

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Back to today | thread/[id]/page.tsx:1209 | navigation | navigation | — | 🟢 |
| Open profile (header click) | thread/[id]/page.tsx:1218 | drawer opens | drawer visible | — | 🟢 |
| `Reassess` | thread/[id]/page.tsx:1253 | label flip "Reassessing…" + disabled | — (no toast; data refresh) | inline `setError` | 🟡 — label flip only, no success acknowledgement |
| `AI assist` toggle | thread/[id]/page.tsx:1261 | rail expands/collapses | visible state | — | 🟢 |
| `Save draft` | thread/[id]/page.tsx:1269 | — | — | only `setError` | 🔴 silent |
| `Snooze` (open menu) | thread/[id]/page.tsx:1281 | menu opens; lazy "thinking…" | suggestions render or "No clear time hint" | catch swallowed | 🟢 |
| `Mark as handled` (toolbar) | thread/[id]/page.tsx:1301 | — | — | only `setError` | 🔴 silent |
| `Open in {platform}` | thread/[id]/page.tsx:1313 | — | — | only `setError` | 🔴 silent |
| `Rescan` | thread/[id]/page.tsx:1319 | — | — | only `setError` | 🔴 silent |
| `Receipts` | thread/[id]/page.tsx:1323 | drawer opens | drawer visible | — | 🟢 |

### Composer & send

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `Send` | thread/[id]/page.tsx:1945 | optimistic pending bubble + `Loader2` spinner + "sending…" caption | bubble replaced by real message after refresh; SSE `SEND_CONFIRMED` toast | failed bubble + recovery action + retry button + status-bar `send_failed` | 🟢 |
| Cmd/Ctrl-Enter to send (window) | thread/[id]/page.tsx:540 | same as Send | same | same | 🟢 |
| Cmd/Ctrl-Enter to send (composer focus) | thread/[id]/page.tsx:1696 | same as Send | same | same | 🟢 |
| Retry pending send | thread/[id]/page.tsx:698 | bubble flips back to "sending…" with spinner | reconciles via SSE/poll | bubble flips back to failed + new errorMessage | 🟢 |
| Recovery `Grant Messages access` (AUTH_REQUIRED iMessage) | thread/[id]/page.tsx:744 | — | text written into `setError` banner ("Permission reset triggered…") | inline `setError` | 🟡 — success message bypasses toast and reuses the error slot; no spinner/disabled |
| Recovery `Open browser to sign in` (AUTH_REQUIRED) | thread/[id]/page.tsx:756 | — | — | only `setError` | 🔴 silent |
| Recovery `Run selector tests` (SELECTOR_FAIL) | thread/[id]/page.tsx:765 | — | — | only `setError` | 🔴 silent |
| Recovery `Reset session` (PROFILE_LOCKED) | thread/[id]/page.tsx:775 | — | — | only `setError` | 🔴 silent |
| Suggested replies dropdown toggle | thread/[id]/page.tsx:1772 | spinner + "Generating suggestions…" while pending | renders chips | — | 🟢 |
| Pick a suggested reply (chip) | thread/[id]/page.tsx:1808 | composer fills | composer fills | — | 🟢 |
| `Shorten` transform | thread/[id]/page.tsx:1828 | label flip "shortening…" + disabled | composer text replaces in place | inline `setError` | 🟡 — label flip only, no toast / no progress affordance |
| `Make warmer` transform | thread/[id]/page.tsx:1836 | label flip "warming…" + disabled | composer text replaces | inline `setError` | 🟡 — same |
| Voice rewrite (`rewrite in my voice`) | thread/[id]/page.tsx:1741 | label flip "rewriting…" + disabled | composer text replaces; voice meter recomputes | inline `setError` | 🟡 — same |
| Open schedule menu | thread/[id]/page.tsx:1845 | menu opens | menu visible | — | 🟢 |
| Schedule preset (1h / 3h / Tomorrow / Monday) | thread/[id]/page.tsx:1860 | preset row disabled | scheduled-send pill appears in timeline + composer cleared | inline `setError` | 🟢 |
| Custom schedule submit | thread/[id]/page.tsx:1883 | label flip "Scheduling…" + disabled; preset rows disabled | scheduled-send pill appears + composer cleared | inline `setError` (incl. validation) | 🟢 |
| Cancel scheduled send | thread/[id]/page.tsx:1528 | label flip "cancelling…" + disabled | row disappears on refresh | inline `setError` | 🟡 — label flip is the only running indicator; no success toast |
| Begin edit scheduled (`edit`) | thread/[id]/page.tsx:1514 | inline edit mode opens | textarea + datetime input visible | — | 🟢 |
| Save edited scheduled | thread/[id]/page.tsx:1494 | label flip "saving…" + disabled | row re-renders with new text/time | inline `setError` | 🟡 — label flip; no toast |
| Discard scheduled edit | thread/[id]/page.tsx:1502 | exits edit mode | reverts | — | 🟢 |
| Cmd/Ctrl-Enter inside edit | thread/[id]/page.tsx:1469 | same as Save edited | same | same | 🟡 |
| Composer attach (file picker) | thread/[id]/page.tsx:1919 | chip appears in tray | chip visible | — | 🟢 |
| Composer remove attachment | thread/[id]/page.tsx:1968 | chip disappears | chip removed | — | 🟢 |
| Start voice recording | thread/[id]/page.tsx:1928 | mic button turns red + pulses | recording state visible | inline `setError` ("Microphone access denied") | 🟢 |
| Stop voice recording | thread/[id]/page.tsx:1928 | new audio chip appears in tray | chip visible | — | 🟢 |
| Composer textarea input | thread/[id]/page.tsx:1690 | inline (voice meter recomputes) | inline | — | 🟢 |
| Clear AI predraft (`clear`) | thread/[id]/page.tsx:1675 | composer empties | composer empty | — | 🟢 |
| Toggle Memory chip popover | thread/[id]/page.tsx:1616 | popover toggles | visible | — | 🟢 |

### AI compose ("Write in my voice" rail)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `Write` (compose from intent) | thread/[id]/page.tsx:2133 | spinner + "Writing…" + disabled | drafted text renders below in a card | inline `composeError` next to button | 🟢 |
| `Use this` | thread/[id]/page.tsx:2150 | composer fills + draft clears | composer fills | — | 🟢 |
| `try again` | thread/[id]/page.tsx:2155 | re-runs Write (same feedback) | same | same | 🟢 |
| Compose intent textarea input | thread/[id]/page.tsx:2124 | live | live | — | 🟢 |

### Snooze popover (when open)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| AI snooze suggestion chip | thread/[id]/page.tsx:1998 | — (menu just closes) | — | inline `setError` | 🔴 silent |
| Quick snooze `6h` | thread/[id]/page.tsx:2020 | — | — | inline `setError` | 🔴 silent |
| Quick snooze `1d` | thread/[id]/page.tsx:2034 | — | — | inline `setError` | 🔴 silent |

### Right rail / open loops

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Toggle open loop (active) | thread/[id]/page.tsx:2089 | optimistic checkbox flip | persists on success | inline `setError` + rollback via refresh | 🟢 |
| Restore dismissed open loop | thread/[id]/page.tsx:2104 | optimistic checkbox flip | same | same | 🟢 |

### Sibling thread list

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Sibling platform filter `<select>` | thread/[id]/page.tsx:1115 | filter applies | visible | — | 🟢 |
| Sibling thread link | thread/[id]/page.tsx:1137 | navigation | navigation | — | 🟢 |
| Older messages link / auto-prefetch | thread/[id]/page.tsx:1340 | spinner + "loading older messages…" | older bubbles render with scroll restored | inline `setError` | 🟢 |

### Degraded banner inside thread

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `Run selector tests` | thread/[id]/page.tsx:1186 | — | — | only `setError` | 🔴 silent |
| `Open receipts` | thread/[id]/page.tsx:1193 | drawer opens | drawer visible | — | 🟢 |

---

## At-Risk (`app/at-risk/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `reply focus mode` | at-risk/page.tsx:135 | modal opens | modal visible | — | 🟢 |
| Focus modal `close` | at-risk/page.tsx:212 | modal closes | — | — | 🟢 |
| Focus `skip` | at-risk/page.tsx:256 | next thread shown | — | — | 🟢 |
| Focus `mark handled` | at-risk/page.tsx:257 | — (no spinner / disabled) | advances to next thread | inline `focusError` banner | 🟡 — running indicator missing; success implied by advance |
| Focus `open thread →` | at-risk/page.tsx:258 | navigation | navigation | — | 🟢 |
| Open archived thread row | at-risk/page.tsx:154 | navigation | navigation | — | 🟢 |

---

## Archived (`app/archived/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Open thread (row name button) | archived/page.tsx:73 | navigation | navigation | — | 🟢 |
| `Unarchive` | archived/page.tsx:96 | — | — | only `setError` | 🔴 silent |

---

## People (`app/people/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `Scan all` | people/page.tsx:244 | label flip "Queueing…" + disabled | inline status chip "Queued N profile(s) for rescan." | inline `setError` | 🟢 |
| Person row click (expand/collapse) | people/page.tsx:287 | accordion opens | section visible | — | 🟢 |
| Notes textarea input | people/page.tsx:409 | "saving…" caption | "saved" caption | "failed to save" caption | 🟢 |
| `Refresh enrichment` | people/page.tsx:416 | label flip "Refreshing…" + disabled + inline "Fetching profile…" status | inline status "Profile refreshed." (auto-clears 4s) or "Runner is busy — queued…" | inline `setError` banner | 🟢 |
| `Start a conversation` (fetchStarters) | people/page.tsx:430 | label flip "Drafting…" + disabled | starter cards render below | — (silently swallowed by `loadDetail.catch`) | 🟡 — running covered, error not surfaced; success only via rendered cards |
| `open in inbox` | people/page.tsx:436 | navigation | navigation | — | 🟢 |
| Profile URL input | people/page.tsx:353 | live | live | — | 🟢 |
| `Save & enrich` | people/page.tsx:360 | label flip "Saving…" + disabled; chains into `Refresh enrichment` so "Fetching profile…" follows | profile re-renders + enrichStatus toast | inline `setError` | 🟡 — running indicator is label-only; no toast on the save step itself |

---

## Platforms (`app/platforms/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Open browser / Connect | platforms/page.tsx:144 | `runActionWithFeedback` pending toast "Opening …" | success toast "{platform} opened" | error toast + inline `setActionError` | 🟢 |
| Profile details `<details>` summary | platforms/page.tsx:120 | accordion opens | section visible | — | 🟢 |
| More menu — `Scan now` | platforms/page.tsx:166 | pending toast "Scanning …" + status bar `Scanning {platform}` | success toast "{platform} scan queued" | error toast | 🟢 |
| More menu — `Reconnect` | platforms/page.tsx:182 | — | — | only `setActionError` | 🔴 silent |
| More menu — `Run selector tests` | platforms/page.tsx:193 | — | — | only `setActionError` | 🔴 silent |
| More menu — `Reset session…` | platforms/page.tsx:202 | `window.confirm` only | — | only `setActionError` | 🔴 silent |
| `open receipts` (footer) | platforms/page.tsx:270 | drawer opens | drawer visible | — | 🟢 |
| Degraded banner `Run selector tests` | platforms/page.tsx:82 | — | — | only `setActionError` | 🔴 silent |
| Degraded banner `Open receipts` | platforms/page.tsx:89 | drawer opens | drawer visible | — | 🟢 |

---

## Settings (`app/settings/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `Quiet hours` toggle | settings/page.tsx:296 | local-only | `saved` chip in PageHead meta (4s) | — | 🟢 |
| `Auto-scan` toggle | settings/page.tsx:309 | local-only | `saved` chip | — | 🟢 |
| `Headless browser` toggle | settings/page.tsx:318 | button disabled while `saving` | `saved` chip | inline `setError` | 🟡 — disabled state is the only running indicator; no per-row spinner |
| `Demo data` toggle | settings/page.tsx:327 | button disabled while `saving` | `saved` chip | inline `setError` | 🟡 — same |
| About-me / Interests textarea | settings/page.tsx:368, 381 | `saving…` caption | `saved` caption | `failed to save` caption | 🟢 |
| Advanced `<details>` toggle | settings/page.tsx:388 | accordion opens | visible | — | 🟢 |
| Scan interval / Amber / Red / Max msgs `<input>` | settings/page.tsx:402–447 | local-only (no commit until Save settings) | — | — | 🟡 — no indication these are dirty/uncommitted state |
| AI provider selection button | settings/page.tsx:461 | local-only (no commit until Save settings) | active style | — | 🟡 — no acknowledgement these are uncommitted |
| Provider model `<input>` (GLM / Gemini) | settings/page.tsx:515 | local-only | — | — | 🟡 — same |
| Enabled platform toggle | settings/page.tsx:489 | local-only (no commit until Save settings) | active style | — | 🟡 — same |
| `Save settings` | settings/page.tsx:530 | button disabled while `saving` | `saved` chip in PageHead meta (4s) | inline `setError` | 🟡 — disabled is the only running indicator (no label flip, no spinner) |
| `Restart runner` (Settings copy) | settings/page.tsx:548 | `window.confirm` only; then loops `/runner/health` until back | `window.location.reload()` (page reloads) | inline `setError` ("Runner did not come back…") | 🟡 — no spinner / "restarting…" label on this button (the top-strip variant has one) |
| `Reset…` (open danger modal) | settings/page.tsx:563 | modal opens | visible | — | 🟢 |
| Modal `Cancel` | settings/page.tsx:639 | modal closes | — | — | 🟢 |
| Modal `Confirm reset` | settings/page.tsx:647 | label flip "Resetting…" + disabled | inline `resetStatus` success ("LinkedIn inbox cleared. …") + modal closes | inline `resetStatus` error | 🟢 |

---

## Logs / Activity (`app/logs/page.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `open drawer` | logs/page.tsx:60 | drawer opens | drawer visible | — | 🟢 |
| `screenshot` link | logs/page.tsx:106 | new tab | new tab | — | 🟢 |
| `dom` link | logs/page.tsx:116 | new tab | new tab | — | 🟢 |

---

## Layout — Sidebar (`components/layout/sidebar.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Logo link | sidebar.tsx:64 | navigation | navigation | — | 🟢 |
| `Search` (open ⌘K palette) | sidebar.tsx:75 | palette opens | palette visible | — | 🟢 |
| Nav items (Today / Inbox / At Risk / Archived / People / Platforms / Activity / Settings) | sidebar.tsx:86 | navigation | active style + navigation | — | 🟢 |

---

## Layout — Theme toggle (`components/layout/theme-toggle.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Toggle theme (sun/moon) | theme-toggle.tsx:44 | icon swaps | dark/light theme applies on `<html>` | — | 🟢 |

---

## Layout — Command palette (`components/layout/command-palette.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Open palette via ⌘K (also Sidebar Search) | app-shell.tsx:137 | palette opens | palette visible | — | 🟢 |
| Esc closes palette | app-shell.tsx:142 | palette closes | — | — | 🟢 |
| Search input typing | command-palette.tsx:106 | live filter | live filter | — | 🟢 |
| Arrow / Enter selection | command-palette.tsx:77 | active style | runs entry; palette closes | — | 🟢 |
| Page jump entries (Today / Inbox / People / Platforms / Activity / Settings) | command-palette.tsx:42 | navigation | navigation | — | 🟢 |
| `Run scan now` palette entry | command-palette.tsx:50 | — (palette just closes) | — (no toast) | catch swallowed (`.catch(() => undefined)`) | 🔴 silent |
| Thread jump entries | command-palette.tsx:57 | navigation | navigation | — | 🟢 |

---

## Layout — Runner top strip (`components/layout/runner-top-strip.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `Restart runner` | runner-top-strip.tsx:131 | `window.confirm` then label flip "restarting…" + disabled (whole bar polls `/health` until ONLINE) | `window.location.reload()` | inline `restartError` (also rendered as `role="alert"`) | 🟢 |

---

## Layout — System status bar (`components/layout/system-status-bar.tsx`)

This bar is itself a passive feedback surface (announces `Scanning …`, `Sending reply to …`, `Sent to …`, `Failed to send …`, `Enriching …`). It also exposes two action buttons:

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `cancel` (scan or enrichment) | system-status-bar.tsx:252 | label flip "cancelling…" + disabled | bar transitions out of active state on next refresh | console-only (`console.warn`) | 🟡 — label flip + status-bar transition; no error surface to the user |
| `grant access` (iMessage permission reset shortcut) | system-status-bar.tsx:241 | — | — | swallowed (`catch {}`) | 🔴 silent — fire-and-forget fetch with no acknowledgement |

---

## Common — Profile drawer (`components/common/profile-drawer.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Drawer load (open) | profile-drawer.tsx:24 | "Loading…" placeholder | profile renders | inline `setError` | 🟢 |
| `Rescan` | profile-drawer.tsx:94 | label flip "Rescanning…" + spinner + disabled | profile re-renders (data refresh) | inline `setError` | 🟡 — running covered well, no explicit success acknowledgement (toast/banner) |
| Close (×) / overlay click | profile-drawer.tsx:102 | drawer closes | — | — | 🟢 |
| Profile URL input | profile-drawer.tsx:120 | live | live | — | 🟢 |
| `Save & enrich` | profile-drawer.tsx:127 | label flip "Saving…" + disabled (chains into Rescan) | profile re-renders | inline `setError` | 🟡 — running by label only, no success toast |

---

## Common — Receipts drawer (`components/common/receipts-drawer.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Close (×) / overlay click | receipts-drawer.tsx:51 | drawer closes | — | — | 🟢 |
| Screenshot / DOM dump links | receipts-drawer.tsx:78, 88 | new tab | new tab | — | 🟢 |

---

## Common — Degraded banner (`components/common/degraded-banner.tsx`)

The banner re-emits two callback props (`onRunSelectorTests`, `onOpenReceipts`). The component itself exposes both as plain buttons with no inline state — feedback is the responsibility of the caller. Every caller in this codebase wires `onRunSelectorTests` to `runAction` (no toast), so the action is silent at every site (already counted on each page above). The text-link copy of the same callback inside the banner body (line 42) is **also** silent.

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Banner text-link `Run selector tests` | degraded-banner.tsx:42 | — | — | depends on caller (today / inbox / thread / platforms — all silent) | 🔴 silent |
| Banner text-link `Open receipts` | degraded-banner.tsx:53 | drawer opens (caller-driven) | drawer visible | — | 🟢 |
| Banner button `Run tests` | degraded-banner.tsx:92 | — | — | depends on caller | 🔴 silent |
| Screenshot / DOM dump links | degraded-banner.tsx:72, 82 | new tab | new tab | — | 🟢 |

---

## Common — Thread row (`components/common/thread-row.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Row click (open thread) | thread-row.tsx:36 | navigation | navigation | — | 🟢 |

---

## Common — Name suggestion pill (`components/common/name-suggestion-pill.tsx`)

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| Toggle popover (`Maybe …` / pencil) | name-suggestion-pill.tsx:73 | popover opens | popover visible | — | 🟢 |
| `Use {inferredName}` (confirm) | name-suggestion-pill.tsx:122 | buttons disabled (`busy`) | popover closes + parent refresh (row label updates) | swallowed by `try`/`finally` (no `catch`); error surfaces nowhere | 🟡 — running by disabled state; success implicit; **errors silently swallowed** |
| `Edit name…` | name-suggestion-pill.tsx:132 | rename mode | input visible | — | 🟢 |
| `Save` (rename) | name-suggestion-pill.tsx:108 | input disabled (`busy`) | popover closes + parent refresh | error swallowed | 🟡 — running by disabled state; error swallowed |
| `Not this one` (dismiss) | name-suggestion-pill.tsx:143 | buttons disabled | popover closes + parent refresh | error swallowed | 🟡 — same |

---

## Thread — iMessage media (`components/thread/imessage-media.tsx`)

Pure renderer for `<img>/<video>/<audio>/<a>`. No user actions beyond native media controls and link clicks (browser handles state).

---

## App-shell global handlers

| Action | File:line | Running | Success | Error | Severity |
|---|---|---|---|---|---|
| `runner-resync` listener (forces refresh on every page) | app-shell.tsx:107 | — | — | — | n/a |
| Auto-scan poller (every 10 min, when toggled on) | app-shell.tsx:82 | passive: status bar surfaces `Scanning …` when runner picks up | status bar transitions out | swallowed (`.catch`) — no error toast | 🟡 (background, not directly user-triggered) |

---

# Prioritized punch list

Fix these to satisfy the project's "every action button surfaces inline running/success status" rule.

## P0 — silent (🔴) actions: no visible feedback at all

These call `runAction` with only `setError`; on the happy path the operator sees nothing. Most have no spinner, no label change, no toast, no status-bar entry — just a silent network round-trip. Swap to `runActionWithFeedback` (or add explicit running + success surfacing).

1. **Thread › `Save draft`** — thread/[id]/page.tsx:1269
2. **Thread › `Mark as handled` (toolbar)** — thread/[id]/page.tsx:1301
3. **Thread › `Open in {platform}`** — thread/[id]/page.tsx:1313
4. **Thread › `Rescan`** — thread/[id]/page.tsx:1319
5. **Thread › Snooze suggestion chip (AI)** — thread/[id]/page.tsx:1998
6. **Thread › Snooze quick chip `6h`** — thread/[id]/page.tsx:2020
7. **Thread › Snooze quick chip `1d`** — thread/[id]/page.tsx:2034
8. **Thread › Recovery `Open browser to sign in`** — thread/[id]/page.tsx:756
9. **Thread › Recovery `Run selector tests`** — thread/[id]/page.tsx:765
10. **Thread › Recovery `Reset session`** — thread/[id]/page.tsx:775
11. **Today › Degraded banner `Run selector tests`** — today/page.tsx:277
12. **Inbox › Degraded banner `Run selector tests`** — inbox/page.tsx:179
13. **Thread › Degraded banner `Run selector tests`** — thread/[id]/page.tsx:1186
14. **Platforms › Degraded banner `Run selector tests`** — platforms/page.tsx:82
15. **Platforms › More menu `Reconnect`** — platforms/page.tsx:182
16. **Platforms › More menu `Run selector tests`** — platforms/page.tsx:193
17. **Platforms › More menu `Reset session…`** — platforms/page.tsx:202 (has `window.confirm`, but that's input, not feedback)
18. **Archived › `Unarchive`** — archived/page.tsx:96
19. **Command palette › `Run scan now`** — command-palette.tsx:50 (catch is swallowed; palette merely closes)
20. **Status bar › `grant access`** — system-status-bar.tsx:241 (fire-and-forget fetch; permission reset has no acknowledgement either way)

## P1 — partial (🟡) actions where the only feedback is a label flip / disabled state

Convention says label flip alone is **not** sufficient. Add an inline running indicator (spinner) **and** an explicit success surface (toast / status chip / "saved" badge).

21. **Thread › `Reassess`** — thread/[id]/page.tsx:1253 (label only, no success state)
22. **Thread › `Shorten`** — thread/[id]/page.tsx:1828 (label flip only)
23. **Thread › `Make warmer`** — thread/[id]/page.tsx:1836 (label flip only)
24. **Thread › `rewrite in my voice`** — thread/[id]/page.tsx:1741 (label flip only)
25. **Thread › Recovery `Grant Messages access`** — thread/[id]/page.tsx:744 (success message reuses the error slot — confusing)
26. **Thread › Cancel scheduled send** — thread/[id]/page.tsx:1528 (label flip only; no success toast)
27. **Thread › Save edited scheduled send** — thread/[id]/page.tsx:1494 (label flip only; no success toast)
28. **Today › `Snooze ’til tomorrow`** — today/page.tsx:346 (covered by hero transition only; no toast)
29. **Today › `Mark as handled`** — today/page.tsx:360 (covered by hero transition only)
30. **At-risk › Focus modal `mark handled`** — at-risk/page.tsx:257 (no spinner; success implied by advance only)
31. **People › `Start a conversation`** — people/page.tsx:430 (label flip; errors swallowed by `loadDetail.catch`)
32. **People › `Save & enrich`** — people/page.tsx:360 (label flip only; success only via re-render)
33. **Settings › `Headless browser` toggle** — settings/page.tsx:318 (only `saving` disable, global "saved" chip)
34. **Settings › `Demo data` toggle** — settings/page.tsx:327 (same)
35. **Settings › `Save settings`** — settings/page.tsx:530 (no per-button running label/spinner; only global `saved` chip)
36. **Settings › `Restart runner`** — settings/page.tsx:548 (no "restarting…" label; the top-strip variant does have one)
37. **Settings › Scan interval / Amber / Red / Max-msgs inputs** — settings/page.tsx:402–447 (no dirty-state indicator before Save)
38. **Settings › AI provider buttons** — settings/page.tsx:461 (uncommitted; no dirty hint)
39. **Settings › Provider model input** — settings/page.tsx:515 (same)
40. **Settings › Enabled platform toggle** — settings/page.tsx:489 (same)
41. **Profile drawer › `Rescan`** — profile-drawer.tsx:94 (label flip + spinner; no explicit success acknowledgement)
42. **Profile drawer › `Save & enrich`** — profile-drawer.tsx:127 (label flip only; no toast)
43. **Status bar › `cancel`** — system-status-bar.tsx:252 (label flip; errors only `console.warn`)
44. **Name suggestion › `Use {inferredName}`** — name-suggestion-pill.tsx:122 (only disabled state; **errors silently swallowed**)
45. **Name suggestion › `Save` (rename)** — name-suggestion-pill.tsx:108 (only disabled; errors swallowed)
46. **Name suggestion › `Not this one` (dismiss)** — name-suggestion-pill.tsx:143 (only disabled; errors swallowed)

## Cross-cutting recommendations

- **Standardise on `runActionWithFeedback`** for any action that hits `apiPost`. The pending → success/error toast lifecycle covers all three states with one call. Reserve `runAction` for cases where another inline surface (status bar, optimistic UI) already covers running + success.
- **Wire `DegradedBanner` callers consistently.** Today, Inbox, Thread and Platforms all wrap `onRunSelectorTests` in `runAction` (silent on success). Either move `runActionWithFeedback` into the banner itself (component-owned feedback) or fix all four call sites.
- **`NameSuggestionPill` swallows errors** in its private `call` helper (no `catch`). At minimum, surface an inline error so a failed rename/dismiss isn't invisible.
- **Status-bar `grant access` and `cancel`** bypass user feedback (`catch {}` / `console.warn`). Route these through `showToast` so failures aren't invisible.
- **Settings advanced inputs** are committed only by `Save settings`. Without a dirty-state indicator the operator can't tell their edits are uncommitted; add a chip ("unsaved") or auto-save on blur to match the operator-profile / notes pattern that already works well.

---

## Summary

- 🔴 silent: **20** actions
- 🟡 partial: **26** actions
- 🟢 fully covered: ~55 actions (navigation, drawer toggles, send pipeline, toast-based platform actions, debounced text inputs, etc.)

Bringing the 20 silent actions onto `runActionWithFeedback` and giving the 26 partial ones an explicit success acknowledgement (toast or inline status) would bring the dashboard into compliance with the AGENTS.md feedback rule.
