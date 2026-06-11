"use client";

import { warmApiGet } from "./api";

// Hover/focus prefetch for inbox & today rows.
//
// Rows are <Link>s, so Next already prefetches the route's JS chunk on
// hover/in-viewport. What it never prefetches is the row's DATA, so the
// click always paid a cold /data/thread round-trip. This warms that exact
// endpoint into the shared apiGet cache (same path + default window the
// thread page reads) so the conversation paints instantly on click.
//
// A single module-level debounce timer is enough, but it must be
// row-aware: keyboard focus (onFocus) and mouse hover (onMouseEnter) are
// two independent input paths, so a different row's onMouseLeave can fire
// while a focus-scheduled prefetch is still pending. We therefore remember
// which row scheduled the pending timer and only let a cancel for THAT row
// clear it - an unrelated row's cancel is ignored. The 5s TTL means
// re-hovering the same row doesn't re-fetch.

let timer: ReturnType<typeof setTimeout> | null = null;
let pendingId: string | null = null;

export function prefetchThreadData(threadId: string): void {
  if (!threadId) return;
  if (timer) clearTimeout(timer);
  pendingId = threadId;
  timer = setTimeout(() => {
    timer = null;
    pendingId = null;
    prefetchThreadDataNow(threadId);
  }, 80);
}

// Immediate (undebounced) warm - for moments where the navigation is already
// certain or imminent: pointerdown on a row (fires ~100ms before the click
// completes, so the fetch races the route transition instead of starting
// after it) and the Today hero (the single most likely next open, also
// reachable via keyboard where hover never fires).
export function prefetchThreadDataNow(threadId: string): void {
  if (!threadId) return;
  warmApiGet(`/runner/data/thread/${threadId}`, { ttlMs: 5000 });
}

// Cancel the pending prefetch, but only when it belongs to `id`. Passing the
// leaving/blurring row's id stops one row's onMouseLeave/onBlur from cancelling
// a different row's still-pending (e.g. focus-scheduled) prefetch. Called with
// no id it cancels unconditionally (legacy behaviour).
export function cancelThreadPrefetch(id?: string): void {
  if (id && id !== pendingId) return;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pendingId = null;
}
