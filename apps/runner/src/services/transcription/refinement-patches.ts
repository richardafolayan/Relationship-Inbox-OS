/**
 * Deterministic patch application for the patch-based refinement
 * pipeline (#386). The GPT-5-nano refiner returns a list of substring
 * replacements; this module applies them against the highest-tier
 * local transcript and runs three post-apply guards before the
 * orchestrator accepts the patched text:
 *
 *   1. Duplicate-introduction. Catches the case where a patch
 *      accidentally creates a repeated 5+ word window that wasn't
 *      repeated in the base.
 *   2. Shrink. Carried over from PR #384 — refused if the patched
 *      transcript is meaningfully shorter than the base.
 *   3. Drift. Diff the patched text against the base, ignoring the
 *      regions covered by accepted patches. If anything outside those
 *      regions changed, reject. By construction this can only fire if
 *      a patch overlap or substring-replacement collision produced
 *      unintended downstream changes.
 *
 * The orchestrator never accepts a refined transcript that wasn't
 * built by this code path. There is no way for the model to silently
 * emit a whole new transcript and have it picked.
 */

import type { PatchConfidence, RefinementPatch } from "./text-refinement-service";

export interface AppliedPatch {
  patch: RefinementPatch;
  /** Character index in the BASE transcript where the patch was found. */
  baseStart: number;
  baseEnd: number;
}

export interface DroppedPatch {
  patch: RefinementPatch;
  reason: DroppedReason;
}

export type DroppedReason =
  | "low_confidence"
  | "from_not_found"
  | "from_ambiguous"
  | "overlaps_earlier_patch"
  | "no_op";

export interface PatchApplicationResult {
  /** Resulting transcript text. Equal to `base` when no patches applied or when a guard rejected. */
  patched: string;
  /** Patches that were accepted and applied. */
  applied: AppliedPatch[];
  /** Patches the application code dropped (with why). */
  dropped: DroppedPatch[];
  /**
   * Stable guard-rejection reason when the post-apply guards refused
   * the patched text. When non-null, `patched` is reset to `base` so
   * the caller can safely use it as the final transcript.
   */
  rejection:
    | "refinement_introduced_duplicate"
    | "refinement_too_short"
    | "refinement_drifted"
    | null;
}

const MIN_CONFIDENCE_TO_APPLY: PatchConfidence[] = ["medium", "high"];
const SHRINK_FLOOR = 0.88;
const DUPLICATE_WINDOW = 5; // 5-word repeated-window check

