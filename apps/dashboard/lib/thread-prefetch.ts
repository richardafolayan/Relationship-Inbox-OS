"use client";

import { warmApiGet } from "@/lib/api";

// Hover/focus prefetch for inbox & today rows.
//
// Rows are <Link>s, so Next already prefetches the route's JS chunk on
// hover/in-viewport. What it never prefetches is the row's DATA, so the
// click always paid a cold /data/thread round-trip. This warms that exact
// endpoint into the shared apiGet cache (same path + default window the
// thread page reads) so the conversation paints instantly on click.
//
// A single module-level debounce timer is enough: only one row is hovered
// at a time, so a fast scroll past many rows only warms the one the cursor
// settles on. The 5s TTL means re-hovering the same row doesn't re-fetch.

let timer: ReturnType<typeof setTimeout> | null = null;

export function prefetchThreadData(threadId: string): void {
  if (!threadId) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    warmApiGet(`/runner/data/thread/${threadId}`, { ttlMs: 5000 });
  }, 80);
}

export function cancelThreadPrefetch(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
