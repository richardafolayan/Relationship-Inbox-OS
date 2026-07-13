# Current Product Direction

_Living document. Keep this updated as the direction changes. Last updated: 2026-07-13._

Relationship Inbox OS is being prepared for a small 3-5 student pilot. It should
feel like a calm place to reply properly, not a dashboard, CRM, marketing tool,
analytics console, or AI ghostwriter.

The current pilot baseline is `v1/strip-back-pr1`. Windows Phase 0 is an
explicit parallel track on `feat/windows-phase-0`.

## Product principles

- Help the user understand what they need to reply to.
- Show what the other person said and what still needs to be addressed.
- Keep the user writing in their own words.
- Full AI drafts stay optional, never the default.
- Sending is always user-triggered.
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

Stop adding core product features. Prepare and run the 3-5 student pilot.

Only build small operational improvements that reduce pilot friction, for
example direct feedback submission, install/readme clarity, or setup hardening.

## Windows Phase 0

Pursue the smallest Windows pilot milestone in parallel: package and boot Tovi
on Windows with LinkedIn and WhatsApp, with iMessage clearly unavailable. Do
not pull Google Messages or Windows auto-update into this phase.

---

_Current build state: [`current-build-status.md`](./current-build-status.md)._

_Evidence / full point-in-time snapshot: [`docs/handoffs/2026-05-21-relationship-inbox-os-current-state.md`](../handoffs/2026-05-21-relationship-inbox-os-current-state.md)._
