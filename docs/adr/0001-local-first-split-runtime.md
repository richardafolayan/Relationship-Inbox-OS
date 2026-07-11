# ADR 0001: Local-first split runtime

Status: Accepted

## Context

The product reads private conversations from local platform state, needs
browser and macOS automation, and should work without a hosted application
backend. The UI still benefits from a browser rendering model.

## Decision

Run four bounded parts:

- a Next.js dashboard for presentation and explicit user actions;
- a loopback Express runner for integrations, AI, persistence, and operations;
- a shared core package for contracts and pure logic;
- an optional Electron shell or source-install launcher for desktop startup.

Keep user data in a local SQLite database and local runtime directories. Bind
the runner to loopback by default.

## Consequences

- Platform credentials and private databases do not need a hosted service.
- The dashboard must treat runner unavailability as a normal recoverable
  condition.
- A remote runner would need authentication and transport security that the
  current system does not supply.
- Launch, update, and permission behavior differs between source installs and
  the packaged Electron build and must be tested separately.

## Verification

- [`apps/dashboard`](../../apps/dashboard)
- [`apps/runner`](../../apps/runner)
- [`apps/desktop`](../../apps/desktop)
- [`packages/core`](../../packages/core)
- [`scripts/start-app.mjs`](../../scripts/start-app.mjs)
