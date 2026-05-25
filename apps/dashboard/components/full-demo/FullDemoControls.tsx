"use client";

import { useFullDemo } from "./FullDemoProvider";

/**
 * Compact control bar shown inside the overlay tooltip card. Buttons:
 *   Back · Next · Pause/Autoplay · Restart · Exit
 * Plus a small "step n / total" counter.
 */
export function FullDemoControls() {
  const { stepIndex, visibleStepCount, autoplay, setAutoplay, next, back, goToStepId, exit } = useFullDemo();
  const isFirst = stepIndex === 0;
  const isLast = stepIndex >= visibleStepCount - 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-ink-3">
        <span>
          Step {stepIndex + 1} of {visibleStepCount}
        </span>
        <button
          type="button"
          onClick={() => setAutoplay(!autoplay)}
          className="text-xs font-medium text-ink-2 hover:text-ink"
          data-demo-target="full-demo-autoplay"
        >
          {autoplay ? "Pause autoplay" : "Autoplay"}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={back}
          disabled={isFirst}
          className="rounded-pill border border-hairline bg-paper px-3 py-1 text-sm text-ink-2 hover:border-hairline-strong disabled:cursor-not-allowed disabled:opacity-50"
          data-demo-target="full-demo-back"
        >
          Back
        </button>
        <button
          type="button"
          onClick={next}
          disabled={isLast}
          className="rounded-pill bg-ink px-3 py-1 text-sm text-paper hover:bg-[oklch(28%_0.01_80)] disabled:cursor-not-allowed disabled:opacity-50"
          data-demo-target="full-demo-next"
        >
          Next
        </button>
        <button
          type="button"
          onClick={() => goToStepId("opening")}
          className="ml-auto text-xs font-medium text-ink-3 hover:text-ink-2"
          data-demo-target="full-demo-restart"
        >
          Restart
        </button>
        <button
          type="button"
          onClick={() => void exit()}
          className="text-xs font-medium text-ink-3 hover:text-ink-2"
          data-demo-target="full-demo-exit"
        >
          Exit
        </button>
      </div>
    </div>
  );
}
