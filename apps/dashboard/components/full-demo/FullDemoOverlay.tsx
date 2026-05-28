"use client";

import { useMemo } from "react";

import { GuidedTour } from "@/components/common/GuidedTour";
import type { GuidedTourStep } from "@/lib/guided-tour";
import { FULL_DEMO_SCRIPT, isStepInMode, type DemoStep, type FullDemoMode } from "@/lib/full-demo-script";

import { useFullDemo } from "./FullDemoProvider";

/**
 * Floating overlay for the full presenter demo. Thin wrapper around the
 * shared `GuidedTour` primitive — owns step-to-tour-step translation and
 * the autoplay toggle in the footer; everything else (positioning,
 * dragging, spotlight, arrow, controls) lives in the primitive.
 */
export function FullDemoOverlay() {
  const {
    active,
    mode,
    stepIndex,
    currentStep,
    autoplay,
    setAutoplay,
    next,
    back,
    goToStepId,
    exit,
    threadIdMap
  } = useFullDemo();

  const tourSteps = useMemo<GuidedTourStep[]>(
    () =>
      FULL_DEMO_SCRIPT.filter((s) => isStepInMode(s, mode ?? "sandbox")).map((s) =>
        toGuidedTourStep(s, mode ?? "sandbox", threadIdMap)
      ),
    [mode, threadIdMap]
  );

  if (!active || !currentStep) return null;

  return (
    <GuidedTour
      steps={tourSteps}
      stepIndex={stepIndex}
      active={active}
      variant="presenter"
      hideSkip
      showRestart
      showExit
      onNext={next}
      onBack={back}
      onRestart={() => {
        const firstStep = FULL_DEMO_SCRIPT.find((s) => isStepInMode(s, mode ?? "sandbox"));
        if (firstStep) goToStepId(firstStep.id);
      }}
      onExit={() => void exit()}
      renderFooterExtra={() => (
        <button
          type="button"
          onClick={() => setAutoplay(!autoplay)}
          className="text-[11.5px] font-medium text-ink-3 hover:text-ink-2"
          data-demo-target="full-demo-autoplay"
          data-testid="presenter-tour-autoplay"
        >
          {autoplay ? "Pause autoplay" : "Start autoplay"}
        </button>
      )}
    />
  );
}

function toGuidedTourStep(
  step: DemoStep,
  mode: FullDemoMode,
  threadIdMap: Map<string, string>
): GuidedTourStep {
  return {
    key: step.id,
    title: step.title,
    body: step.body,
    targets: step.target ? [step.target] : [],
    placement: step.placement ?? "bottom",
    navigateTo: () => {
      if (step.threadPlatformId) {
        const resolved = threadIdMap.get(step.threadPlatformId);
        return resolved ? `/thread/${resolved}` : null;
      }
      return step.route ?? null;
    }
  };
}
