"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { GuidedTour } from "@/components/common/GuidedTour";
import { useFullDemo } from "@/components/full-demo/FullDemoProvider";
import {
  clearTourActive,
  getPilotTourSteps,
  markTourActive,
  markTourSeen,
  onPilotTourStart,
  PILOT_TOUR_ACTIVE_KEY
} from "@/lib/pilot-tour";

/**
 * Pilot first-run walkthrough. Mounts once at the app shell and listens
 * for `pilot-tour-start` window events from the invite card / settings
 * replay button. Drives the shared GuidedTour primitive with the eight
 * pilot steps.
 *
 * The sandbox seed (Serena, Timi, and the rest of the showcase) is owned
 * by the FullDemoProvider. The pilot tour piggybacks on that lifecycle:
 * `start("sandbox")` on tour start, `exit()` on tour end / skip. This
 * keeps one source of truth for sandbox mode and one route for cleanup.
 */
interface PilotTourState {
  active: boolean;
  stepIndex: number;
  /** True while POSTing the sandbox start; gates the Next button. */
  bootstrapping: boolean;
}

export function PilotTour() {
  const router = useRouter();
  const pathname = usePathname();
  const fullDemo = useFullDemo();
  const steps = useMemo(() => getPilotTourSteps(), []);
  const [state, setState] = useState<PilotTourState>({
    active: false,
    stepIndex: 0,
    bootstrapping: false
  });
  const endingRef = useRef(false);

  const endTour = useCallback(
    async (markSeen: boolean) => {
      if (endingRef.current) return;
      endingRef.current = true;
      setState({ active: false, stepIndex: 0, bootstrapping: false });
      if (typeof window !== "undefined") {
        if (markSeen) markTourSeen(window.localStorage);
        clearTourActive(window.localStorage);
      }
      try {
        // The sandbox is shared with the full presenter demo. Exit
        // cleanly via the presenter reset endpoint so the runner
        // tears the seed data down on this path too.
        await fullDemo.exit();
      } catch {
        /* already cleaned up or runner unreachable; localStorage is the source of truth. */
      } finally {
        endingRef.current = false;
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("runner-resync"));
        }
      }
    },
    [fullDemo]
  );

  const skipTour = useCallback(() => {
    if (!state.active) return;
    // If the sandbox is still bootstrapping, just close the card and
    // mark seen. The provider's exit handler is reentrant; calling it
    // here on a half-seeded sandbox would race.
    if (state.bootstrapping) {
      if (typeof window !== "undefined") {
        markTourSeen(window.localStorage);
        clearTourActive(window.localStorage);
      }
      setState({ active: false, stepIndex: 0, bootstrapping: false });
      return;
    }
    void endTour(true);
  }, [endTour, state.active, state.bootstrapping]);

  const startTour = useCallback(
    async (replay: boolean) => {
      if (typeof window !== "undefined") markTourActive(window.localStorage);
      setState({ active: true, stepIndex: 0, bootstrapping: true });
      endingRef.current = false;
      try {
        await fullDemo.startPilotSandbox();
      } catch {
        if (typeof window !== "undefined") {
          markTourSeen(window.localStorage);
          clearTourActive(window.localStorage);
        }
        setState({ active: false, stepIndex: 0, bootstrapping: false });
        return;
      }
      setState((prev) => (prev.active ? { ...prev, bootstrapping: false } : prev));
      void replay;
    },
    [fullDemo]
  );

  useEffect(() => onPilotTourStart((replay) => void startTour(replay)), [startTour]);

  const goNext = useCallback(() => {
    setState((prev) => {
      const next = prev.stepIndex + 1;
      if (next >= steps.length) {
        void endTour(true);
        return prev;
      }
      return { ...prev, stepIndex: next };
    });
  }, [endTour, steps.length]);

  const goBack = useCallback(() => {
    setState((prev) => ({
      ...prev,
      stepIndex: prev.stepIndex > 0 ? prev.stepIndex - 1 : 0
    }));
  }, []);

  // Step-driven navigation. Runs whenever the step changes; the GuidedTour
  // primitive does anchor measurement but not route changes, so the
  // navigation belongs here.
  useEffect(() => {
    if (!state.active) return;
    const step = steps[state.stepIndex];
    if (!step) return;
    const target = step.navigateTo?.() ?? null;
    if (!target) return;
    if (target === pathname) return;
    router.push(target);
  }, [pathname, router, state.active, state.stepIndex, steps]);

  // If the presenter walkthrough takes over (e.g. operator navigates to
  // /demo and starts the presenter walk), bow out cleanly. The presenter
  // flow now owns the sandbox; close the pilot card without resetting
  // anything else.
  useEffect(() => {
    if (!state.active) return;
    if (fullDemo.flow === "presenter") {
      setState({ active: false, stepIndex: 0, bootstrapping: false });
      if (typeof window !== "undefined") {
        clearTourActive(window.localStorage);
      }
    }
  }, [fullDemo.flow, state.active]);

  // Cold-start cleanup: if a previous session left the active flag on
  // but no flow is now running, clear it. AppShell may also do this; the
  // belt-and-braces is cheap.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (state.active) return;
    if (window.localStorage.getItem(PILOT_TOUR_ACTIVE_KEY) === "1") {
      clearTourActive(window.localStorage);
    }
  }, [state.active]);

  if (!state.active) return null;

  return (
    <GuidedTour
      steps={steps}
      stepIndex={state.stepIndex}
      active
      variant="pilot"
      busy={state.bootstrapping}
      onNext={goNext}
      onBack={goBack}
      onSkip={skipTour}
    />
  );
}
