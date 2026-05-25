"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { apiPost } from "@/lib/api";
import {
  clearTourActive,
  emptyDemoIds,
  getPilotTourSteps,
  isLastStep,
  isTourActive,
  markTourActive,
  markTourSeen,
  nextStepIndex,
  onPilotTourStart,
  prevStepIndex,
  PILOT_TOUR_ACTIVE_KEY,
  PILOT_TOUR_SERENA_THREAD_KEY,
  PILOT_TOUR_TIMI_THREAD_KEY,
  type PilotTourDemoIds,
  type PilotTourStep
} from "@/lib/pilot-tour";

// Lightweight in-house tour overlay. No third-party deps; matches the
// existing app's paper/hairline aesthetic. Responsibilities:
//   - Listen for a window event ("pilot-tour-start") and run the steps.
//   - POST /control/pilot-tour/start at the beginning to seed Serena and
//     Timi (and pause real scans via demoMode), and POST /end at the end
//     or on skip to clean up.
//   - Resolve each step's `data-tour` selector(s). First match wins.
//     Missing targets skip the step rather than crashing the tour.
//   - Esc closes; "Skip" sets the seen flag and ends the tour cleanly.
//
// Importantly: this component never calls `/control/scan` or any send
// endpoint. The only fetches are pilot-tour/start and pilot-tour/end.

interface PilotTourState {
  active: boolean;
  stepIndex: number;
  demoIds: PilotTourDemoIds;
  /** True while POSTing /control/pilot-tour/start; gates the popover. */
  bootstrapping: boolean;
}

// Resolve the popover rect for a step. Measures synchronously on mount
// (useLayoutEffect runs after DOM commit but before paint, so we get
// the freshly-laid-out element), then re-measures on scroll, resize,
// and any DOM mutation that touches the anchor. Returns both the rect
// (for positioning) and a ref to the resolved element (for the
// click-target listener to compare event.target against).
interface ResolvedTarget {
  rect: DOMRect | null;
  elementRef: React.MutableRefObject<HTMLElement | null>;
}

function useResolvedRect(targets: string[], step: number): ResolvedTarget {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (targets.length === 0) {
      elementRef.current = null;
      setRect((prev) => (prev === null ? prev : null));
      return;
    }

    const resolve = (): HTMLElement | null => {
      for (const name of targets) {
        const el = document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
        if (el) return el;
      }
      return null;
    };

    const measure = () => {
      const el = resolve();
      elementRef.current = el;
      setRect((prev) => {
        if (!el) return prev === null ? prev : null;
        const next = el.getBoundingClientRect();
        if (
          prev &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.height === next.height
        ) {
          return prev;
        }
        return next;
      });
    };

    // Measure immediately so the popover anchors on first paint.
    measure();

    // Re-measure on scroll / resize so the popover follows the target
    // when the operator scrolls inside the Today list or the thread
    // page. A polling interval (every 250ms while the step is active)
    // catches anchors that arrive after route navigation or content
    // re-renders without depending on rAF, which Strict-Mode dev
    // builds can drop on the first scheduled callback.
    const interval = window.setInterval(measure, 250);
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [targets, step]);

  return { rect, elementRef };
}

// Find the cuid for one of the pilot demo threads in the inbox. The
// runner-side endpoint only knows the platformThreadId — the dashboard's
// thread routes use cuids — so we look the row up via /runner/data/inbox
// once seeding completes.
async function resolveDemoIds(): Promise<PilotTourDemoIds> {
  try {
    const resp = await fetch("/runner/data/inbox", { credentials: "same-origin" });
    if (!resp.ok) return emptyDemoIds();
    const json = (await resp.json()) as {
      rows?: Array<{
        id: string;
        platform: string;
        platformThreadId?: string | null;
      }>;
    };
    const ids = emptyDemoIds();
    for (const row of json.rows ?? []) {
      if (row.platformThreadId === PILOT_TOUR_SERENA_THREAD_KEY) ids.serena = row.id;
      if (row.platformThreadId === PILOT_TOUR_TIMI_THREAD_KEY) ids.timi = row.id;
    }
    return ids;
  } catch {
    return emptyDemoIds();
  }
}

