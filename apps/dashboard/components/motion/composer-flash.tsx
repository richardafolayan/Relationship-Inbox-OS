"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  motion,
  useAnimationControls,
  useReducedMotion
} from "framer-motion";

interface ComposerFlashProps {
  // Counter that bumps each time a send fires. Same number = no flash;
  // an increment runs a brief opacity dip + 1px lift on the composer,
  // a visceral "you just released something" acknowledgement.
  pulse: number;
  children: ReactNode;
  className?: string;
}

// Wraps the composer surface (textarea + its surrounding chrome) and
// fires a subtle drain animation when a send happens. The actual text
// clearing is handled by the parent (setComposer("")); this component
// only adds motion, never modifies content.
//
// Why a flash instead of a height collapse: the textarea currently uses
// fixed `rows={3}`, so there's no "collapse back to single-line" to
// animate. A 250ms opacity dip + tiny y lift is the smallest motion
// that still says "your input just left", without pretending the
// composer is doing more than it actually is.
export function ComposerFlash({ pulse, children, className }: ComposerFlashProps) {
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  const seenPulseRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      seenPulseRef.current = pulse;
      return;
    }
    if (seenPulseRef.current === null) {
      seenPulseRef.current = pulse;
      return;
    }
    if (pulse === seenPulseRef.current) return;
    seenPulseRef.current = pulse;

    void controls.start({
      // Sequence: dip + lift, then settle. Short enough (220ms total)
      // that the operator can start typing the next message
      // immediately without waiting on the animation.
      opacity: [1, 0.78, 1],
      y: [0, -1, 0],
      transition: { duration: 0.22, ease: "easeOut" }
    });
  }, [pulse, controls, reduced]);

  return (
    <motion.div className={className} animate={controls}>
      {children}
    </motion.div>
  );
}
