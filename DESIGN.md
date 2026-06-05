# Design

Visual design system for Relationship Inbox OS. Captured from the live dashboard
(`apps/dashboard`): `app/globals.css`, `tailwind.config.ts`, and the component library.
This is the source of truth for staying on-brand. See [PRODUCT.md](PRODUCT.md) for the
strategic "who / what / why".

## Theme

A calm, warm, paper-and-ink workspace inspired by native macOS / SF design. Near-white
warm paper, near-black warm ink, one coral accent, and three quiet risk hues. It reads as
a focused desk lamp on a soft surface, not a glowing dashboard. Light by default, with a
cool-tinted dark mode. Colour strategy: **Restrained** — tinted neutrals carry the surface,
the coral accent is used only for primary actions, current focus, and state, never for
decoration.

Tokens are defined as CSS custom properties in `app/globals.css` and exposed to Tailwind
in `tailwind.config.ts`. Always use the tokens; never hardcode hex.

## Color

All colours are authored in OKLCH. Hue 80 (warm) anchors the neutral ramp; hue 32 (coral)
the accent.

### Light (`:root`)

| Token | Value | Role |
|---|---|---|
| `--paper` | `oklch(98.5% 0.005 80)` | Page background (warm near-white) |
| `--paper-2` | `oklch(96.5% 0.006 80)` | Hover / secondary surface, panels |
| `--paper-3` | `oklch(93% 0.007 80)` | Tertiary surface |
| `--ink` | `oklch(18% 0.01 80)` | Primary text, primary button fill |
| `--ink-2` | `oklch(34% 0.01 80)` | Secondary text |
| `--ink-3` | `oklch(54% 0.008 80)` | Muted text, labels, meta |
| `--ink-4` | `oklch(74% 0.006 80)` | Faint text, placeholders, done/strike |
| `--hairline` | `oklch(90% 0.006 80)` | Default 1px dividers and borders |
| `--hairline-strong` | `oklch(84% 0.007 80)` | Slightly stronger dividers, quote rule |
| `--accent` | `oklch(66% 0.16 32)` | **Warm coral.** Primary action, focus ring, live dot |
| `--accent-soft` | `oklch(94% 0.04 32)` | Coral tint background (selection, hero glow) |
| `--accent-ink` | `oklch(38% 0.13 32)` | Coral text on light |
| `--risk-overdue` | `oklch(60% 0.18 28)` | RED — overdue (warm red) |
| `--risk-waiting` | `oklch(70% 0.11 75)` | AMBER — waiting on you |
| `--risk-fresh` | `oklch(64% 0.09 155)` | GREEN — fresh, no rush (teal) |

### Dark (`[data-theme="dark"]`)

Neutrals shift to a cool hue (260): `--paper` `oklch(15% 0.008 260)` → `--ink`
`oklch(96% 0.005 260)`, with `--hairline` `oklch(28% 0.012 260)`. The coral accent hue is
preserved; `--accent-soft`/`--accent-ink` are re-tuned for contrast.

### Rules

- **Accent is for action and state only** (primary buttons, focus, the single "live"/risk
  dot). Never decorative fills, never gradients-as-style.
- **Risk is never colour-only.** Always pair the dot with a text label
  (Overdue / Waiting / Fresh).
- Body and secondary text must hit WCAG AA on `--paper`. Don't push body text to `--ink-4`.

## Typography

System SF stack — no web fonts. Two roles plus mono; well under the 3-family cap.

| Token | Stack | Use |
|---|---|---|
| `--font-display` | `-apple-system, "SF Pro Display", …, system-ui` | Headings, hero, person names |
| `--font-text` | `-apple-system, "SF Pro Text", …, system-ui` | Body, controls, the default |
| `--font-mono` | `"SF Mono", ui-monospace, …` | Labels, eyebrows, meta, counts, timestamps |

- Base: 15px / line-height 1.5 / letter-spacing -0.005em on `body`.
- Display headings tighten tracking (-0.02em to -0.025em) and use `text-balance`.
- Hierarchy comes from **scale + weight**: hero ~32–36px semibold; section heads 18–19px;
  body 14–15px; labels/meta 10–12px mono uppercase, tracking ~0.08em.
