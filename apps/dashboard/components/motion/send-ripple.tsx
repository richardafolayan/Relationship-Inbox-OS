"use client";

import { motion, useReducedMotion } from "framer-motion";
import { EASE } from "@/lib/motion";

// Two staggered radials that radiate outward from a sent message bubble.
// The ripple is intentionally subtle - a soft paper-coloured halo, not
// a coloured splash. The visual impact comes from the wave passing
// through the neighbour bubbles (see ParallaxBubble); this layer is the
// quiet "where the stone landed" mark behind it.
//
// Positioned absolutely so the parent must be `relative`. Pure
// transform/opacity = GPU only, no layout/paint cost. Pointer-events
// off so the ripple can't intercept clicks on neighbouring bubbles.
//
// Reduced-motion users get nothing - the bubble's appearance already
// announces "sent" and the wave on neighbours is already disabled.
export function SendRipple({ tint = "var(--ripple-tint)" }: { tint?: string }) {
  const reduced = useReducedMotion();
  if (reduced) return null;

  // Both ripples share the same geometry; only the start delay differs.
  // 130 ms stagger lands the second wave just as the first is mid-flight,
  // which reads as "depth" rather than a single thicker pulse.
  return (
    <span
      aria-hidden="true"
      // -z so the ripple sits BEHIND the bubble content within the
      // SentBubble's isolated stacking context. The bubble (static
      // children) paints in front; the ripple is the quiet glow at
      // the back.
      className="pointer-events-none absolute inset-0 -z-10 overflow-visible"
    >
      <Ripple tint={tint} delay={0} />
      <Ripple tint={tint} delay={0.13} />
    </span>
  );
}

function Ripple({ tint, delay }: { tint: string; delay: number }) {
  return (
    <motion.span
      // Centred on the bubble; scales out from sub-bubble size to
      // ~4x past its edges, so the halo extends well into the chat
      // column without any visible hard edge.
      className="absolute left-1/2 top-1/2 block h-full w-full rounded-[28px]"
      style={{
        translateX: "-50%",
        translateY: "-50%",
        background: `radial-gradient(circle, ${tint} 0%, transparent 65%)`,
        willChange: "transform, opacity"
      }}
      initial={{ scale: 0.4, opacity: 0.18 }}
      animate={{ scale: 4, opacity: 0 }}
      transition={{
        // 850 ms gives the ripple time to spread without dragging on.
        // EASE.out so it decelerates as it fades, matching the way
        // a real ripple loses energy at its edges.
        duration: 0.85,
        delay,
        ease: EASE.out
      }}
    />
  );
}
