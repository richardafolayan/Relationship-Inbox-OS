# AGENTS.md

Guidance for AI coding agents (Claude Code, remote agents, etc.) working in this repo.

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
