# Current Build Status

_Volatile. Update this whenever branches, commits, or build state change. Last updated: 2026-07-22._

This file holds fast-moving build state on purpose. Branch tips and commit
hashes go stale quickly, so they live here and not in `AGENTS.md`.

## Baseline

- Active baseline branch: `v1/strip-back-pr1`.
- Mobile pilot release correction: `fix/ios-mobile-release`, based on the
  PR #1009 merge at `09bebffc` from `v1/strip-back-pr1`.
- Main release target: `main`.
- Pilot-ready release version: `0.1.16`.
- Release base before the version bump: `2ff0623` (`Merge pull request #795 from richardafolayan/fix/launcher-native-runtime-guard`).
- Mobile pilot integration, protected same-Wi-Fi phone access, and responsive
  phone layouts are merged into the baseline through `371718e1`.
- Voice-preserving dictation formatting is merged into the baseline through
  `73165351`. Dictation remains editable and does not send automatically.
- Active Windows parity track: `feat/google-messages-windows-parity`, based on
  `cb87a39` from `origin/v1/strip-back-pr1`.

## Landed

- Action-items-first thread workspace.
- User voice / identity setup.
- Student pilot feedback loop.
- Bug-hunt hardening: live fixes cherry-picked onto v1.
- Slimmed README, pilot guides, and the in-app feedback intake.
- WhatsApp integration and rich-message handling are present in v1, guarded behind the pilot setup flow.
- Student app update checks and launcher native-runtime rebuild guidance are present.
- iMessage Full Disk Access setup guidance is present.
- Protected same-Wi-Fi phone access and the consolidated responsive mobile UI
  are present.
- Mobile composer and recovery hardening includes secure-context microphone
  capture and silent-recording rejection. On the private HTTP iPhone link,
  dictation uses the iPhone keyboard microphone and existing audio recordings
  can be attached without invoking WebKit's video recorder.
- Dictation can turn a transcript into editable messages while preserving the
  user's wording and voice.
- The mobile reliability branch replaces the crowded inline composer controls
  with phone-sized action sheets, constrains the composer to the iOS visual
  viewport, fixes Safari audio blob creation, and audits every unique dashboard
  route at 390 by 844. The release correction also audits a desktop-width,
  coarse-touch viewport so iPhone never receives the desktop composer toolbar.
- Focus windows can explicitly opt into one saved automatic note per covered
  person. Unknown numbers, group chats, cold outreach, duplicate sends, and
  people already replied to remain excluded.
- Live platform events are promoted ahead of scheduled scan work so new messages
  are persisted as soon as their platform watcher notices them.
- Windows packaging, bundled Node 22 startup, isolated browser profiles,
  WhatsApp, and Windows-safe dictation are present.
- Google Messages for Android is implemented on the Windows parity track with
  account pairing, SMS/MMS/RCS conversation scanning, groups, user-triggered
  text and attachment sends, reactions, and persistent browser sessions.

## Next

- Prepare and run the 3-5 student pilot.
- Only small operational improvements that reduce pilot friction (direct feedback submission, install/readme clarity, setup hardening).
- Pilot-test same-Wi-Fi phone access and responsive phone layouts on the target
  student devices.
- Complete Windows x64 verification: NSIS install, first boot, Google Messages
  pair/scan/send, LinkedIn connect/scan, WhatsApp QR/scan, quit/relaunch, and
  clean iMessage-unavailable UI.

---

_Product direction and the "do not build next" list: [`current-product-direction.md`](./current-product-direction.md)._
