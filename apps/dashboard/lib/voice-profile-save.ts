import type { OperatorProfile } from "@/lib/types";

// UserVoiceProfile auto-saves its text fields on a debounce. When the
// component unmounts (e.g. the onboarding card closes as soon as the
// operator clicks "Done, take me in", or they navigate away), a save that is
// still waiting on the debounce must be flushed rather than dropped — losing
// the just-typed name is the bug this guards against.
//
// This module is intentionally framework-free so the flush decision can be
// unit-tested without React. The component stores the latest queued save in a
// ref and, on unmount, calls buildPendingSavePartial to turn it into the
// partial to persist (or null if nothing is pending).

export type PendingProfileSave = {
  field: keyof OperatorProfile;
  value: string;
};

// Build the partial profile to persist for a still-pending debounced save.
// Returns null when there is nothing queued, so callers can skip the write.
// The typed value is passed through verbatim (including empty / whitespace) —
// we persist exactly what the field held when the debounce was scheduled.
export function buildPendingSavePartial(
  pending: PendingProfileSave | null | undefined
): Partial<OperatorProfile> | null {
  if (!pending) return null;
  return { [pending.field]: pending.value } as Partial<OperatorProfile>;
}