- **Mono uppercase is the eyebrow/label voice** (e.g. "Reply job", "They said", "Tonight's
  outline"). Use it for short labels only, never body copy.
- Sentence case everywhere. No ALL-CAPS sentences.

## Layout & Spacing

- App shell: fixed left sidebar + scrolling `<main>`. Content pages use the `Canvas`
  wrapper (`max-w-[920px]`, generous `px-12`); Today widens to `max-w-[1240px]` for its
  hero + right-rail grid.
- Page headers are **sticky and glassy** (`backdrop-blur` over a `color-mix` of paper),
  sitting inside the scroller; content sections own their own dividers.
- Thread workspace is a responsive grid: sibling-thread rail (`56px` collapsed / `240px`)
  + chat column + optional `360px` context rail. Rails collapse below `lg`.
- Radii: `--radius-card: 22px` (cards), `--radius-row: 16px` (rows/inputs),
  `--radius-pill: 999px` (pills/avatars).
- Shadows are soft and rare: `--shadow-card` for resting cards, `--shadow-pop` for popovers.
- **Separators:** on the Today surface, separate metadata with **plain spacing only** — no
  pipe (`|`) and no dot (`·`) separators. (Flex `gap` does the work.)
- **No em dashes or en dashes in UI copy** (use commas, colons, periods, parentheses).

## Iconography

`lucide-react`, `strokeWidth` ~1.6–1.8, sizes 12–16px, tinted `--ink-3`. Icons support
labels; they don't replace them. Used sparingly — a calm surface, not an icon grid.
`Sparkles` is the consistent "AI" glyph.

## Components

Primitives live in `components/ui`; shared list/page pieces in `components/common`;
feature pieces in `components/{thread,settings,layout,…}`.

- **Button** (`ui/button.tsx`): variants `primary` (ink fill), `ghost`, `quiet`
  (bordered), `danger`. Focus ring `ring-2 ring-accent`. `transition-calm`.
- **ActionButton** (`ui/action-button.tsx`): async button that surfaces inline
  running/done state (e.g. "Saving…" → "Saved"). **Action buttons show inline status, not
  just a label flip.**
- **Menu** (`ui/menu.tsx`): popover/dropdown.
- **ThreadRow** (`common/thread-row.tsx`): avatar + name + platform tag + quiet inline
  metadata + right-aligned risk/time. On needs-reply rows the body leads with the AI
  context line ("what they want"), not the raw preview.
- **Canvas / PageHead / SectionDivider / CaughtUp / QuietRow** (`common/canvas.tsx`):
  page scaffold and the dashed-border empty state.
- **Reply Brief** (`thread/ReplyBriefPanel.tsx`): the reply-readiness panel — Reply job /
  They said / Draft coverage / Where it stands, with a single "More" disclosure for depth.
- **ActionItemsChecklist** (`thread/ActionItemsChecklist.tsx`): open loops as a
  thinking-aid checklist (ticking never edits the message), with AI coverage hints.
- **ThingsToRemember** (`thread/ThingsToRemember.tsx`): quiet, read-only durable facts.

Component rules: every interactive element needs default / hover / focus / disabled (and
loading where async). Same affordance everywhere — one button shape, one form-control
vocabulary. No nested cards. Cards only when they're the right affordance.

## Motion

Quiet and state-bearing, never choreography.

- Standard transition: **180ms** (`duration-calm`), ease. Buttons scale to 0.98 on
  `:active`.
- Reserved keyframes: `progressSweep` (indeterminate task bar), `pulseDot` (working dots),
  `fadeSlideDown` (accordion reveal). Hero/queue transitions use short opacity fades.
- **`prefers-reduced-motion: reduce` is global** — all animation/transition/scroll-behavior
  collapse to instant.

## Absolute "don'ts" (this product)

Purple/violet gradients · glassmorphism as decoration · neon · KPI hero-metric tiles ·
identical card grids · nested cards · gratuitous icons · per-section tracked-uppercase
eyebrows used as scaffolding · color-only state · dot/pipe separators on Today · em/en
dashes in copy · hardcoding any operator persona into defaults or copy.
