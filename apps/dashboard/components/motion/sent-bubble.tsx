"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  motion,
  useAnimationControls,
  useReducedMotion
} from "framer-motion";
import { SPRING } from "@/lib/motion";
// SentBubble uses the bouncy spring so the bubble overshoots slightly
// before settling - reads as a real drop into rest rather than a
// soft fade. The gentle spring (used elsewhere) felt apologetic.
const ENTRY_SPRING = SPRING.bouncy;
import { cn } from "@/lib/utils";
import { SendRipple } from "./send-ripple";

// Ripple total lifetime: longest radial (delay 0.13s + duration 0.85s)
// = 0.98s. Add a small buffer so the final frame paints and the
// neighbour-bubble wave (which propagates over ~770 ms from depth 0
// to depth 4) has finished too. After this the ripple unmounts to
// keep the DOM tidy - long chat sessions shouldn't accumulate
// dozens of invisible ripple spans.
const RIPPLE_LIFETIME_MS = 1100;

interface SentBubbleProps {
  // Has the optimistic send come back as failed? Drives the shake +
  // colour shift. We watch the boolean here (rather than re-mounting
  // the bubble on failure) so the ripple isn't replayed on retry.
  failed?: boolean;
  // Don't show the ripple for entries that were already on screen at
  // mount time (e.g. a stale pending row left over from a prior thread
  // navigation). New sends get the ripple; rehydrated rows don't.
  rippleOnMount?: boolean;
  className?: string;
  children: ReactNode;
}

// Wraps the optimistic ("sending…") message bubble with the centerpiece
// send-message animation: the bubble enters from slightly above (y: -2,
// scale: 1.02) and springs into place, two ripples radiate from it on
// landing, and a failed send shakes the bubble laterally to flag the
// error.
//
// Implementation note: a single motion.div is used (rather than nested
// motion divs) so the parent's flex-column / self-end layout still
// applies to the bubble's three children (text, meta row, error p).
// All animation work — entry, shake, exit — is driven through one
// imperative `controls` so the wrapper stays a single DOM node.
export function SentBubble({
  failed = false,
  rippleOnMount = true,
  className,
  children
}: SentBubbleProps) {
  const reduced = useReducedMotion();
  const controls = useAnimationControls();
  // Track previous failed state so the shake fires on the false → true
  // transition (rather than every render that happens while
  // `failed` is true).
  const prevFailedRef = useRef(failed);
  // Ripple visibility lives in state (not a ref) so React keeps the
  // SendRipple mounted across every re-render of SentBubble during the
  // animation window. The earlier ref-based approach unmounted the
  // ripple on the very first re-render (because the parent's onSend
  // dispatches several setStates back-to-back), so the radial spans
  // never got to play their motion animation.
  const [rippleActive, setRippleActive] = useState(
    rippleOnMount && !failed && !reduced
  );

  // Mount-time entry: spring from the lifted-above starting position
  // into resting place. Runs once.
  useEffect(() => {
    if (reduced) {
      void controls.start({
        opacity: 1,
        transition: { duration: 0.12 }
      });
      return;
    }
    void controls.start({
      opacity: 1,
      y: 0,
      scale: 1,
      transition: ENTRY_SPRING
    });
    // controls is a stable reference from framer-motion, no need to
    // include in deps. Run-once intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-unmount the ripple after its animation completes. Keeping it
  // in the DOM forever wouldn't be a visual bug (opacity 0 at rest)
  // but a long session of sends would accumulate dead nodes.
  useEffect(() => {
    if (!rippleActive) return;
    const id = window.setTimeout(() => setRippleActive(false), RIPPLE_LIFETIME_MS);
    return () => window.clearTimeout(id);
  }, [rippleActive]);

  // Failed-send shake. Fires only on the false → true transition so
  // retrying a failed send (which flips failed back to false then to
  // true again if it fails again) shakes appropriately on each new
  // failure but not on each render in between.
  useEffect(() => {
    if (reduced) {
      prevFailedRef.current = failed;
      return;
    }
    if (!prevFailedRef.current && failed) {
      void controls.start({
        x: [0, -3, 3, -3, 3, 0],
        transition: { duration: 0.3, ease: "easeInOut" }
      });
      // A bubble that failed mid-ripple should drop the ripple — the
      // error state (shake + red border) is the dominant signal.
      setRippleActive(false);
    }
    prevFailedRef.current = failed;
  }, [failed, controls, reduced]);

  return (
    <motion.div
      // `relative` so the ripple radials (absolute) anchor to this
      // wrapper. `isolate` makes this a stacking context so the
      // ripple's `-z-10` sits behind the static bubble children
      // without falling behind the chat background. Original layout
      // classes (flex column, self-end, etc.) pass through unchanged
      // - merged via cn() so callers can also override if needed.
      className={cn("relative isolate", className)}
      // No `layout` prop here on purpose. With layout="position",
      // framer-motion claims ownership of `transform` and silently
      // overrides our `initial`/`animate` y + scale values - the
      // bubble's opacity would fade in but it would never visibly
      // "drop" into place. The pending→real swap is visually
      // near-identical (same text, same right alignment), so the
      // small position jump on reconciliation is acceptable.
      animate={controls}
      // Bigger lift (y: -8, scale: 1.06) so the bouncy spring
      // actually reads as a drop into rest. The previous values
      // (y: -2, scale: 1.02) were too timid - the bubble seemed
      // to fade in rather than land.
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 1.06 }}
      exit={
        reduced
          ? { opacity: 0, transition: { duration: 0.08 } }
          : { opacity: 0, transition: { duration: 0.15, ease: "easeIn" } }
      }
    >
      {rippleActive ? <SendRipple /> : null}
      {children}
    </motion.div>
  );
}
