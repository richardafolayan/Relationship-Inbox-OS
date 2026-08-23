# Domain Docs

How the engineering skills should consume this repository's domain documentation.

## Configured layout

This is a **multi-context repository**. Its independently operated applications or workspace packages may develop separate domain vocabularies. A root `CONTEXT-MAP.md`, when one exists, is the index to context-specific `CONTEXT.md` files.

Do not create empty glossary or ADR files merely to satisfy the layout. Create them lazily when a real term or durable decision is resolved.

## Before exploring, read these

- `CONTEXT-MAP.md` at the repository root, when present.
- Every context-specific `CONTEXT.md` relevant to the work.
- `docs/adr/` for system-wide decisions.
- Context-local `docs/adr/` directories for decisions scoped to that context.

If any of these files do not exist, proceed silently.

## Use the glossary's vocabulary

When output names a domain concept in an issue, refactor, hypothesis or test, use the canonical term from the relevant `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a concept is absent, either reconsider whether it belongs to the project language or note the gap for `domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface that conflict explicitly instead of silently overriding the decision.
