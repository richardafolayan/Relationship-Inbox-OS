# Tovi documentation

This is the documentation entry point for the student-pilot baseline. The
behavior described here was verified against `v1/strip-back-pr1` at commit
`fcc4248ba5379b68b1a1f440edf95039d770e74f`. The live branch and build state
remain in [current build status](strategy/current-build-status.md).

The implementation is the final authority when this reference and code
disagree. Run `npm run docs:check` after changing code or documentation.

## User guidance

- [Install on macOS](user/install.md)
- [Use the app](user/guide.md)
- [Quick help for pilot testers](pilot/troubleshooting.md)
- [Pilot test instructions](pilot/student-pilot-instructions.md)

## Operator runbooks

- [Operate and recover the app](operations/runbook.md)
- [Build, update, release, roll back](operations/releases.md)
- [Troubleshooting playbook](troubleshooting/playbook.md)

## Developer reference

- [System architecture](architecture/overview.md)
- [Message lifecycle](architecture/message-lifecycle.md)
- [Repository, workspaces, and module map](developer/repository.md)
- [Current feature inventory](developer/features.md)
- [Platform adapters](developer/platform-adapters.md)
- [Database, migrations, and storage](developer/data-and-storage.md)
- [Configuration and environment variables](developer/configuration.md)
- [AI processing, providers, routing, and voice](developer/ai.md)
- [Tests and verification](developer/testing.md)
- [Architecture decision records](adr/README.md)

## Planning and strategy

- [Current product direction](strategy/current-product-direction.md)
- [Current build status](strategy/current-build-status.md)
- [Windows portability and non-Apple messaging feasibility](strategy/windows-portability.md)
- [Windows pilot install](pilot/windows-install.md)

## Canonical-source rule

Implementation facts should have one home:

| Fact | Canonical page |
| --- | --- |
| Product behavior and feature status | [Current feature inventory](developer/features.md) |
| Component and trust boundaries | [System architecture](architecture/overview.md) |
| Ingest, persist, AI, present, and send flow | [Message lifecycle](architecture/message-lifecycle.md) |
| Platform capabilities | [Platform adapters](developer/platform-adapters.md) |
| Schema, migrations, and disk locations | [Database and storage](developer/data-and-storage.md) |
| Environment variables | [Configuration](developer/configuration.md) |
| Provider selection and voice enforcement | [AI processing](developer/ai.md) |
| Operational commands and recovery | [Operator runbook](operations/runbook.md) |
| Release and rollback procedure | [Release runbook](operations/releases.md) |
| Failure diagnosis | [Troubleshooting playbook](troubleshooting/playbook.md) |

Other pages should link to these rather than restating volatile details.