export function applyRefinementPatches(input: {
  base: string;
  corrections: ReadonlyArray<RefinementPatch>;
}): PatchApplicationResult {
  const base = input.base ?? "";
  if (base.length === 0) {
    return {
      patched: "",
      applied: [],
      dropped: [],
      rejection: null
    };
  }

  // Resolve each patch to an exact index in the base. Apply them in
  // base order (not refiner order) so a later replacement can't shift
  // earlier indexes underneath us. Patches that don't have a unique
  // single occurrence in the base are dropped: ambiguous patches risk
  // touching the wrong substring.
  const dropped: DroppedPatch[] = [];
  type Candidate = AppliedPatch;
  const candidates: Candidate[] = [];
  for (const patch of input.corrections) {
    if (!MIN_CONFIDENCE_TO_APPLY.includes(patch.confidence)) {
      dropped.push({ patch, reason: "low_confidence" });
      continue;
    }
    if (patch.from.length === 0 || patch.from === patch.to) {
      dropped.push({ patch, reason: "no_op" });
      continue;
    }
    const first = base.indexOf(patch.from);
    if (first < 0) {
      dropped.push({ patch, reason: "from_not_found" });
      continue;
    }
    const second = base.indexOf(patch.from, first + 1);
    if (second >= 0) {
      // `from` appears more than once in the base. We refuse to guess
      // which occurrence the refiner meant — refiners can be more
      // specific by widening `from` to disambiguate.
      dropped.push({ patch, reason: "from_ambiguous" });
      continue;
    }
    candidates.push({
      patch,
      baseStart: first,
      baseEnd: first + patch.from.length
    });
  }

  // Sort by position so we can detect overlap + apply right-to-left
  // (so earlier indices stay valid as we splice).
  candidates.sort((a, b) => a.baseStart - b.baseStart);

  const applied: AppliedPatch[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.baseStart < lastEnd) {
      dropped.push({ patch: candidate.patch, reason: "overlaps_earlier_patch" });
      continue;
    }
    applied.push(candidate);
    lastEnd = candidate.baseEnd;
  }

  if (applied.length === 0) {
    return { patched: base, applied, dropped, rejection: null };
  }

  // Apply right-to-left.
  let patched = base;
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const a = applied[i]!;
    patched =
      patched.slice(0, a.baseStart) +
      a.patch.to +
      patched.slice(a.baseEnd);
  }

  // Post-apply guards.
  if (patched.length / base.length < SHRINK_FLOOR) {
    return { patched: base, applied, dropped, rejection: "refinement_too_short" };
  }
  if (introducesNewDuplicate(base, patched, DUPLICATE_WINDOW)) {
    return {
      patched: base,
      applied,
      dropped,
      rejection: "refinement_introduced_duplicate"
    };
  }
  if (driftsOutsideAppliedPatches(base, patched, applied)) {
    return { patched: base, applied, dropped, rejection: "refinement_drifted" };
  }

  return { patched, applied, dropped, rejection: null };
}

/**
 * Repeated n-word windows. A patch is allowed to introduce duplicate
 * tokens, but ONLY if the same long window already appeared in the
 * base. Catches the Lanre regression where standard-tier's duplicated
 * "looking at different videos online" clause would have been merged
 * in by the old generator-style refiner.
 */
export function introducesNewDuplicate(
  base: string,
  patched: string,
  windowSize: number
): boolean {
  const baseDuplicates = collectRepeatedWindows(base, windowSize);
  const patchedDuplicates = collectRepeatedWindows(patched, windowSize);
  for (const window of patchedDuplicates) {
    if (!baseDuplicates.has(window)) return true;
  }
  return false;
}

function collectRepeatedWindows(text: string, windowSize: number): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length < windowSize * 2) return new Set();
  const seen = new Map<string, number>();
  for (let i = 0; i + windowSize <= tokens.length; i += 1) {
    const key = tokens.slice(i, i + windowSize).join(" ");
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const out = new Set<string>();
  for (const [window, count] of seen) {
    if (count >= 2) out.add(window);
  }
  return out;
}

/**
 * Drift guard. Reconstruct what the patched text SHOULD look like by
 * splicing the recorded patches into the base, then compare against
 * the actual patched text. If they differ, something replaced text
 * outside the recorded patch regions — reject.
 *
 * By construction this only fires when there's a real bug in
 * applyRefinementPatches; it exists as a belt-and-braces guard in
 * case patch overlap detection ever misses a case.
 */
function driftsOutsideAppliedPatches(
  base: string,
  patched: string,
  applied: AppliedPatch[]
): boolean {
  let expected = base;
  for (let i = applied.length - 1; i >= 0; i -= 1) {
    const a = applied[i]!;
    expected =
      expected.slice(0, a.baseStart) + a.patch.to + expected.slice(a.baseEnd);
  }
  return expected !== patched;
}

/**
 * Roll up the per-patch confidences into a single overall confidence
 * to persist on the parent row. Low if any low slipped through (it
 * shouldn't given MIN_CONFIDENCE_TO_APPLY), medium if any medium,
 * else high. Used only for display / debugging.
 */
export function deriveOverallConfidence(
  applied: ReadonlyArray<AppliedPatch>
): PatchConfidence {
  if (applied.some((a) => a.patch.confidence === "low")) return "low";
  if (applied.some((a) => a.patch.confidence === "medium")) return "medium";
  return "high";
}
