"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type RectSnapshot = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

type NavigatorWithVirtualKeyboard = Navigator & {
  virtualKeyboard?: { boundingRect?: DOMRect };
};

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function rect(selector: string): RectSnapshot | null {
  const bounds = document.querySelector(selector)?.getBoundingClientRect();
  if (!bounds) return null;
  return {
    top: rounded(bounds.top),
    right: rounded(bounds.right),
    bottom: rounded(bounds.bottom),
    left: rounded(bounds.left),
    width: rounded(bounds.width),
    height: rounded(bounds.height)
  };
}

function captureGeometry() {
  const root = document.documentElement;
  const body = document.body;
  const viewport = window.visualViewport;
  const timeline = document.querySelector<HTMLElement>('[data-testid="thread-message-timeline"]');
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="thread-composer-input"]');
  const active = document.activeElement;
  const editableFocused =
    active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || (active instanceof HTMLElement && active.isContentEditable);
  const keyboardRect = (navigator as NavigatorWithVirtualKeyboard).virtualKeyboard?.boundingRect;

  return {
    windowInnerHeight: rounded(window.innerHeight),
    windowInnerWidth: rounded(window.innerWidth),
    documentClientHeight: rounded(root.clientHeight),
    documentClientWidth: rounded(root.clientWidth),
    documentScrollHeight: rounded(root.scrollHeight),
    documentScrollWidth: rounded(root.scrollWidth),
    bodyScrollHeight: rounded(body.scrollHeight),
    bodyScrollWidth: rounded(body.scrollWidth),
    documentScrollTop: rounded(root.scrollTop),
    bodyScrollTop: rounded(body.scrollTop),
    visualViewport: viewport
      ? {
          height: rounded(viewport.height),
          width: rounded(viewport.width),
          offsetTop: rounded(viewport.offsetTop),
          offsetLeft: rounded(viewport.offsetLeft),
          pageTop: rounded(viewport.pageTop),
          pageLeft: rounded(viewport.pageLeft),
          scale: rounded(viewport.scale)
        }
      : null,
    appShell: rect('[data-scroll-owner="shell"]'),
    threadRoot: rect('[data-testid="thread-root"]'),
    messageScroller: {
      rect: rect('[data-testid="thread-message-timeline"]'),
      scrollTop: rounded(timeline?.scrollTop ?? 0),
      scrollHeight: rounded(timeline?.scrollHeight ?? 0),
      clientHeight: rounded(timeline?.clientHeight ?? 0),
      distanceFromBottom: timeline
        ? rounded(timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop)
        : null
    },
    composerFooter: rect('[data-testid="thread-composer-footer"]'),
    textarea: {
      rect: rect('[data-testid="thread-composer-input"]'),
      fontSize: textarea ? getComputedStyle(textarea).fontSize : null
    },
    keyboard: {
      editableFocused,
      inferredVisible: Boolean(
        editableFocused
        && viewport
        && window.innerHeight - viewport.height > 120
      ),
      virtualKeyboardRect: keyboardRect
        ? {
            top: rounded(keyboardRect.top),
            right: rounded(keyboardRect.right),
            bottom: rounded(keyboardRect.bottom),
            left: rounded(keyboardRect.left),
            width: rounded(keyboardRect.width),
            height: rounded(keyboardRect.height)
          }
        : null
    },
    bodyZoom: getComputedStyle(body).zoom || "1",
    uiTextSize: root.dataset.uiScale ?? "normal",
    displayMode: window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser",
    orientation: {
      type: screen.orientation?.type ?? null,
      angle: screen.orientation?.angle ?? null
    }
  };
}

export function ViewportDiagnostics() {
  const searchParams = useSearchParams();
  const enabled = searchParams.get("viewportDiagnostics") === "1";
  const sessionId = useMemo(
    () => enabled ? `iphone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : "",
    [enabled]
  );
  const sequenceRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastPhase, setLastPhase] = useState("ready");

  useEffect(() => {
    if (!enabled) return;
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="thread-composer-input"]'
    );
    if (!textarea) return;

    const publish = (phase: string, delay = 0) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const payload = {
          sessionId,
          sequence: sequenceRef.current,
          phase,
          geometry: captureGeometry()
        };
        sequenceRef.current += 1;
        setLastPhase(phase);
        void fetch("/api/viewport-diagnostics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true
        });
      }, delay);
    };

    const onFocus = () => publish("after-focus", 500);
    const onInput = () => publish("after-typing", 350);
    const onBlur = () => publish("after-keyboard-dismissal", 500);
    const onViewportResize = () => publish("visual-viewport-resize", 120);
    const onViewportScroll = () => publish("visual-viewport-scroll", 120);
    const onOrientation = () => publish("orientation-change", 500);
    const onVisibility = () => publish(`visibility-${document.visibilityState}`, 250);

    publish("before-focus", 250);
    textarea.addEventListener("focus", onFocus);
    textarea.addEventListener("input", onInput);
    textarea.addEventListener("blur", onBlur);
    window.visualViewport?.addEventListener("resize", onViewportResize);
    window.visualViewport?.addEventListener("scroll", onViewportScroll);
    window.addEventListener("orientationchange", onOrientation);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      textarea.removeEventListener("focus", onFocus);
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("blur", onBlur);
      window.visualViewport?.removeEventListener("resize", onViewportResize);
      window.visualViewport?.removeEventListener("scroll", onViewportScroll);
      window.removeEventListener("orientationchange", onOrientation);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, sessionId]);

  if (!enabled) return null;

  return (
    <div className="fixed left-2 top-2 z-[200] rounded-pill bg-ink px-3 py-1 font-mono text-[11px] text-paper">
      Viewport log: {lastPhase}
    </div>
  );
}
