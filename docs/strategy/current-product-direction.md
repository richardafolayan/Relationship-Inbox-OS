# Current Product Direction

_Living document. Keep this updated as the direction changes. Last updated: 2026-08-23._

Tovi is being prepared for a small 3-5 student pilot. It should
feel like a calm place to reply properly, not a dashboard, CRM, marketing tool,
analytics console, or AI ghostwriter.

The current development and integration baseline is `develop`. Normal feature
work branches from `develop` and returns through a pull request. `main` is the
stable production and release branch, promoted separately from `develop` only
when the combined development state is ready to ship. The retired
`v1/strip-back-pr1` branch must not be recreated or targeted.

## Product principles

- Help the user understand what they need to reply to.
- Show what the other person said and what still needs to be addressed.
- Keep the user writing in their own words.
- Full AI drafts stay optional, never the default.
- Sending is user-triggered by default. The sole pilot exception is an explicit,
  per-window opt-in for one saved focus note per covered person.
- Never auto-include private message content in feedback or bug reports.
- Keep the UI calm and low-surface-area.

## Do not build next

Do not build any of these unless explicitly instructed:

- WhatsApp expansion beyond the committed Windows Phase 0 track
- People CRM
- At Risk dashboard
- analytics dashboard
- relationship scoring
- public launch
- paid product
- Lead OS crossover
- animation polish
- broad platform expansion

## Build next

Stop adding core product features unless Richard explicitly authorises an
exception. Prepare and run the 3-5 student pilot.

Only build small operational improvements that reduce pilot friction, for
example direct feedback submission, install/readme clarity, or setup hardening.

Correctness currently takes priority over performance and feature work. Tovi is
not pilot-ready until all of the following are true:

- No known path can unexpectedly send or duplicate a real message.
- A completely clean signed install launches successfully.
- Failed or reordered setup writes cannot create false state.
- Recovered composer state faithfully represents the user's intended send.
- Existing databases upgrade through every new integrity constraint.
- Instagram integration is resolved and its shared paths are reverified.
- Physical iPhone/PWA critical flows have been checked.

Treat `chore/full-product-hardening` and its immutable
`qa/full-product-hardening-2026-08-21` tag as evidence, not an integration
branch. Use the adversarial errata under `docs/qa/` to drive small corrective
branches. Do not begin the broad resume-to-trustworthy-fresh-state programme
until this gate is clear.

## Windows pilot parity

Package and boot Tovi on Windows with Google Messages, LinkedIn, and WhatsApp.
Google Messages supplies Android SMS, MMS, and RCS through a user-paired web
session. iMessage and macOS Contacts birthday sync remain clearly unavailable
because they depend on Apple-only local services. The focus-note exception uses
the same per-window opt-in and safety rules on every supported platform.

---

_Current build state: [`current-build-status.md`](./current-build-status.md)._

_Evidence / full point-in-time snapshot: [`docs/handoffs/2026-05-21-relationship-inbox-os-current-state.md`](../handoffs/2026-05-21-relationship-inbox-os-current-state.md)._
