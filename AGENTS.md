# AGENTS.md

Guidance for AI coding agents (Claude Code, remote agents, etc.) working in this repo.

## Current product direction

Relationship Inbox OS is being prepared for a small 3–5 student pilot. It should
feel like a calm place to reply properly — not a dashboard, CRM, marketing tool,
analytics console, or AI ghostwriter.

Product principles:

- Help the user understand what they need to reply to.
- Show what the other person said and what still needs to be addressed.
- Keep the user writing in their own words.
- Full AI drafts stay optional, never the default.
- Sending is always user-triggered.
- Never auto-include private message content in feedback or bug reports.
- Keep the UI calm and low-surface-area.

Live, volatile context lives outside this file — keep it there, not here:

- [`docs/strategy/current-product-direction.md`](docs/strategy/current-product-direction.md) — product direction and the "do not build next" list.
- [`docs/strategy/current-build-status.md`](docs/strategy/current-build-status.md) — current branch, commit, and build state.
- [`docs/handoffs/`](docs/handoffs/) — dated point-in-time snapshots; archives, not live strategy.

## Before building

Before implementing anything, state:

1. What is already solved.
2. Which branch/commit the work is based on.
3. Whether it can run in parallel or must be sequential.
4. Which high-conflict files it touches.
5. Whether the change helps the student pilot directly.

If the task does not help the student pilot directly, pause and say so before building.

## Git branch naming

- Never create branches named `claude/<random-words>`.
- Use conventional prefixes based on intent, kebab-case after the prefix:
  - `feat/<feature-name>` — new features
  - `fix/<bug-name>` — bug fixes
  - `chore/<task>` — tooling, deps, misc
  - `refactor/<scope>` — refactors
  - `docs/<scope>` — documentation

## Commits and PRs

- Do not add `Co-Authored-By: Claude` or any AI/assistant attribution footer to commits or PRs.
- Do not add "Generated with Claude Code" lines to commit messages, PR descriptions, or code comments.
- Tag meaningful milestones with git tags for easy rollback and reference.

## Code style

- Default to no comments. Only add a comment when the *why* is non-obvious (hidden constraint, subtle invariant, workaround for a specific bug).
- Don't explain *what* the code does — well-named identifiers cover that.
- Don't reference the current task, fix, or callers in comments ("added for X flow", "handles issue #123") — that belongs in the PR description.
- No backwards-compatibility shims or `// removed` placeholders for deleted code. If something is unused, delete it.

## UI changes

- Visually verify UI changes in a browser (e.g. via MCP Chrome) before reporting a task complete.
- Action buttons should surface inline running/success status, not just a label flip.

## Project-specific gotchas

- **LinkedIn adapter has two row-extraction paths.** New fields must be wired through both `snapshotStreamingRows` (~line 5505) AND the `ThreadStub` at ~line 7147 — not just `captureThreadRowsSnapshot`.
- **Turbo daemon ignores worktree cwd.** Running `npm run dev` from a git worktree may silently serve files from the main project. If edits aren't appearing, check `lsof` cwd of the dev process.
