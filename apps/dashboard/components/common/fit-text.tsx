"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType
} from "react";

// useLayoutEffect measures before the browser paints, so the text is already
// sized correctly on first paint (no flash of un-fitted type). On the server
// layout effects are a no-op, so fall back to useEffect there to avoid React's
// SSR warning.
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface FitTextProps {
  /** The text to render. Always rendered IN FULL — never truncated. */
  children: string;
  /** Largest font size (px). Short text renders at this. */
  maxPx: number;
  /** Smallest font size (px) the text may shrink to — the readability floor. */
  minPx: number;
  /** The full text must fit (without clipping) inside this block height (px). */
  maxHeightPx: number;
  /** Element to render (defaults to a div). */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  /** Any extra DOM attributes (data-*, aria-*, id, …) forwarded to the element. */
  [attr: `data-${string}`]: unknown;
  [attr: `aria-${string}`]: unknown;
  id?: string;
}

// Renders `children` at the LARGEST font size in [minPx, maxPx] at which the
// FULL text fits inside `maxHeightPx`, measured against the element's real,
// responsive width. There is deliberately no truncation and no line-clamp —
// only the font size adapts, so the whole string is always visible. The size
// is recomputed when the available WIDTH changes (ResizeObserver) and after
// web fonts finish loading (which can change wrapping metrics).
//
// This is the "always fit, even if it uses more space" primitive behind the
// Today hero summary: short asks stay big and punchy; long ones gently shrink
// and wrap rather than getting cut off with an ellipsis.
export function FitText({
  children,
  maxPx,
  minPx,
  maxHeightPx,
  as,
  className,
  style,
  ...rest
}: FitTextProps) {
  const Tag = (as ?? "div") as ElementType;
  const ref = useRef<HTMLElement | null>(null);
  // Drive the fitted size through state so React keeps re-applying it on every
  // render. (Setting el.style imperatively alone would get clobbered the next
  // time the parent re-rendered, snapping the text back to maxPx.)
  const [fontPx, setFontPx] = useState(maxPx);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const measure = () => {
      // Step down from the max until the rendered block fits the height budget
      // (or we reach the floor). scrollHeight is the full content height — the
      // element is never clamped or scrolled, so this reflects the real wrap.
      let size = maxPx;
      el.style.fontSize = `${size}px`;
      while (size > minPx && el.scrollHeight > maxHeightPx) {
        size -= 1;
        el.style.fontSize = `${size}px`;
      }
      setFontPx(size);
    };

    measure();

    // Re-fit only when the available WIDTH changes. The element's width is
    // driven by its parent (not by its own font size), so reacting to width —
    // and ignoring the height changes measure() itself causes — avoids an
    // observer feedback loop.
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? lastWidth;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      measure();
    });
    observer.observe(el);

    // Web fonts can swap in after first paint and change wrapping; re-fit then.
    let cancelled = false;
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts?.ready) {
      void fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [children, maxPx, minPx, maxHeightPx]);

  return (
    <Tag ref={ref} className={className} style={{ ...style, fontSize: fontPx }} {...rest}>
      {children}
    </Tag>
  );
}
