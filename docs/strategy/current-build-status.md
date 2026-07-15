# Current Build Status

_Volatile. Update this whenever branches, commits, or build state change. Last updated: 2026-07-13._

This file holds fast-moving build state on purpose. Branch tips and commit
hashes go stale quickly, so they live here and not in `AGENTS.md`.

## Baseline

- Active baseline branch: `v1/strip-back-pr1`.
- Main release target: `main`.
- Pilot-ready release version: `0.1.14`.
- Release base before the version bump: `2ff0623` (`Merge pull request #795 from richardafolayan/fix/launcher-native-runtime-guard`).
- Parallel Windows track: `feat/windows-phase-0`, based on portability decision commit `5fa2e5c`.

## Landed

- Action-items-first thread workspace.
- User voice / identity setup.
- Student pilot feedback loop.
- Bug-hunt hardening: live fixes cherry-picked onto v1.
- Slimmed README, pilot guides, and the in-app feedback intake.
- WhatsApp integration and rich-message handling are present in v1, guarded behind the pilot setup flow.
- Student app update checks and launcher native-runtime rebuild guidance are present.
- iMessage Full Disk Access setup guidance is present.

## Next

- Prepare and run the 3-5 student pilot.
- Only small operational improvements that reduce pilot friction (direct feedback submission, install/readme clarity, setup hardening).
- Complete Windows Phase 0 verification on Windows x64: NSIS install, first boot, LinkedIn connect/scan, WhatsApp QR/scan, user-triggered send, quit/relaunch, and clean iMessage-unavailable UI.

---

_Product direction and the "do not build next" list: [`current-product-direction.md`](./current-product-direction.md)._
