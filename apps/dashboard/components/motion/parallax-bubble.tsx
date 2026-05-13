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
  // animation; an increment triggers the y-shift. We watch the value
  // (not just the change) so a remount with pulse=0 doesn't animate.
  pulse: number;
  // Distance from the just-sent bubble in list-index terms. 0 = the
  // closest neighbour (biggest shift), 1 = next-closest, etc. Negative
  // or >2 falls through to no animation.
  depth: number;
  children: ReactNode;
};

// y-shifts by depth: the bubble immediately above the sent one bobs the
// most, with the effect tapering off. Within the ~700ms ripple window,
// each shifted bubble dips down a few pixels and springs back, which
// reads as "the chat felt the splash."
const DEPTH_TO_SHIFT_PX = [3, 2, 1.25] as const;

export function ParallaxBubble({
  pulse,
  depth,
  className,
  children,
  ...rest
}: ParallaxBubbleProps) {
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
    // wait for a later increment to animate. This is what makes the
    // effect "transient" - new bubbles entering the viewport during
    // scrolling don't all jump.
    if (seenPulseRef.current === null) {
      seenPulseRef.current = pulse;
      return;
    }
    if (pulse === seenPulseRef.current) return;
    seenPulseRef.current = pulse;

    const shift = DEPTH_TO_SHIFT_PX[depth];
    if (shift === undefined) return;

    void controls.start({
      y: [0, shift, 0],
      transition: {
        // Stagger by depth: the closest bubble starts immediately,
        // each further one waits ~40ms. Reads as the ripple "passing
        // through" the chat rather than every bubble bobbing in unison.
        delay: depth * 0.04,
        duration: 0.55,
        ease: [0.16, 1, 0.3, 1]
      }
    });
  }, [pulse, depth, controls, reduced]);

  return (
    <motion.div className={className} animate={controls} {...rest}>
      {children}
    </motion.div>
  );
}
