# Windows portability and non-Apple messaging feasibility

Status: Windows pilot implemented. It answers pilot feedback R-0111 (issue 847): can Tovi run on Windows,
and if iMessage cannot come along, can Android messages, WhatsApp, and
LinkedIn stand in?

Scope note: the Windows pilot supports Google Messages, WhatsApp, and LinkedIn
with iMessage cleanly unavailable.

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
- The Windows pilot ships as a per-user NSIS installer with a bundled Node 22
  runtime. Its Windows CI build verifies `better-sqlite3`, the win32 ONNX
  Runtime payload, and a packaged runner/dashboard startup.
- LinkedIn uses an isolated Patchright profile on Windows. Personal-mode
  Chrome cookie mirroring remains macOS-only because Windows Chrome uses
  app-bound cookie encryption.
- Browser-recorded dictation already produces 16 kHz mono PCM WAV. The runner
  now recognizes that shape directly, so the Windows pilot does not shell out
  to `afconvert` for compose dictation.

## What already runs cross-platform

| Component | Runtime | Windows readiness |
| --- | --- | --- |
| Dashboard | Next.js in Electron renderer | Portable. No OS-specific code in the render path. |
| Runner | Node service | Portable except for the shell-outs listed below. |
| AI processing | Cloud providers (`openai`, `gemini`, `glm`) | Portable. Provider selection is in [`ai-providers.ts`](../../apps/runner/src/services/ai-providers.ts); no local model is required for text. |
| LinkedIn | Patchright/Playwright browser | Portable in isolated mode. Windows pilots sign in once in Tovi's dedicated browser profile; personal-mode cookie mirroring is macOS-only. |
| WhatsApp | `whatsapp-web.js` and its Puppeteer | Portable. QR/linked-device auth has no OS dependency. |
| Google Messages | Patchright browser adapter | Portable. Google-account pairing provides Android SMS, MMS, and RCS conversations, groups, attachments, and reactions. |
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
- Live dictation encodes 16 kHz mono PCM WAV in the browser, then passes
  through the runner's local provider. The runner validates that WAV shape
  and uses it directly on every OS. This keeps the default compose-dictation
  path independent of `afconvert`.
- Nonconforming audio still uses `afconvert` on macOS. That fallback is tied
  to iMessage attachments, which are not available on Windows.

### Packaging

- There is no `electron-builder`. Packaging is a custom
  [`build-macos-dmg.mjs`](../../scripts/build-macos-dmg.mjs) plus
  [`create-macos-app-bundle.mjs`](../../scripts/create-macos-app-bundle.mjs),
  and the updater channel publishes a `.dmg`. There is no `.exe`/NSIS target.
- The Windows pilot uses `electron-builder` with an x64 NSIS target while the
  existing macOS scripts remain unchanged. The installer bundles Node 22 and
  is built natively on `windows-latest` so Node native modules match the
  runtime used by the runner.

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

1. Google Messages for web (implemented). `messages.google.com/web` pairs with
   the Android phone through the same Google account and may ask the user to
   confirm matching emoji. The adapter reads recent and unread conversations,
   normalizes one-to-one and group messages, sends text and attachments only
   after the user presses Send, verifies the resulting bubble, and supports
   message reactions. It follows the existing
   [`PlatformAdapter`](../../packages/core/src/adapters.ts) contract and keeps
   its browser profile across restarts.
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

`better-sqlite3`, `onnxruntime-node`, and any optional `whisper.cpp` build are
native. The installer is built on Windows with Node 22 and deliberately does
not rebuild dependencies for Electron's ABI, because the runner loads them
from the bundled Node process. CI verifies the packaged `better-sqlite3`
binary loads and that the `win32-x64` ONNX Runtime binding is present.

## Suggested phasing

This is a recommendation, not a commitment. Each phase is independently
shippable and independently valuable.

- Phase 0, complete for the pilot. The desktop shell uses Windows storage and
  logs, bundles Node 22, installs through NSIS, enables WhatsApp, uses an
  isolated LinkedIn browser profile, and presents iMessage as unavailable.
- Phase 1, complete for compose dictation. Browser-recorded WAV is consumed
  directly by the local transformers/ONNX provider on Windows.
- Phase 2, complete on the parity track. Google Messages for Android includes
  selector registry, identity, parse, send verification, reactions,
  attachments, setup, filters, and persistent pairing.
- Phase 3, polish. Windows auto-update through the packaging track, contact
  name resolution from platform data in the absence of AddressBook, and
  Windows-specific QA.

## Risks and open questions

- Capability-aware UI. iMessage must present as unavailable (not degraded) on
  Windows. The adapter gate exists; the UI copy and platform list need a
  distinct "not supported on this OS" state so a Windows user is not told to
  grant Full Disk Access for a feature that cannot exist.
- Windows LinkedIn intentionally uses an isolated profile. Supporting Chrome
  personal-mode cookies would require a Windows app-bound cookie strategy and
  is not required for the pilot.
- Google Messages and WhatsApp both tie the inbox to a phone that must stay
  online. Two phone-paired platforms plus a browser platform is more moving
  parts for a single user to keep connected.
- Support and QA surface roughly doubles: a second OS, a second installer, a
  second auto-update path, and native rebuilds for a new ABI.
- Google Messages on the web can display quoted replies but cannot create a
  new quoted reply. Tovi does not claim or emulate that missing web action.

## Recommendation

Use the Windows pilot installer to validate Google Messages, WhatsApp,
LinkedIn, reply review, user-triggered sending, and compose dictation with
Windows students. Keep iMessage and macOS Contacts clearly unavailable rather
than suggesting there is a Windows permission that can enable them.