export function PilotTour() {
  const router = useRouter();
  const pathname = usePathname();
  // Memoised once per mount. `getPilotTourSteps` returns fresh arrays /
  // objects each call; without this the `targets` array reference would
  // change on every render and re-trigger `useResolvedRect`'s rAF loop,
  // which interacts badly with the auto-skip timer (the rect can race
  // long enough for the 1.5s safety net to fire on a perfectly valid
  // anchor).
  const steps = useMemo(() => getPilotTourSteps(), []);
  const [state, setState] = useState<PilotTourState>(() => ({
    active: false,
    stepIndex: 0,
    demoIds: emptyDemoIds(),
    bootstrapping: false
  }));
  // Guard against double-firing /end if both Skip and Esc fire fast.
  const endingRef = useRef(false);

  const endTour = useCallback(
    async (markSeen: boolean) => {
      if (endingRef.current) return;
      endingRef.current = true;
      setState((prev) => ({ ...prev, active: false, bootstrapping: false }));
      if (typeof window !== "undefined") {
        if (markSeen) markTourSeen(window.localStorage);
        clearTourActive(window.localStorage);
      }
      try {
        await apiPost("/runner/control/pilot-tour/end", {});
      } catch {
        // Already cleaned up server-side or runner unreachable; localStorage
        // is the source of truth for "is the user still in a tour".
      } finally {
        endingRef.current = false;
        // Pull Today's inbox back to the cleaned state.
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("runner-resync"));
        }
      }
    },
    []
  );

  // Skip-during-bootstrap is treated as "mark seen, no cleanup needed yet"
  // because seeding hasn't completed. Skip-after-seeding cleans up.
  const skipTour = useCallback(() => {
    if (!state.active) return;
    if (state.bootstrapping) {
      if (typeof window !== "undefined") {
        markTourSeen(window.localStorage);
        clearTourActive(window.localStorage);
      }
      setState((prev) => ({ ...prev, active: false, bootstrapping: false }));
      return;
    }
    void endTour(true);
  }, [endTour, state.active, state.bootstrapping]);

  const startTour = useCallback(
    async (replay: boolean) => {
      // Mark active immediately so the AppShell's stale-tour cleanup
      // doesn't kick in if anything below this awaits.
      if (typeof window !== "undefined") markTourActive(window.localStorage);
      setState({
        active: true,
        stepIndex: 0,
        demoIds: emptyDemoIds(),
        bootstrapping: true
      });
      endingRef.current = false;

      try {
        await apiPost<{
          ok: boolean;
          demoThreadIds?: { serena?: string; timi?: string };
        }>("/runner/control/pilot-tour/start", {});
      } catch {
        // Couldn't seed — back out and mark seen so we don't loop the
        // welcome card forever for a broken runner.
        if (typeof window !== "undefined") {
          markTourSeen(window.localStorage);
          clearTourActive(window.localStorage);
        }
        setState({
          active: false,
          stepIndex: 0,
          demoIds: emptyDemoIds(),
          bootstrapping: false
        });
        return;
      }

      // The /start response carries platformThreadIds; the dashboard
      // needs the row cuids to drive /thread/<id>. Refresh inbox-side
      // ids and dispatch a resync so Today shows the seeded rows.
      const demoIds = await resolveDemoIds();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("runner-resync"));
      }
      // Use the function form to avoid stomping a Skip that fired during
      // resolveDemoIds().
      setState((prev) =>
        prev.active
          ? { ...prev, demoIds, bootstrapping: false }
          : prev
      );
      // ESLint complains about `replay` being unused — it's intentional:
      // the dashboard treats start and replay identically server-side
      // (both seed fresh). Reserved in the signature so callers can
      // express intent and we can branch later without an API change.
      void replay;
    },
    []
  );

  // Listen for start events from the invite card / Settings replay button.
  useEffect(() => onPilotTourStart((replay) => void startTour(replay)), [startTour]);

  // Esc closes the tour without ending the runner-side state if it never
  // started, otherwise treats it as a skip with full cleanup.
  useEffect(() => {
    if (!state.active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        skipTour();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [skipTour, state.active]);

  const currentStep: PilotTourStep | null = state.active
    ? steps[state.stepIndex] ?? null
    : null;
  const targetNames = currentStep?.targets ?? [];
  const { rect, elementRef } = useResolvedRect(targetNames, state.stepIndex);

  // Forward / back step controls. Both go through the setState updater
  // so they can race a Skip without stomping it. `goNext` ends the tour
  // when called on the final step.
  const goNext = useCallback(() => {
    setState((prev) => {
      const next = nextStepIndex(steps, prev.stepIndex);
      if (next === null) {
        void endTour(true);
        return prev;
      }
      return { ...prev, stepIndex: next };
    });
  }, [endTour, steps]);

  const goBack = useCallback(() => {
    setState((prev) => ({ ...prev, stepIndex: prevStepIndex(steps, prev.stepIndex) }));
  }, [steps]);

  // Click-target steps: listen for a click that lands inside the
  // resolved target element and advance. We do NOT preventDefault — the
  // page's own handler (e.g. the Link that opens the demo thread) still
  // fires, which is exactly what makes the step feel like the real
  // interaction rather than a tour-driven jump. Capture phase so we see
  // the click before React's synthetic event system tears it apart on
  // unmount during route navigation.
  useEffect(() => {
    if (!currentStep || currentStep.continueMode !== "click-target") return undefined;
    const onCapture = (event: MouseEvent) => {
      const el = elementRef.current;
      if (!el) return;
      const node = event.target instanceof Node ? event.target : null;
      if (!node || !el.contains(node)) return;
      // Use the bare setState updater so a Skip / Esc that fired in the
      // same frame still wins. We don't preventDefault — the real click
      // continues to the Link / button on the page.
      goNext();
    };
    document.addEventListener("click", onCapture, true);
    return () => document.removeEventListener("click", onCapture, true);
  }, [currentStep, elementRef, goNext]);

  // Run the step's optional navigation when the step changes. Wait one
  // tick before the next render so the next step's selectors can resolve
  // against the freshly-mounted route.
  const stepRouteRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentStep) return;
    const target = currentStep.navigateTo?.(state.demoIds) ?? null;
    if (!target) {
      stepRouteRef.current = null;
      return;
    }
    if (target === pathname) {
      stepRouteRef.current = target;
      return;
    }
    stepRouteRef.current = target;
    router.push(target);
  }, [currentStep, pathname, router, state.demoIds]);

  // Auto-advance if a step's targets never resolve — purely a safety net
  // for steps where the anchor genuinely isn't in the DOM (e.g. the Reply
  // Brief branch isn't merged so its specific anchors are missing). The
  // safety net is intentionally narrow:
  //   - It only fires while the rect is still null.
  //   - It does NOT fire during bootstrap (Today is re-rendering and
  //     anchors can briefly read as missing).
  //   - It does NOT fire on click-target steps. Those are explicitly
  //     waiting on operator action; the operator should decide when to
  //     move on, not a timer.
  //   - 5s buffer accommodates slow renders without making the tour feel
  //     stuck on a real missing anchor.
  const skipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!currentStep) return undefined;
    if (currentStep.targets.length === 0) return undefined; // anchor-less step
    if (currentStep.continueMode === "click-target") return undefined;
    if (state.bootstrapping) return undefined;
    if (rect) {
      if (skipTimerRef.current) {
        clearTimeout(skipTimerRef.current);
        skipTimerRef.current = null;
      }
      return undefined;
    }
    skipTimerRef.current = setTimeout(() => {
      goNext();
    }, 5000);
    return () => {
      if (skipTimerRef.current) {
        clearTimeout(skipTimerRef.current);
        skipTimerRef.current = null;
      }
    };
  }, [currentStep, goNext, rect, state.bootstrapping]);

  // Render nothing when the tour isn't running.
  if (!state.active || !currentStep) return null;

  const isAnchored = currentStep.targets.length > 0 && rect !== null;
  const isLast = isLastStep(steps, state.stepIndex);

  // Popover position. When anchored, sit beside the target rect using the
  // declared placement; when un-anchored (or rect is missing), centre on
  // the viewport. Tailwind classes here are intentionally simple — no
  // animations beyond a soft fade so the tour stays calm.
  const placement = currentStep.placement ?? "bottom";
  const popover = (() => {
    const w = 360;
    if (!isAnchored || !rect) {
      return {
        top: `calc(50% - 88px)`,
        left: `calc(50% - ${w / 2}px)`,
        width: w
      };
    }
    const gap = 14;
    let top = rect.top + rect.height + gap;
    let left = rect.left;
    if (placement === "top") {
      top = rect.top - gap - 180;
    } else if (placement === "left") {
      top = rect.top;
      left = rect.left - w - gap;
    } else if (placement === "right") {
      top = rect.top;
      left = rect.left + rect.width + gap;
    } else if (placement === "center") {
      top = Math.max(24, rect.top + rect.height / 2 - 90);
      left = Math.max(24, rect.left + rect.width / 2 - w / 2);
    }
    // Clamp to viewport so the popover never spills off-screen.
    const maxLeft = Math.max(24, window.innerWidth - w - 24);
    const maxTop = Math.max(24, window.innerHeight - 220);
    return {
      top: Math.max(24, Math.min(top, maxTop)),
      left: Math.max(24, Math.min(left, maxLeft)),
      width: w
    };
  })();

  const isFirst = state.stepIndex === 0;
  const isClickTarget = currentStep.continueMode === "click-target";
  // The popover arrow sits on whichever edge of the popover faces the
  // target. Anchorless / centered steps get no arrow.
  const arrowStyle: React.CSSProperties | null = (() => {
    if (!isAnchored) return null;
    if (placement === "center") return null;
    const size = 8;
    const base: React.CSSProperties = { position: "absolute", width: 0, height: 0 };
    // The triangle is drawn with CSS borders; the side facing the
    // popover bg is opaque, the others transparent. `--paper` matches
    // the popover background so the arrow visually continues the card.
    const paperBg = "var(--paper)";
    if (placement === "top") {
      return {
        ...base,
        bottom: -size,
        left: "50%",
        transform: "translateX(-50%)",
        borderStyle: "solid",
        borderColor: `${paperBg} transparent transparent transparent`,
        borderWidth: `${size}px ${size}px 0 ${size}px`
      };
    }
    if (placement === "bottom") {
      return {
        ...base,
        top: -size,
        left: "50%",
        transform: "translateX(-50%)",
        borderStyle: "solid",
        borderColor: `transparent transparent ${paperBg} transparent`,
        borderWidth: `0 ${size}px ${size}px ${size}px`
      };
    }
    if (placement === "left") {
      return {
        ...base,
        right: -size,
        top: 32,
        borderStyle: "solid",
        borderColor: `transparent transparent transparent ${paperBg}`,
        borderWidth: `${size}px 0 ${size}px ${size}px`
      };
    }
    // right
    return {
      ...base,
      left: -size,
      top: 32,
      borderStyle: "solid",
      borderColor: `transparent ${paperBg} transparent transparent`,
      borderWidth: `${size}px ${size}px ${size}px 0`
    };
  })();

  return (
    <div
      data-testid="pilot-tour-overlay"
      className="pointer-events-none fixed inset-0 z-[80]"
      aria-live="polite"
    >
      {/* Dim the page WITHOUT blurring. Two render modes:
           - Anchored steps: the highlight ring's box-shadow paints
             everything outside the target rect — the target itself
             stays crisp and readable. No separate full-page dim layer
             is rendered, so nothing covers the highlighted UI.
           - Anchorless / centered steps: a flat dim covers the whole
             viewport so the popover stands out. */}
      {isAnchored && rect ? (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-card ring-2 ring-accent/70 transition-[top,left,width,height] duration-200"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)"
          }}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-ink/25" />
      )}

      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="pilot-tour-title"
        data-tour-popover="true"
        className="pointer-events-auto absolute rounded-card border border-hairline bg-paper p-5 shadow-pop"
        style={popover}
      >
        {arrowStyle ? <span aria-hidden style={arrowStyle} /> : null}
        <div className="flex items-start justify-between gap-3">
          <p className="m-0 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            {state.bootstrapping
              ? "Setting up demo…"
              : `Step ${state.stepIndex + 1} of ${steps.length}`}
          </p>
          <button
            type="button"
            onClick={skipTour}
            aria-label="Skip the walkthrough"
            title="Skip (Esc)"
            className="-mr-1 -mt-1 grid h-7 w-7 place-items-center rounded-[8px] text-ink-3 transition-colors duration-calm hover:bg-paper-2 hover:text-ink"
          >
            ×
          </button>
        </div>

        {currentStep.beat ? (
          <p className="m-0 mt-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-ink">
            · {currentStep.beat} ·
          </p>
        ) : null}

        <h3
          id="pilot-tour-title"
          className="m-0 mt-2 max-w-[34ch] font-display text-[18px] font-semibold tracking-[-0.018em]"
        >
          {currentStep.title}
        </h3>
        <p className="m-0 mt-2 max-w-[44ch] text-[13.5px] leading-[1.55] text-ink-2">
          {currentStep.body}
        </p>

        {/* Click-target hint: a tiny "click the highlighted area"
            caption replaces the Next button on click-target steps so
            the operator knows the demo wants a real click. */}
        {isClickTarget && !state.bootstrapping ? (
          <p
            data-testid="pilot-tour-click-hint"
            className="mt-3 font-mono text-[10.5px] uppercase tracking-[0.07em] text-accent-ink"
          >
            · Click the highlighted area ·
          </p>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={skipTour}
            className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-3 hover:text-ink"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="pilot-tour-back"
              onClick={goBack}
              disabled={isFirst || state.bootstrapping}
              className="inline-flex items-center rounded-pill border border-hairline px-[12px] py-[6px] text-[12px] font-medium text-ink-2 transition-colors duration-calm hover:border-hairline-strong hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              Back
            </button>
            {isClickTarget ? null : (
              <button
                type="button"
                data-testid="pilot-tour-next"
                onClick={goNext}
                disabled={state.bootstrapping}
                className="inline-flex items-center rounded-pill bg-ink px-[14px] py-[7px] text-[12.5px] font-medium text-paper transition-colors duration-calm hover:bg-[oklch(28%_0.01_80)] disabled:cursor-wait disabled:opacity-60"
              >
                {state.bootstrapping ? "Just a moment…" : isLast ? "Done" : "Next"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One-shot recovery sweep. AppShell calls this on cold mount to clean
 * up a stale demo-sandbox manifest from a previous session that didn't
 * exit cleanly. Module-level guard ensures it never fires twice within
 * the same JS session — so route navigation (which doesn't remount the
 * root layout) cannot trigger it, and a fresh tour started AFTER mount
 * isn't aborted by this sweep.
 */
let recoveryRan = false;
export async function recoverAbandonedTourIfAny(): Promise<void> {
  if (recoveryRan) return;
  recoveryRan = true;
  if (typeof window === "undefined") return;
  if (!isTourActive(window.localStorage)) return;
  // localStorage carried an "active" flag from a previous tab/session.
  // The current page has no in-memory tour state, so seeded data is
  // certainly orphaned. POST end (server-side cleanup is idempotent)
  // and clear the flag.
  try {
    await apiPost("/runner/control/pilot-tour/end", {});
  } catch {
    // Runner unreachable — leave the active flag in place so we'll try
    // again on the next cold mount. Without contacting the runner we
    // cannot safely clear demo data anyway.
    recoveryRan = false;
    return;
  }
  window.localStorage.removeItem(PILOT_TOUR_ACTIVE_KEY);
  window.dispatchEvent(new CustomEvent("runner-resync"));
}
