# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the connected GitHub app first when it supports the operation, with the `gh` CLI as the fallback.

## Conventions

- **Create an issue**: create one GitHub issue with a clear title and complete body.
- **Read an issue**: read the full body, labels and comments.
- **List issues**: filter by state and label as the task requires.
- **Comment on an issue**: add a normal GitHub issue comment.
- **Apply / remove labels**: use the repository's existing label vocabulary.
- **Close**: leave any required resolution context, then close the issue.

Infer the repository from the Git remote when using `gh`.

## Pull requests as a request surface

**PRs as a request surface: no.**

Pull requests are delivery artifacts, not an intake queue for feature requests or triage.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read the referenced GitHub issue's full body, labels and comments.

## Wayfinding operations

Used by `wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding Notes, Decisions so far and Fog.
- **Child ticket**: a GitHub sub-issue where available. Otherwise add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling` or `wayfinder:task`.
- **Blocking**: use GitHub's native issue dependencies where available. Otherwise put `Blocked by: #<n>, #<n>` at the top of the child body.
- **Frontier**: open children with no open blocker and no assignee.
- **Claim**: assign the issue to the driving developer before work.
- **Resolve**: comment with the answer, close the ticket, then append a short linked context pointer to the map's Decisions so far.
