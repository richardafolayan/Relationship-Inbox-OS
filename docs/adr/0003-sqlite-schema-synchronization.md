# ADR 0003: SQLite schema synchronization

Status: Accepted with limitation

## Context

The pilot is local-first and uses one SQLite file. The repository has a Prisma
schema but no committed `packages/core/prisma/migrations/` history.

## Decision

Use Prisma for the schema and client, resolve relative SQLite URLs against the
project root, and apply schema changes with `prisma db push`. The installer,
launcher, and updater run client generation and schema push at controlled
pre-start boundaries. Enable SQLite WAL mode best-effort at runner startup.

## Consequences

- Fresh installs and additive schema changes are simple.
- Historical, ordered, reviewable database migrations do not exist today.
- Destructive or data-transforming schema changes must not be treated as a
  normal `db push`. They require a backup, an explicit migration plan, focused
  tests, and a new ADR or superseding decision.
- `npm run db:migrate` is a developer helper, not the production pilot path.

## Verification

- [`packages/core/prisma/schema.prisma`](../../packages/core/prisma/schema.prisma)
- [`apps/runner/src/config.ts`](../../apps/runner/src/config.ts)
- [`apps/runner/src/db.ts`](../../apps/runner/src/db.ts)
- [`scripts/start-app.mjs`](../../scripts/start-app.mjs)
- [Database and storage](../developer/data-and-storage.md)
