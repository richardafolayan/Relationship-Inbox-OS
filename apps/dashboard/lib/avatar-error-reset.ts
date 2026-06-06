// Decision guard for PersonAvatar's image-error recovery.
//
// PersonAvatar keeps a single `errored` flag, set by the <img> onError handler
// when a hotlinked (signed, expiring) LinkedIn avatar fails to load. The
// component is rendered inside thread-row lists keyed by a stable row.id and
// polled in place every ~10s; the runner re-derives personAvatarUrl fresh from
// person.avatarUrl on each fetch. Because LinkedIn avatar URLs are signed and
// rotate, a still-mounted row can receive a DIFFERENT, valid avatarUrl over
// time. Once `errored` flips to true it must be cleared on that URL change, or
// showImage stays false forever and the new image is never attempted -
// defeating the documented "onError falls through to the initials tile until
// the next scan refreshes the row" recovery.
//
// `shouldResetAvatarError` is the single decision: reset the error state only
// when the incoming URL differs from the one the current error was recorded
// against. Same URL (including null -> null) must NOT reset, so a genuinely
// broken URL keeps showing the initials tile instead of thrashing.
export function shouldResetAvatarError(
  lastUrl: string | null | undefined,
  nextUrl: string | null | undefined
): boolean {
  return lastUrl !== nextUrl;
}
