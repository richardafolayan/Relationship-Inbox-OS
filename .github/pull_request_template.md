<!--
PR title format: <type>(<scope>): <description>

Types: feat, fix, refactor, perf, docs, chore, test, build, ci, revert
Scopes (suggested): runner, dashboard, core, schema, scan, send, ai
Add ! after type for breaking changes (e.g. feat!: ...)
Reference issues with "Closes #N" or "Fixes #N" in the body.

Examples:
  feat(runner): add Z.AI provider toggle
  fix(dashboard): preserve paragraph breaks in message body
  refactor(scan-queue): extract candidate filter
-->

## Summary

<!-- 1-3 sentences. What changed and why. Imperative voice. -->

## Context

<!-- Background and what problem this solves. Skip for trivial changes. Link the originating prompt or issue if useful. -->

## Approach

<!-- How the change works at a high level. Note any non-obvious decisions and what was deliberately left out. -->

## Testing

<!-- How this was verified. Specific commands or manual checks. -->

## Screenshots

<!-- For UI changes. Before / after where relevant. -->

## Risk and rollback

<!-- What could break, how to revert. Required for schema changes or anything touching the runner's hot path. Skip for trivial PRs. -->

## Out of scope

<!-- Things deliberately not addressed in this PR. Helps reviewers know what to ignore. Optional. -->

## Checklist

- [ ] Title follows Conventional Commits format
- [ ] Schema changes include a Prisma migration
- [ ] No secrets in code or commit history
- [ ] AI-generated content passes voice rules (no em dashes or semicolons)
- [ ] Phase dependencies respected
- [ ] Existing scan and send flows still work
