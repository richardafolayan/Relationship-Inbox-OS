# Windows portability and non-Apple messaging feasibility

Status: Exploration. This is a decision-support document, not an accepted
plan. It answers pilot feedback R-0111 (issue 847): can Tovi run on Windows,
and if iMessage cannot come along, can Android messages, WhatsApp, and
LinkedIn stand in?

Scope note: nothing here changes product direction. The current baseline
stays macOS-only until a Windows track is explicitly committed. This page
exists so that commitment can be made with real numbers instead of guesses.

## TL;DR

- A Windows build is feasible and most of the runtime is already portable.
  The dashboard (Next.js), the runner (Node), the AI providers (cloud), and
  the two browser-driven platforms (LinkedIn via Playwright, WhatsApp via
  `whatsapp-web.js`) carry no macOS assumption.
- iMessage cannot follow. It reads the local `chat.db` and sends through
  AppleScript, both macOS-only. On Windows it is simply absent, and the code
  already gates it behind `process.platform === "darwin"`, so its absence is
  a configuration state, not a rewrite.
- The realistic iMessage stand-in for an Android user is Google Messages for
  web, driven through the same browser-automation adapter pattern that
  already backs LinkedIn and the beta platforms. It is a genuine build, but
  it fits the existing [platform adapter boundary](../adr/0002-platform-adapter-boundary.md)
  rather than fighting it.
- The two real engineering costs are packaging (there is no Windows
  installer today) and a small number of macOS shell-outs used for audio and
  image transcoding. Neither is large in isolation. The Android adapter is
  the largest single piece of new work.
- Recommended sequencing is boot-on-Windows first (WhatsApp plus LinkedIn,
  no iMessage), then a Google Messages adapter, rather than trying to ship
  everything at once.

## What already runs cross-platform

| Component | Runtime | Windows readiness |
| --- | --- | --- |
| Dashboard | Next.js in Electron renderer | Portable. No OS-specific code in the render path. |
| Runner | Node service | Portable except for the shell-outs listed below. |
| AI processing | Cloud providers (`openai`, `gemini`, `glm`) | Portable. Provider selection is in [`ai-providers.ts`](../../apps/runner/src/services/ai-providers.ts); no local model is required for text. |
| LinkedIn | Patchright/Playwright browser | Portable. Chromium is cross-platform; personal-mode Chrome mirroring needs a Windows Chrome path check. |
| WhatsApp | `whatsapp-web.js` and its Puppeteer | Portable. QR/linked-device auth has no OS dependency. |
| SQLite storage | `better-sqlite3` | Portable native module; needs a per-platform prebuild (see native modules below). |
| Local Whisper (optional) | `whisper.cpp` CLI | `whisper.cpp` builds on Windows; the WAV pre-step needs a non-Apple converter (see audio below). |

The [platform adapter boundary](../developer/platform-adapters.md) is the
reason this list is short. Scan and send are already platform-neutral, so a
host that lacks iMessage still has a fully working inbox for the browser
platforms.

## What is macOS-locked today

Each item below is a concrete dependency with its source location and the
Windows path forward.

### iMessage adapter (chat.db plus AppleScript)

- Reads `~/Library/Messages/chat.db` with `better-sqlite3` and sends through
  `osascript`/Messages. Sources: [`imessage-adapter.ts`](../../apps/runner/src/platforms/imessage-adapter.ts),
  [`imessage-db.ts`](../../apps/runner/src/platforms/imessage-db.ts),
  [`imessage-send.ts`](../../apps/runner/src/platforms/imessage-send.ts).
- Already gated. In [`config.ts`](../../apps/runner/src/config.ts) the adapter
  is enabled only when `IMESSAGE_ENABLED=true` and
  `process.platform === "darwin"`. The boot probe, watcher, and attachment
  server all key off the same gate.
- Windows path: none. iMessage does not exist off Apple platforms. On Windows
  it stays disabled and the UI must present it as unavailable rather than
  degraded. See the capability-awareness note under Risks.

### AddressBook contact and birthday sync

- Reads the macOS AddressBook `.abcddb` files. Source:
  [`addressbook-db.ts`](../../apps/runner/src/platforms/addressbook-db.ts),
  wired in [`config.ts`](../../apps/runner/src/config.ts) behind
  `process.platform === "darwin"`.
- Windows path: no direct equivalent. Contact names on Windows would come
  from the messaging platforms themselves (WhatsApp saved-contact names,
  LinkedIn profile names, Google Messages contact labels) rather than a
  system address book. Birthday sync would be macOS-only for the foreseeable
  future.

### Audio and image transcoding shell-outs

- `afconvert` and `sips` are Apple binaries used to transcode iMessage voice
  notes and images, and to produce the 16 kHz mono WAV that `whisper.cpp`
  needs. Sources: [`imessage-attachment-server.ts`](../../apps/runner/src/services/imessage-attachment-server.ts)
  (`convertAudioToWhisperWav`, image conversion) and
  [`imessage-send.ts`](../../apps/runner/src/platforms/imessage-send.ts).
- Nuance: most of this is entangled with iMessage attachments, which are
  macOS-only anyway. Live dictation encodes its WAV in the browser before it
  reaches the runner, so the primary voice-compose path does not depend on
  `afconvert`. The server-side `convertToWav` fallback in the local-whisper
  and transformers providers is the only general-purpose use.
