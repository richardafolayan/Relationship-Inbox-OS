import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveLinkedInScanFailureReason,
  resolveLinkedInCollectionStopReason,
  shouldStopLinkedInCollection,
  updateLinkedInCollectionStability
} from "../apps/runner/dist/platforms/linkedin-adapter.js";

test("LinkedIn collector stability counters reset on growth and increment on no-growth", () => {
  const grew = updateLinkedInCollectionStability({
    previousCount: 12,
    nextCount: 24,
    previousTrailingKey: "thread-12",
    nextTrailingKey: "thread-24",
    noGrowthIterations: 2,
    trailingRepeatIterations: 1
  });

  assert.equal(grew.noGrowthIterations, 0);
  assert.equal(grew.trailingRepeatIterations, 0);

  const noGrowth = updateLinkedInCollectionStability({
    previousCount: 24,
    nextCount: 24,
    previousTrailingKey: "thread-24",
    nextTrailingKey: "thread-24",
    noGrowthIterations: grew.noGrowthIterations,
    trailingRepeatIterations: grew.trailingRepeatIterations
  });

  assert.equal(noGrowth.noGrowthIterations, 1);
  assert.equal(noGrowth.trailingRepeatIterations, 1);
});

test("LinkedIn collector stop conditions respect balanced depth policy", () => {
  assert.equal(
    shouldStopLinkedInCollection({
      uniqueCount: 200,
      maxThreads: 200,
      noGrowthIterations: 0,
      trailingRepeatIterations: 0,
      stableIterations: 3,
      didScroll: true,
      reachedBottom: false
    }),
    true
  );

  assert.equal(
    shouldStopLinkedInCollection({
      uniqueCount: 44,
      maxThreads: 200,
      noGrowthIterations: 3,
      trailingRepeatIterations: 0,
      stableIterations: 3,
      didScroll: true,
      reachedBottom: true
    }),
    true
  );

  assert.equal(
    shouldStopLinkedInCollection({
      uniqueCount: 44,
      maxThreads: 200,
      noGrowthIterations: 0,
      trailingRepeatIterations: 0,
      stableIterations: 3,
      didScroll: true,
      reachedBottom: false
    }),
    false
  );
});

test("LinkedIn collector can continue past first viewport while thread count is growing", () => {
  let noGrowthIterations = 0;
  let trailingRepeatIterations = 0;
  let previousTrailingKey = null;

  const iterations = [
    { previousCount: 0, nextCount: 12, trailingKey: "thread-12", didScroll: true, reachedBottom: false },
    { previousCount: 12, nextCount: 28, trailingKey: "thread-28", didScroll: true, reachedBottom: false },
    { previousCount: 28, nextCount: 41, trailingKey: "thread-41", didScroll: true, reachedBottom: false }
  ];

  for (const iteration of iterations) {
    const stability = updateLinkedInCollectionStability({
      previousCount: iteration.previousCount,
      nextCount: iteration.nextCount,
      previousTrailingKey,
      nextTrailingKey: iteration.trailingKey,
      noGrowthIterations,
      trailingRepeatIterations
    });
    noGrowthIterations = stability.noGrowthIterations;
    trailingRepeatIterations = stability.trailingRepeatIterations;
    previousTrailingKey = iteration.trailingKey;

    const shouldStop = shouldStopLinkedInCollection({
      uniqueCount: iteration.nextCount,
      maxThreads: 200,
      noGrowthIterations,
      trailingRepeatIterations,
      stableIterations: 3,
      didScroll: iteration.didScroll,
      reachedBottom: iteration.reachedBottom
    });
    assert.equal(shouldStop, false);
  }

  assert.equal(iterations[0].nextCount < iterations[1].nextCount, true);
  assert.equal(iterations[1].nextCount < iterations[2].nextCount, true);
});

test("LinkedIn collector emits deterministic stop reason for audit metrics", () => {
  const stopReason = resolveLinkedInCollectionStopReason({
    uniqueCount: 92,
    maxThreads: 200,
    noGrowthIterations: 3,
    trailingRepeatIterations: 1,
    stableIterations: 3,
    didScroll: true,
    reachedBottom: true
  });

  assert.equal(stopReason, "end_of_list_no_progress");
});

test("LinkedIn scan failure reason classifies __name helper leakage explicitly", () => {
  const reason = resolveLinkedInScanFailureReason({
    message: "page.evaluate: ReferenceError: __name is not defined"
  });

  assert.equal(reason, "evaluate_helper_missing");
});

test("LinkedIn scan failure reason classifies generic reference errors separately", () => {
  const reason = resolveLinkedInScanFailureReason({
    message: "ReferenceError: someInjectedHelper is not defined"
  });

  assert.equal(reason, "evaluate_reference_error");
});
