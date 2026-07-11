# V1 code quality audit

Date: 2026-07-10

Base: `origin/v1/strip-back-pr1` at `fcf51204a5642e5ca123c075e921e33f5e1ae2d1`

Scope: issue #804. This audit looks for code-quality risks without changing
verified product behaviour or entering files owned by #801, #802, #803, #806,
or #808.

## Method

- Ranked findings on a 1 to 5 scale, where 5 is highest.
- Counted TypeScript and JavaScript module sizes across `apps`, `packages`,
  `scripts`, and `tests`.
- Searched for repeated parsing, normalisation, error conversion, weak typing,
  compatibility paths, and duplicated wire contracts.
- Compared the core and dashboard iMessage system-event matchers directly.
- Scanned 293 TypeScript and JavaScript files for cycles between relative static
  imports. This found no cycles. The scan does not claim coverage of runtime
  dynamic imports or package alias resolution.
- Inspected the active workstream issues, comments, exact remote branches, open
  pull requests, and local worktrees before selecting an implementation area.

## Ranked findings

| Rank | Finding | Risk | Duplication | Complexity | Maintainability | Likely benefit | Decision |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | Platform ingestion is concentrated in `linkedin-adapter.ts` (10,240 lines), `runner/index.ts` (7,681), and `scan-queue.ts` (3,953). Platform state, persistence, retry, acknowledgement, and row shaping have broad hidden coupling. | 5 | 4 | 5 | 5 | 5 | Defer. #802 owns adapters, watchers, scan triggers, propagation, and acknowledgement. Splitting these before its behaviour stabilises would create unsafe stacked work. |
| 2 | The dashboard has a 71-line copy of the canonical 96-line iMessage system-event matcher. A drifted false positive can silently hide a real inbound message from the thread while the runner keeps it, or vice versa. The duplication exists because the core root export reaches `node:crypto`. | 5 | 5 | 2 | 5 | 5 | Fix now through a browser-safe package subpath and a thin dashboard re-export. Preserve the canonical implementation and its tests unchanged. |
| 3 | `app/thread/[id]/page.tsx` is 5,400 lines and owns fetching, filtering, reply state, AI state, composer behaviour, and rendering. Changes have a wide regression surface. | 5 | 3 | 5 | 5 | 4 | Defer. #801 owns interaction work and #808 owns AI output behaviour. A safe split needs their functional changes to settle first. |
| 4 | `services/ai.ts` is 4,022 lines and combines prompt preparation, parsing, fallbacks, provider racing, compatibility mapping, and product-level output rules. | 5 | 3 | 5 | 5 | 4 | Defer entirely to #808, which owns prompts, providers, evaluators, fallbacks, and shared AI types. |
| 5 | Stored JSON handling has inconsistent failure contracts. There are 48 direct `JSON.parse` calls against `*Json` fields in runner request and service paths even though `utils/json.ts` defines the fail-safe contract used elsewhere. Some call sites intentionally fail hard, while others can turn one corrupt row into a route failure. | 4 | 4 | 3 | 4 | 4 | Defer by ownership area. Characterise each route before changing failure semantics. Do not mechanically replace parses whose corruption should remain fatal. |
| 6 | Error normalisation is repeated at least 110 times as local `instanceof Error` and `String(error)` branches. Callers disagree on message, code, cause, stack, and fallback treatment. | 4 | 5 | 3 | 4 | 4 | Defer. A shared error contract would touch sync, desktop diagnostics, AI providers, and UI recovery paths owned by active workstreams. Introduce it only with route-level characterisation tests. |
| 7 | Overdue-digest wire types are declared in both `packages/core/src/overdue-digest.ts` and `apps/dashboard/lib/overdue-digest.ts`, despite core already being the shared contract package. | 3 | 4 | 2 | 4 | 3 | Defer. The dashboard copy also owns scheduler and acknowledgement behaviour inside #801's runtime surface. Consolidate after that workstream stabilises. |
| 8 | `conversation-starters.ts` contains a private `safeJsonParse` equivalent to `runner/src/utils/json.ts`, plus its own canonical object hashing. | 3 | 3 | 2 | 3 | 3 | Defer to #808 because the service feeds AI output and cache behaviour. Existing coverage does not isolate corrupt cached enrichment rows well enough for a no-risk change. |
| 9 | Compatibility branches remain across autoscan settings, selector migration, cached AI shapes, iMessage send keys, thread identity, and digest dates. Their comments describe real persisted-data migrations, but expiry conditions are not recorded. | 4 | 2 | 4 | 4 | 3 | Do not remove. Prove pilot data and release upgrade paths no longer require each branch, then remove in a migration-specific change with fixtures. |
| 10 | Weak typing is concentrated at external boundaries: five explicit `any` handlers in the LinkedIn adapter and several `as unknown as` casts around optional browser and platform APIs. | 3 | 2 | 3 | 3 | 3 | Defer platform casts to #802. The browser compatibility casts are narrow and do not justify a standalone rewrite. |

