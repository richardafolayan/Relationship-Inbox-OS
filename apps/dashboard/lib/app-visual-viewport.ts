/**
 * Keep .h-app-screen aligned with the visual viewport on mobile.
 *
 * iOS Safari often leaves the layout viewport tall when the software
 * keyboard opens (or when browser chrome collapses). 100dvh alone is not
 * reliable. visualViewport.height tracks the usable area; we publish it as
 * --app-vv-height in pre-zoom CSS pixels so body { zoom } still paints to
 * the visible area on both Chrome and Safari.
 */

export const APP_VV_HEIGHT_VAR = "--app-vv-height";

export function readCssZoom(value: string | null | undefined): number {
  if (!value) return 1;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Convert a visualViewport height (CSS px of the layout viewport) into the
 * height value .h-app-screen should use under body { zoom }.
 *
 * Explicit px lengths are always pre-zoom; unlike viewport units they are
 * NOT already divided by Safari, so we always divide by effective zoom.
 */
export function resolveAppVisualViewportHeight(
  visualHeight: number,
  effectiveZoom: number
): number {
  const zoom = readCssZoom(String(effectiveZoom));
  if (!Number.isFinite(visualHeight) || visualHeight <= 0) {
    return 0;
  }
  return visualHeight / zoom;
}

export type AppVisualViewportPublisher = {
  publish: () => void;
  disconnect: () => void;
};

export function installAppVisualViewport(
  options: {
    root?: HTMLElement;
    body?: HTMLElement;
    visualViewport?: VisualViewport | null;
    win?: Window;
  } = {}
): AppVisualViewportPublisher {
  const win = options.win ?? (typeof window !== "undefined" ? window : undefined);
  if (!win) {
    return { publish: () => {}, disconnect: () => {} };
  }

  const root = options.root ?? win.document.documentElement;
  const body = options.body ?? win.document.body;
  const vv = options.visualViewport !== undefined ? options.visualViewport : win.visualViewport;

  const publish = () => {
    const visualHeight = vv?.height ?? win.innerHeight;
    const zoom = readCssZoom(win.getComputedStyle(body).zoom);
    const height = resolveAppVisualViewportHeight(visualHeight, zoom);
    if (height > 0) {
      root.style.setProperty(APP_VV_HEIGHT_VAR, `${height}px`);
    }
  };

  publish();

  const onResize = () => publish();
  win.addEventListener("resize", onResize);
  vv?.addEventListener("resize", onResize);
  vv?.addEventListener("scroll", onResize);

  return {
    publish,
    disconnect: () => {
      win.removeEventListener("resize", onResize);
      vv?.removeEventListener("resize", onResize);
      vv?.removeEventListener("scroll", onResize);
      root.style.removeProperty(APP_VV_HEIGHT_VAR);
    }
  };
}
