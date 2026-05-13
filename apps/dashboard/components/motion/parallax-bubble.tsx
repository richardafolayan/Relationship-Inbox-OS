"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  motion,
  useAnimationControls,
  useReducedMotion,
  type HTMLMotionProps
} from "framer-motion";

type ParallaxBubbleProps = Omit<HTMLMotionProps<"div">, "animate" | "children"> & {
  // Counter that bumps each time a send fires. Same number = no
  // animation; an increment triggers the wave. Plain number so React
  // can equality-check it cheaply.
  pulse: number;
  // Distance from the just-sent bubble in list-index terms. 0 = the
  // bubble immediately above the pending row, 1 = next up, etc.
  // Negative or beyond the depth table falls through to a no-op.
  depth: number;
  children: ReactNode;
};

// Per-depth y-shift in pixels. The closest bubble bobs the most;
// each further bubble bobs less. Extended to 5 bubbles (was 3) so
// the wave has somewhere to actually travel - with only 3 depths
// the propagation read as a synchronised dip, not a wave.
const DEPTH_TO_SHIFT_PX = [10, 7, 5, 3, 1.5] as const;

// Per-depth start delay (seconds). The wave fires at depth 0 first
// and ripples outward at one bubble per 30 ms. This propagation is
// what sells the wave as a wave: the closest bubble visibly dips
// BEFORE the further ones do, and the eye reads that as a single
// disturbance travelling through the chat.
const PER_DEPTH_DELAY_S = 0.03;

// Total animation duration per bubble. Long enough for the dip-and-
// return to feel physical, short enough that the wave fully decays
// well under a second (visually settled by ~770 ms = 650 ms +
// 120 ms of propagation delay at the farthest depth).
const WAVE_DURATION_S = 0.65;

// Keyframe timing inside the wave: the bubble should dip into the
// trough faster than it climbs back out, the way a surface bobs
// after something has dropped through it. With [0, 0.4, 1] the trough
// is hit at 40 % of the duration.
const WAVE_TIMES = [0, 0.4, 1] as const;

// Tilt amount. Small enough to register as surface motion rather
// than a flip - any more and it starts looking like a card-flip
// animation instead of a wave passing under the bubble.
const TILT_DEG = 3;

// Brief opacity dip while the bubble is "submerged" mid-wave. The
// recovery back to 1 happens on the same timeline so the bubble
// brightens as the wave passes through.
const OPACITY_TROUGH = 0.88;

export function ParallaxBubble({
  pulse,
  depth,
  className,
  children,
  ...rest
}: ParallaxBubbleProps) {
  // For out-of-range bubbles (depth >= 5), render a plain div with
  // no motion infrastructure. Mounting motion.div + useAnimationControls
  // + perspective on every bubble in a 60-message thread caused a
  // visible ~1 second render block on every send. Now only the
  // bubbles that will actually animate carry that cost.
  const shift = DEPTH_TO_SHIFT_PX[depth];
  if (shift === undefined) {
    return (
      <div className={className} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
        {children}
      </div>
    );
  }

  return (
    <AnimatedParallaxBubble
      pulse={pulse}
      depth={depth}
      shift={shift}
      className={className}
      {...rest}
    >
      {children}
    </AnimatedParallaxBubble>
  );
}

// Animated sub-component. Split out so hooks (useReducedMotion,
// useAnimationControls, useEffect) only run when this code path
// actually mounts - i.e. for the 5 nearest neighbours, not for the
// 55 silent bubbles further up the chat.
function AnimatedParallaxBubble({
  pulse,
  depth,
  shift,
  className,
  children,
  ...rest
}: ParallaxBubbleProps & { shift: number }) {
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  // Skip the initial render: only respond to pulse increments. A
  // freshly-mounted bubble shouldn't animate on first paint just
  // because pulse happens to be > 0 from a prior send.
  const seenPulseRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      seenPulseRef.current = pulse;
      return;
    }
    // First time we see this bubble: record the current pulse and
    // wait for a later increment to animate. Keeps newly-rendered
    // bubbles (e.g. on scroll up to load older messages) from
    // jumping just because they've mounted into a non-zero pulse.
    if (seenPulseRef.current === null) {
      seenPulseRef.current = pulse;
      return;
    }
    if (pulse === seenPulseRef.current) return;
    seenPulseRef.current = pulse;

    // Three things happen on the same delayed timeline so the
    // bubble tilts and dims AS the wave reaches it and recovers AS
    // the wave passes through:
    //   y         dip down then back up
    //   rotateX   tilt forward then back (surface tilt)
    //   opacity   brief submersion
    // Everything shares the same `times` so the trough lines up.
    void controls.start({
      y: [0, shift, 0],
      rotateX: [0, TILT_DEG, 0],
      opacity: [1, OPACITY_TROUGH, 1],
      transition: {
        delay: depth * PER_DEPTH_DELAY_S,
        duration: WAVE_DURATION_S,
        times: [...WAVE_TIMES],
        ease: "easeOut"
      }
    });
  }, [pulse, depth, controls, reduced, shift]);

  return (
    <motion.div
      className={className}
      animate={controls}
      // `transformPerspective` makes the rotateX actually read as a
      // 3D tilt rather than a vertical squash. 800px is far enough
      // away that the tilt feels gentle, close enough that it's
      // visible.
      style={{ transformPerspective: 800 }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}