## Selected change

Use `@inbox-os/core/imessage-system-events` as the single browser-safe source
of the iMessage non-content matcher. Keep
`apps/dashboard/lib/imessage-system-events.ts` as a compatibility-shaped
re-export so the 5,400-line thread page is not touched.

Existing characterisation coverage already exercises both implementations
against genuine system rows, normal conversation text, case and whitespace
variants, phone-number senders, trailing-phrase false positives, and the
proper-noun guard. The refactor must keep those tests green and add a boundary
test that imports the new package subpath directly.

Expected measurable result:

- One implementation instead of two.
- Remove about 60 executable and declaration lines from the dashboard copy.
- Preserve all existing call sites and runtime outcomes.
- Keep the browser entry isolated from the core root entry and its Node-only
  `node:crypto` dependency.

## Deliberately left alone

- No page, component, adapter, watcher, scan, send, desktop, packaging, release,
  installer, AI provider, prompt, evaluator, or shared AI type file.
- No compatibility path without proof that persisted pilot data no longer
  needs it.
- No dead-code deletion based only on text search. The audit found no candidate
  with enough reachability evidence to remove safely.
- No new architecture, lint, or dependency tool. #803 owns dependency and
  footprint changes, and the selected duplication can be removed without one.

## Outcome

The selected change is complete:

- `packages/core/src/imessage-system-events.ts` remains the unchanged canonical
  implementation.
- `@inbox-os/core/imessage-system-events` exposes only that browser-safe module.
- The dashboard matcher module fell from 71 lines to one re-export.
- The implementation and focused-test diff has 20 insertions and 85 deletions,
  a net reduction of 65 lines.
- The dashboard boundary test asserts function identity with the core subpath,
  so reintroducing a second implementation will fail the focused suite.

Validation:

- 54 focused iMessage system-event tests passed.
- Core, dashboard, and runner TypeScript lint passed.
- The optimized production dashboard build passed, confirming that the browser
  entry does not pull the core root's Node-only dependency graph into Webpack.
- The repository-wide suite built core and runner, then passed 2,148 of 2,149
  tests. One untouched LinkedIn delayed-hydration timing test missed its expected
  450 ms rejection under full-suite host load. Its isolated rerun passed 1 of 1
  in 9.7 seconds. The test and LinkedIn adapter are owned by active workstreams
  and were not changed here.
- `git diff --check` passed.
- Visual verification is not applicable because no rendered UI, copy, layout,
  or interaction changed.

The final coordination check found no exact file overlap with published PRs
#810, #811, or #812, or with the current #802 and #803 worktree diffs. #803's
broader manifest claim is respected by limiting `packages/core/package.json` to
one dependency-free export-map entry; the overlap and exact ownership boundary
were documented on #800 before implementation.
