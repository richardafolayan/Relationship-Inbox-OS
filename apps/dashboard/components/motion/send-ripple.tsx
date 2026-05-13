"use client";

import { motion, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/motion";

// Two staggered radials that radiate outward from a sent message bubble
// like a stone dropped in still water. Positioned absolutely so the
// parent must be `relative`. Pure transform/opacity = GPU only, no
// layout/paint cost. Pointer-events off so the ripple can't intercept
// clicks on neighbouring bubbles while it plays.
//
// The ripple is purely decorative - state is communicated by the bubble
// itself (entering, then settling). Reduced-motion users get nothing,
// which is correct: the bubble's appearance already announces "sent."
export function SendRipple({ tint = "var(--accent)" }: { tint?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return null;

  // Both ripples share the same geometry; only the start delay differs.
  // 120ms stagger lands the second wave just as the first is mid-flight,
  // which reads as "depth" rather than a single thicker pulse.
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-visible"
    >
      <Ripple tint={tint} delay={0} />
      <Ripple tint={tint} delay={0.12} />
    </span>
  );
}

function Ripple({ tint, delay }: { tint: string; delay: number }) {
  return (
    <motion.span
      // Centred on the bubble's centre; the bubble itself sits above
      // this layer with its own background, so the ripple only shows
      // around the edges as it scales past the bubble's bounds.
      className="absolute left-1/2 top-1/2 block h-full w-full rounded-[28px]"
      style={{
        translateX: "-50%",
        translateY: "-50%",
        background: `radial-gradient(circle, ${tint} 0%, transparent 65%)`,
        willChange: "transform, opacity"
      }}
      initial={{ scale: 0.6, opacity: 0.45 }}
      animate={{ scale: 3, opacity: 0 }}
      transition={{
        duration: 0.7,
        delay,
        ease: EASE.out
      }}
    />
  );
}
