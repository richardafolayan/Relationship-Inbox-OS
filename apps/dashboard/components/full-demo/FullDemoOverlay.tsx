"use client";

import { useEffect, useLayoutEffect, useState } from "react";

import { useFullDemo } from "./FullDemoProvider";
import { FullDemoControls } from "./FullDemoControls";

/**
 * Floating overlay shown while a walkthrough step is active. Two parts:
 *
 *  - A highlight rectangle that tracks the bounding box of the
 *    `data-demo-target` element. Uses DOM measurements (no fixed
 *    coordinates) so window resize / reflow keeps the highlight aligned.
 *
 *  - A tooltip card with the step title, body, step counter, and the
 *    Next / Back / Pause / Exit / Restart controls.
 *
 * If the target element is missing the step's `fallback` determines what
 * happens: "skip" advances automatically, "show-centred" renders the card
 * without a highlight, "stop" pauses autoplay.
 */

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function findTarget(target: string | undefined): Element | null {
  if (!target || typeof document === "undefined") return null;
  return document.querySelector(`[data-demo-target="${CSS.escape(target)}"]`);
}

function getRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function FullDemoOverlay() {
  const { active, currentStep, next, setAutoplay } = useFullDemo();
  const [rect, setRect] = useState<Rect | null>(null);
  const [missing, setMissing] = useState(false);

  // Measure the target rect; re-measure on resize, scroll, and a slow tick
  // so transitions / late-mounting children also stay aligned.
  useLayoutEffect(() => {
    if (!active || !currentStep) {
      setRect(null);
      setMissing(false);
      return undefined;
    }
    const targetKey = currentStep.target;
    if (!targetKey) {
      setRect(null);
      setMissing(false);
      return undefined;
    }

    let cancelled = false;

    function measure() {
      if (cancelled) return;
      const el = findTarget(targetKey);
      if (!el) {
        setRect(null);
        setMissing(true);
        return;
      }
      setMissing(false);
      setRect(getRect(el));
    }

    measure();
    const handle = window.setInterval(measure, 300);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, currentStep]);

  // Apply fallback when target is permanently missing.
  useEffect(() => {
    if (!missing || !currentStep) return;
    const fallback = currentStep.fallback ?? "show-centred";
    if (fallback === "skip") next();
    if (fallback === "stop") setAutoplay(false);
  }, [missing, currentStep, next, setAutoplay]);

  if (!active || !currentStep) return null;

  const fallback = currentStep.fallback ?? "show-centred";
  const useCentred = !rect || fallback === "show-centred" || missing;

  return (
    <div
      aria-hidden={false}
      className="pointer-events-none fixed inset-0 z-[999]"
      data-demo-target="full-demo-overlay"
    >
      {!useCentred && rect && (
        <div
          className="pointer-events-none absolute rounded-2xl ring-4 ring-accent/60 ring-offset-2 ring-offset-paper transition-[top,left,width,height] duration-200 ease-out"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12
          }}
        />
      )}

      <div
        className={`pointer-events-auto absolute ${useCentred ? "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" : ""}`}
        style={
          useCentred
            ? undefined
            : computeCardPosition(rect!)
        }
      >
        <div className="w-[360px] max-w-[90vw] rounded-3xl border border-hairline bg-paper p-5 shadow-xl">
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-ink-3">{currentStep.id}</div>
            <h2 className="text-base font-medium text-ink">{currentStep.title}</h2>
            <p className="text-sm leading-relaxed text-ink-2">{currentStep.body}</p>
          </div>
          <div className="mt-4">
            <FullDemoControls />
          </div>
        </div>
      </div>
    </div>
  );
}

function computeCardPosition(rect: Rect): React.CSSProperties {
  // Prefer beneath the target; flip above when the bottom would clip the
  // viewport. Centre horizontally inside the target unless that would
  // overflow either edge.
  const viewportH = typeof window !== "undefined" ? window.innerHeight : 800;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1200;
  const cardWidth = 360;
  const margin = 16;
  const below = rect.top + rect.height + margin;
  const fitsBelow = below + 200 < viewportH;
  const top = fitsBelow ? below : Math.max(margin, rect.top - 200 - margin);
  let left = rect.left + rect.width / 2 - cardWidth / 2;
  if (left + cardWidth > viewportW - margin) left = viewportW - cardWidth - margin;
  if (left < margin) left = margin;
  return { top, left };
}
