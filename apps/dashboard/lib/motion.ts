import type { Transition } from "framer-motion";

// Easing curves. Centralised so every surface speaks the same motion
// vocabulary - if these change, the entire dashboard's "feel" changes
// in one place. `apple` is the default for view/component motion;
// `out` for arrivals (decelerating into rest), `in` for exits
// (accelerating away), `inOut` for symmetric moves.
export const EASE = {
  apple: [0.32, 0.72, 0, 1],
  out: [0.16, 1, 0.3, 1],
  in: [0.7, 0, 0.84, 0],
  inOut: [0.65, 0, 0.35, 1]
} as const;

// Tween durations in seconds (framer-motion convention). `fast` for
// hover and press; `base` for most micro-interactions; `slow` for
// content arrival and view transitions; `dramatic` reserved for
// theatrical moments (theme reveal, send ripple) that earn the length.
export const DURATION = {
  fast: 0.15,
  base: 0.25,
  slow: 0.4,
  dramatic: 0.7
} as const;

// Spring presets. `gentle` for arrivals that should settle without
// drama (message bubble landing). `bouncy` for playful interactions
// (tapback picker, toggle overshoot). `stiff` for shared-element
// transitions where precision matters more than personality
// (layoutId active route slides).
export const SPRING = {
  gentle: { type: "spring", stiffness: 200, damping: 30 } as const,
  bouncy: { type: "spring", stiffness: 300, damping: 20 } as const,
  stiff: { type: "spring", stiffness: 400, damping: 35 } as const
} satisfies Record<string, Transition>;

// Pre-baked transitions for the patterns that recur. Components can
// still hand-roll a transition when they need something specific;
// this is just the common case.
export const TRANSITIONS = {
  // Generic micro-interaction (hover, focus, small state changes).
  micro: { duration: DURATION.fast, ease: EASE.out } as const,
  // Arrival of a discrete piece of content (suggestion card, popover).
  arrive: { duration: DURATION.base, ease: EASE.out } as const,
  // Exit of a discrete piece of content - faster than arrival so the
  // UI feels responsive even when content is leaving.
  exit: { duration: DURATION.fast, ease: EASE.in } as const,
  // View/surface transition (page swap, drawer slide).
  view: { duration: DURATION.slow, ease: EASE.apple } as const
} satisfies Record<string, Transition>;

// Reduced-motion variants. Use these to override animation values when
// the user has opted out: zero spatial motion, near-instant duration,
// opacity-only crossfade for content swaps. Pair with framer-motion's
// `useReducedMotion()` hook at the call site.
export const REDUCED = {
  // For motion.div animate props - pin to identity (no spatial change)
  // while keeping opacity behaviour intact.
  pin: { x: 0, y: 0, scale: 1, rotate: 0 } as const,
  // Instant transition - useful for AnimatePresence so exits don't
  // linger when motion is disabled.
  instant: { duration: 0 } as const,
  // Opacity-only crossfade - the one motion we keep even under
  // reduced-motion, since pure cuts can feel like glitches.
  fade: { duration: DURATION.fast, ease: "linear" } as const
} satisfies Record<string, Transition | Record<string, number>>;

// Stagger helper for AnimatePresence children. `step` is per-child
// delay in seconds, `cap` is the max number of children to stagger
// before the rest snap in together (so a 200-row list doesn't take
// 8 seconds to settle).
export function staggerChildren(step: number, cap = 8) {
  return (index: number): number => (index < cap ? index * step : cap * step);
}
