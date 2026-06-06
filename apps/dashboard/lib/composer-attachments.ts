// Pure helpers for the thread composer's staged-attachment list.
//
// Extracted from app/thread/[id]/page.tsx so the failed-send restore decision
// is unit-testable without React. The composer optimistically clears its
// attachment list when a send starts; if the send later fails we have to put
// the attachments back. The operator may have staged *new* attachments in the
// meantime, so the restore must merge, not overwrite.

export interface ComposerAttachmentLike {
  id: string;
  previewUrl: string;
}

/**
 * Restore the attachments from a failed send without discarding anything the
 * operator staged while the send was in flight.
 *
 * The failed attachments are prepended to the current (post-clear) list. The
 * optimistic clear emptied the list at send time, so `current` holds only
 * items added after the clear; the two lists are disjoint, so prepending
 * produces no duplicates. Because nothing is dropped, no previewUrl object
 * URLs leak (the old overwrite behaviour dropped the freshly-staged items and
 * their URLs were never revoked).
 */
export function restoreFailedAttachments<T extends ComposerAttachmentLike>(
  failed: readonly T[],
  current: readonly T[]
): T[] {
  return [...failed, ...current];
}
