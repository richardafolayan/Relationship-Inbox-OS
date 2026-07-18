# Current Build Status

_Volatile. Update this whenever branches, commits, or build state change. Last updated: 2026-07-18._

This file holds fast-moving build state on purpose. Branch tips and commit
hashes go stale quickly, so they live here and not in `AGENTS.md`.

## Baseline

- Active baseline branch: `v1/strip-back-pr1`.
- Main release target: `main`.
- Pilot-ready release version: `0.1.15`.
- Release base before the version bump: `2ff0623` (`Merge pull request #795 from richardafolayan/fix/launcher-native-runtime-guard`).
- Active mobile experience track: `feat/mobile-app-experience`, based on
  `bb5f45ff` from `origin/v1/strip-back-pr1`.
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
- Windows packaging, bundled Node 22 startup, isolated browser profiles,
  WhatsApp, and Windows-safe dictation are present.
- Google Messages for Android is implemented on the Windows parity track with
  account pairing, SMS/MMS/RCS conversation scanning, groups, user-triggered
  text and attachment sends, reactions, and persistent browser sessions.

## Next

- Prepare and run the 3-5 student pilot.
- Only small operational improvements that reduce pilot friction (direct feedback submission, install/readme clarity, setup hardening).
- Land and pilot-test protected same-Wi-Fi phone access and the responsive phone
  layouts.
- Complete Windows x64 verification: NSIS install, first boot, Google Messages
  pair/scan/send, LinkedIn connect/scan, WhatsApp QR/scan, quit/relaunch, and
  clean iMessage-unavailable UI.

---

_Product direction and the "do not build next" list: [`current-product-direction.md`](./current-product-direction.md)._