- Windows path: replace the WAV fallback with a bundled `ffmpeg` (or a WASM
  encoder) behind the same `convertToWav` seam the providers already accept.
  The image/voice-note transcoding can stay macOS-only because it only ever
  runs against iMessage content.

### Packaging (DMG only, no Windows installer)

- There is no `electron-builder`. Packaging is a custom
  [`build-macos-dmg.mjs`](../../scripts/build-macos-dmg.mjs) plus
  [`create-macos-app-bundle.mjs`](../../scripts/create-macos-app-bundle.mjs),
  and the updater channel publishes a `.dmg`. There is no `.exe`/NSIS target.
- Windows path: add a Windows packaging track. The lowest-risk option is to
  adopt `electron-builder` with an NSIS target for Windows while leaving the
  existing mac scripts in place, rather than porting the bespoke DMG builder.
  This also gives Windows auto-update a supported path instead of hand-rolling
  one. Estimated as the second-largest piece of work after the Android
  adapter.

### Desktop shell and permission flows

- [`main.cjs`](../../apps/desktop/main.cjs) hard-codes macOS locations
  (`~/Library/Logs`, `~/Library/Messages/chat.db`) and opens macOS Full Disk
  Access and Automation panes via `x-apple.systempreferences:` URLs.
  [`launcher.cjs`](../../apps/desktop/launcher.cjs) seeds a macOS `PATH`.
- Windows path: branch the log/data locations by platform (`%APPDATA%` on
  Windows), and skip the Full Disk Access / Automation guidance entirely
  because Windows has no equivalent gate for the browser platforms. There is
  no TCC on Windows, so the whole permission-onboarding surface collapses to
  almost nothing when iMessage is absent.

## Replacing iMessage for an Android user

The pilot specifically asks whether "messages from an Android could work."
Options, best fit first.

1. Google Messages for web (recommended). `messages.google.com/web` pairs
   with the phone by QR, exactly like WhatsApp web, and exposes SMS/RCS
   conversations in a DOM we can drive. This fits the existing browser
   adapter pattern (LinkedIn, Instagram/TikTok beta) and the
   [`PlatformAdapter`](../../packages/core/src/adapters.ts) contract: read
   recent threads, normalize messages, send text, verify the sent bubble. It
   needs a new selector registry entry and identity/parse/send tests, per
   [ADR 0002](../adr/0002-platform-adapter-boundary.md). This is the single
   largest new build in a Windows track, but it is well-trodden ground here.
2. Android Debug Bridge or a companion app. Reading the phone's SMS database
   over ADB, or shipping a paired Android app, would be more faithful but is
   a heavy, fragile, support-intensive path with a much larger consent and
   setup burden. Not recommended for a pilot.
3. Native RCS or carrier APIs. No usable local API exists for a desktop app.
   Not viable.

Google Messages for web has the same structural caveat as WhatsApp: it
depends on the phone staying online and paired, and on a DOM that Google can
change. Those are the accepted tradeoffs already documented for the
browser-driven platforms.

## Native modules

`better-sqlite3` and any `whisper.cpp` build are native and must be compiled
or prebuilt for `win32-x64` (and ideally `win32-arm64`). The mac build
already handles native rebuilds during packaging; the Windows track needs the
same step in its installer pipeline. This is routine for `electron-builder`
but must be planned for, because a mismatched ABI is the most common
first-run failure on a new platform.

## Suggested phasing

This is a recommendation, not a commitment. Each phase is independently
shippable and independently valuable.

- Phase 0, boot on Windows. Branch the desktop shell paths and permission
  flows by platform, add a Windows packaging target (`electron-builder`
  NSIS), and confirm the app launches with WhatsApp and LinkedIn working and
  iMessage cleanly absent. No new platform code. This alone answers most of
  the pilot's question and is the smallest useful milestone.
- Phase 1, portable voice. Swap the server-side WAV fallback to a bundled
  cross-platform converter so dictation and local Whisper work off macOS.
  Small, isolated, behind an existing seam.
- Phase 2, Android messages. Build the Google Messages for web adapter as a
  new browser platform: selector registry, identity, parse, send, and
  verification tests, dashboard connect flow with QR. This is the large one.
- Phase 3, polish. Windows auto-update through the packaging track, contact
  name resolution from platform data in the absence of AddressBook, and
  Windows-specific QA.

## Risks and open questions

- Capability-aware UI. iMessage must present as unavailable (not degraded) on
  Windows. The adapter gate exists; the UI copy and platform list need a
  distinct "not supported on this OS" state so a Windows user is not told to
  grant Full Disk Access for a feature that cannot exist.
- Personal-mode Chrome mirroring for LinkedIn assumes a discoverable Chrome
  profile path; the Windows profile location differs and needs its own probe.
- Google Messages and WhatsApp both tie the inbox to a phone that must stay
  online. Two phone-paired platforms plus a browser platform is more moving
  parts for a single user to keep connected.
- Support and QA surface roughly doubles: a second OS, a second installer, a
  second auto-update path, and native rebuilds for a new ABI.
- None of this is on the committed roadmap. Opening a Windows track is a
  prioritization decision, not a technical blocker.

## Recommendation

Windows is achievable and the runtime is largely ready. If a Windows track is
opened, start with Phase 0 (boot on Windows with the browser platforms, no
iMessage) to validate demand cheaply, then decide on the Google Messages
adapter (Phase 2), which is where the real cost sits. Until that commitment
is made, this document is the record of what it would take.
